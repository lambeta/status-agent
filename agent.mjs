#!/usr/bin/env node
/**
 * status-agent
 * - serves a small status dashboard on http://127.0.0.1:8787/
 * - watches Vercel apps and the Supabase services they depend on
 * - reports to Feishu at the configured times (default 12:00 and 18:00)
 * - answers commands in Feishu
 */
import { loadConfig, assertFeishuConfig } from './lib/config.mjs';
import { createMonitor } from './lib/monitor.mjs';
import { startServer } from './lib/server.mjs';
import { consumeMessages, replyMessage, sendMessage } from './lib/feishu.mjs';
import { formatStatus } from './lib/commands.mjs';
import { createAgent } from './lib/agent.mjs';
import { createReporter } from './lib/schedule.mjs';

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
    `Vercel Token：${config.vercel.token ? '已配置' : '使用 CLI 登录态'}`,
    `Supabase Token：${config.supabase.token ? '已配置' : '未配置'}`,
    `飞书命令：${config.feishu.chatId && config.feishu.ownerOpenId ? '已配置' : '未配置'}`,
    `汇报时间：${config.report.times.join(' / ')}`,
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
let intervalTimer = null;
let reporter = null;
let stopping = false;

function feishuEnabled() {
  return Boolean(config.feishu.chatId && config.feishu.ownerOpenId);
}

async function sendDailyReport() {
  await monitor.check();
  const snapshot = monitor.snapshot();
  const text = `**每日汇报** · ${new Date().toLocaleString('zh-CN', { hour12: false })}\n\n${formatStatus(snapshot)}`;
  if (!feishuEnabled()) {
    log(`未配置飞书，汇报内容：\n${text}`);
    return;
  }
  try {
    await sendMessage(config, text);
    log('每日汇报已发送');
  } catch (error) {
    log(`发送汇报失败：${error.message}`);
  }
}

async function periodicTick() {
  try {
    await monitor.check();
    for (const alert of monitor.drainAlerts()) {
      if (!feishuEnabled() || alert.from === 'unknown' || alert.to === 'paused') continue;
      await sendMessage(config, alertText(alert)).catch((error) => log(`发送告警失败：${error.message}`));
    }
  } catch (error) {
    log(`检查失败：${error.message}`);
  }
  if (!stopping) intervalTimer = setTimeout(periodicTick, config.intervalMs);
}

function alertText(alert) {
  const icon = alert.to === 'operational' ? '🟢' : alert.to === 'down' ? '🔴' : '⚠️';
  const label = { operational: '正常', degraded: '降级', down: '异常', paused: '暂停', unknown: '未知' };
  return `${icon} **${alert.name}** ${label[alert.from] || alert.from} → ${label[alert.to] || alert.to}`;
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

  feishuStop = consumeMessages(
    config,
    async (event) => {
      if (event.sender_type !== 'user') return;
      if (event.sender_id !== config.feishu.ownerOpenId) return;
      if (event.chat_id !== config.feishu.chatId) return;
      if (event.message_type && !['text', 'post'].includes(event.message_type)) return;
      if (!event.message_id || !remember(event.message_id)) return;
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
  clearTimeout(intervalTimer);
  if (reporter) reporter.stop();
  if (feishuStop) feishuStop();
  server.close();
  setTimeout(() => process.exit(0), 200);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

async function main() {
  await monitor.check();
  log(`基线检查完成：${monitor.snapshot().apps.length} 个应用`);
  startFeishu();

  // Real-time polling is opt-in; the default is scheduled reports only.
  if (config.intervalMs > 0) {
    log(`实时探测已启用：每 ${Math.round(config.intervalMs / 1000)} 秒`);
    periodicTick();
  } else {
    log('实时探测已关闭，仅按计划汇报');
  }

  reporter = createReporter({ times: config.report.times, onReport: sendDailyReport, log });
}

main().catch((error) => {
  log(`启动失败：${error.message}`);
  process.exit(1);
});
