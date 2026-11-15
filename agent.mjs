#!/usr/bin/env node
/**
 * status-agent
 * - serves a small status dashboard on http://127.0.0.1:8787/
 * - watches Vercel apps and the Supabase services they depend on
 * - answers commands in Feishu and pushes alerts when something changes
 */
import { loadConfig, assertFeishuConfig } from './lib/config.mjs';
import { createMonitor } from './lib/monitor.mjs';
import { startServer } from './lib/server.mjs';
import { consumeMessages, replyMessage, sendMessage } from './lib/feishu.mjs';
import { formatStatus } from './lib/commands.mjs';
import { createAgent } from './lib/agent.mjs';

const args = process.argv.slice(2);
const valueOf = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const has = (name) => args.includes(name);

const log = (...parts) => console.error(`[${new Date().toISOString()}]`, ...parts);

function loadOrExit() {
  try {
    return loadConfig(valueOf('--config'));
  } catch (error) {
    log(error.message);
    process.exit(1);
  }
}

const config = loadOrExit();
const monitor = createMonitor(config, { log });
const agent = createAgent(config, monitor, { log });

if (has('--check')) {
  const lines = [
    `配置文件：${config.file}`,
    `应用：${config.apps.length} 个`,
    `Vercel Token：${config.vercel.token ? '已配置' : '未配置'}`,
    `Supabase Token：${config.supabase.token ? '已配置' : '未配置'}`,
    `飞书命令：${config.feishu.chatId && config.feishu.ownerOpenId ? '已配置' : '未配置'}`,
    `看板：http://${config.http.host}:${config.http.port}/`,
  ];
  console.log(lines.join('\n'));
  process.exit(0);
}

if (has('--once')) {
  await monitor.check();
  console.log(formatStatus(monitor.snapshot()));
  process.exit(0);
}

const server = startServer(config, monitor, { log, agent });
let feishuStop = null;
let timer = null;
let stopping = false;

async function tick() {
  try {
    await monitor.check();
    await flushAlerts();
  } catch (error) {
    log(`检查失败：${error.message}`);
  }
  if (!stopping) timer = setTimeout(tick, config.intervalMs);
}

async function flushAlerts() {
  if (!feishuEnabled()) return;
  for (const alert of monitor.drainAlerts()) {
    if (alert.to === 'paused' || alert.from === 'unknown') continue;
    const text = alertText(alert);
    if (!text) continue;
    try {
      await sendMessage(config, text);
    } catch (error) {
      log(`发送告警失败：${error.message}`);
    }
  }
}

function alertText(alert) {
  const icon = alert.to === 'operational' ? '🟢' : alert.to === 'down' ? '🔴' : '⚠️';
  const from = label(alert.from);
  const to = label(alert.to);
  if (alert.to === 'operational' && alert.from === 'operational') return '';
  return `${icon} **${alert.name}** ${from} → ${to}${alert.type === 'supabase' ? ' · Supabase' : ''}`;
}

function label(status) {
  return { operational: '正常', degraded: '降级', down: '异常', paused: '暂停', unknown: '未知' }[status] || status;
}

function feishuEnabled() {
  return Boolean(config.feishu.chatId && config.feishu.ownerOpenId);
}

function startFeishu() {
  if (!feishuEnabled()) {
    log('未配置飞书 chatId/ownerOpenId，跳过命令通道');
    return;
  }
  try {
    assertFeishuConfig(config);
  } catch (error) {
    log(error.message);
    return;
  }

  const seen = new Set();
  const remember = (id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    if (seen.size > 500) seen.delete(seen.values().next().value);
    return true;
  };

  const context = {
    snapshot: monitor.snapshot(),
    refresh: async () => {
      await monitor.check();
      context.snapshot = monitor.snapshot();
      return context.snapshot;
    },
    controlApp: (app, action) => monitor.controlApp(app, action),
    controlSupabase: (project, action) => monitor.controlSupabase(project, action),
  };

  feishuStop = consumeMessages(
    config,
    async (event) => {
      if (event.sender_type !== 'user') return;
      if (event.sender_id !== config.feishu.ownerOpenId) return;
      if (event.chat_id !== config.feishu.chatId) return;
      if (event.message_type && !['text', 'post'].includes(event.message_type)) return;
      if (!event.message_id || !remember(event.message_id)) return;
      if (Date.now() - monitor.snapshot().checkedAt > 5000) await context.refresh();
      context.snapshot = monitor.snapshot();
      const reply = await agent.run(event.content || '');
      if (!reply) return;
      try {
        await replyMessage(config, event.message_id, reply);
      } catch (error) {
        log(`回复失败：${error.message}`);
      }
    },
    log
  );
  log('飞书命令通道已启动');
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`收到 ${signal}，正在退出`);
  clearTimeout(timer);
  if (feishuStop) feishuStop();
  server.close();
  setTimeout(() => process.exit(0), 200);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

tick();
startFeishu();
