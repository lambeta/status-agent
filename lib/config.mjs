import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const DEFAULT_CONFIG_PATH = path.join(homedir(), '.config', 'status-agent', 'config.json');

const text = (value) => (typeof value === 'string' ? value.trim() : '');

function positiveNumber(value, fallback, min) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.max(min, number);
}

export function normalizeApp(raw, index = 0) {
  const url = text(raw && raw.url).replace(/\/+$/, '');
  const name = text(raw && raw.name) || url || `app-${index + 1}`;
  return {
    id: text(raw && raw.id) || slug(name) || `app-${index + 1}`,
    name,
    url,
    vercelProjectId: text(raw && raw.vercelProjectId),
    supabaseRef: text(raw && raw.supabaseRef),
  };
}

export function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export function loadConfig(configPath) {
  const file = configPath || process.env.STATUS_AGENT_CONFIG || DEFAULT_CONFIG_PATH;
  if (!existsSync(file)) {
    throw new Error(`配置文件不存在：${file}（先从 config.example.json 复制一份）`);
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`配置文件不是合法 JSON：${file}（${error.message}）`);
  }
  const feishu = raw.feishu || {};
  const vercel = raw.vercel || {};
  const apps = Array.isArray(raw.apps) ? raw.apps : [];
  return {
    file,
    intervalMs: Number.isFinite(Number(raw.intervalMs)) ? Math.max(0, Number(raw.intervalMs)) : 0,
    report: { times: normalizeTimes(raw.report && raw.report.times) },
    http: {
      host: text(raw.http && raw.http.host) || '127.0.0.1',
      port: positiveNumber(raw.http && raw.http.port, 8787, 1),
    },
    vercel: {
      token: text(vercel.token),
      tokenFile: text(vercel.tokenFile),
      teamId: text(vercel.teamId),
      scope: text(vercel.scope),
      cliPath: text(vercel.cliPath) || 'vercel',
    },
    supabase: {
      token: text(raw.supabase && raw.supabase.token),
    },
    llm: {
      baseUrl: text(raw.llm && raw.llm.baseUrl),
      apiKey: text(raw.llm && raw.llm.apiKey),
      model: text(raw.llm && raw.llm.model) || 'deepseek-chat',
    },
    feishu: {
      larkCli: text(feishu.larkCli) || 'lark-cli',
      chatId: text(feishu.chatId),
      ownerOpenId: text(feishu.ownerOpenId),
      replyToThread: Boolean(feishu.replyToThread),
    },
    apps: apps.map(normalizeApp).filter((app) => app.url),
  };
}

export function normalizeTimes(value) {
  const list = Array.isArray(value) ? value : ['12:00', '18:00'];
  const times = list.map((item) => String(item).trim()).filter((item) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(item));
  return times.length ? times : ['12:00', '18:00'];
}

export function assertFeishuConfig(config) {
  if (!config.feishu.chatId || !config.feishu.ownerOpenId) {
    throw new Error('feishu.chatId 与 feishu.ownerOpenId 未配置，无法启用飞书命令');
  }
}
