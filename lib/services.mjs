/**
 * Everything that talks to the outside world: HTTP probes, the Vercel CLI/API,
 * and the Supabase platform.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const PROBE_TIMEOUT_MS = 8000;
const SLOW_MS = 1500;
const USER_AGENT = 'status-agent/0.1';
const SUPABASE_REF = /https:\/\/([a-z0-9]{20})\.supabase\.co/g;

const VERCEL_AUTH_FILES = [
  path.join(homedir(), 'Library', 'Application Support', 'com.vercel.cli', 'auth.json'),
  path.join(homedir(), '.local', 'share', 'com.vercel.cli', 'auth.json'),
  path.join(homedir(), '.vercel', 'auth.json'),
];

async function fetchJson(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { 'user-agent': USER_AGENT, ...(init.headers || {}) },
  });
  if (!response.ok) {
    let detail = '';
    try {
      const payload = await response.json();
      detail = payload?.error?.message || payload?.message || '';
    } catch {
      detail = '';
    }
    throw new Error(detail || `HTTP ${response.status}`);
  }
  return response.json();
}

export function resolveVercelToken(config) {
  if (config.vercel.token) return config.vercel.token;
  const candidates = config.vercel.tokenFile ? [config.vercel.tokenFile] : VERCEL_AUTH_FILES;
  for (const file of candidates) {
    try {
      if (!existsSync(file)) continue;
      const payload = JSON.parse(readFileSync(file, 'utf8'));
      if (payload && typeof payload.token === 'string' && payload.token) return payload.token;
    } catch {
      /* try the next location */
    }
  }
  return '';
}

/** Probe one web app and report the real HTTP status. */
export async function probeApp(app, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(app.url, {
      redirect: 'follow',
      cache: 'no-store',
      signal: controller.signal,
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,*/*' },
    });
    const ms = Math.round(performance.now() - started);
    const code = response.status;
    if (code >= 500) return { status: 'down', ms, code, error: `HTTP ${code}` };
    if (code >= 400) return { status: 'degraded', ms, code, error: `HTTP ${code}` };
    return { status: ms > SLOW_MS ? 'degraded' : 'operational', ms, code, error: '' };
  } catch (error) {
    const ms = Math.round(performance.now() - started);
    const timeout = error && error.name === 'AbortError';
    return { status: 'down', ms, code: null, error: timeout ? '请求超时' : '无法连接' };
  } finally {
    clearTimeout(timer);
  }
}

async function probeEndpoint(url) {
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      cache: 'no-store',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { 'user-agent': USER_AGENT },
    });
    return { status: response.status >= 500 ? 'down' : 'operational', code: response.status };
  } catch (error) {
    const timeout = error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return { status: timeout ? 'down' : 'down', code: null, error: timeout ? '超时' : '无法连接' };
  }
}

/**
 * Per-service health without any credentials: Kong answers on every route,
 * and the storage API exposes an unauthenticated status endpoint.
 * A paused project stops answering, so this doubles as a "is it paused" check.
 */
export async function probeSupabasePublic(ref) {
  const base = `https://${ref}.supabase.co`;
  const [storage, auth, rest, realtime] = await Promise.all([
    probeEndpoint(`${base}/storage/v1/status`),
    probeEndpoint(`${base}/auth/v1/health`),
    probeEndpoint(`${base}/rest/v1/`),
    probeEndpoint(`${base}/realtime/v1/`),
  ]);
  const reachable = (probe) => probe.code != null && probe.status !== 'down';
  return {
    ref,
    url: base,
    services: [
      { name: 'storage', status: storage.status === 'operational' ? 'operational' : 'down', error: storage.error || '' },
      { name: 'auth', status: reachable(auth) ? 'operational' : 'down', error: auth.error || '' },
      { name: 'rest', status: reachable(rest) ? 'operational' : 'down', error: rest.error || '' },
      { name: 'realtime', status: reachable(realtime) ? 'operational' : 'down', error: realtime.error || '' },
    ],
    storage: storage.status === 'operational' ? 'operational' : 'down',
    status: storage.status === 'operational' && reachable(auth) ? 'operational' : 'down',
  };
}

const SUPABASE_SERVICES = ['db', 'rest', 'storage', 'auth', 'realtime'];

/** Authoritative per-service health, requires a Supabase personal access token. */
export async function probeSupabaseServices(config, ref) {
  if (!config.supabase.token) return null;
  const url = new URL(`https://api.supabase.com/v1/projects/${encodeURIComponent(ref)}/health`);
  url.searchParams.set('services', SUPABASE_SERVICES.join(','));
  try {
    const payload = await fetchJson(url, { headers: { Authorization: `Bearer ${config.supabase.token}` } });
    const services = Array.isArray(payload) ? payload : [];
    return services.map((service) => ({
      name: String(service.name || service.service || ''),
      status: mapSupabaseStatus(service.status),
      error: service.error || '',
    }));
  } catch {
    return null;
  }
}

function mapSupabaseStatus(value) {
  switch (String(value || '').toLowerCase()) {
    case 'healthy':
    case 'active':
    case 'ready':
    case 'operational':
      return 'operational';
    case 'paused':
    case 'inactive':
      return 'paused';
    case 'unhealthy':
    case 'down':
    case 'error':
      return 'down';
    default:
      return 'unknown';
  }
}

/** Discover the Supabase project a deployed app talks to, from its JS bundles. */
export async function discoverSupabaseRef(appUrl, { maxBundles = 12 } = {}) {
  try {
    const response = await fetch(appUrl, {
      redirect: 'follow',
      cache: 'no-store',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS * 2),
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,*/*' },
    });
    if (!response.ok) return '';
    const html = await response.text();
    const found = new Set(matchRefs(html));
    const sources = [...html.matchAll(/(?:src|href)="([^"]+\.js)"/g)].map((match) => match[1]).slice(0, maxBundles);
    const origin = new URL(appUrl).origin;
    await Promise.all(
      sources.map(async (source) => {
        try {
          const bundleUrl = source.startsWith('http') ? source : new URL(source, origin).href;
          const bundle = await fetch(bundleUrl, {
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS * 2),
            headers: { 'user-agent': USER_AGENT },
          });
          if (!bundle.ok) return;
          for (const ref of matchRefs(await bundle.text())) found.add(ref);
        } catch {
          /* ignore a single broken asset */
        }
      })
    );
    return [...found][0] || '';
  } catch {
    return '';
  }
}

function matchRefs(text) {
  const refs = new Set();
  for (const match of text.matchAll(SUPABASE_REF)) refs.add(match[1]);
  return [...refs];
}

export async function discoverVercelApps(config) {
  const cli = config.vercel.cliPath || 'vercel';
  const args = ['project', 'ls', '--json'];
  if (config.vercel.scope) args.push('--scope', config.vercel.scope);
  try {
    const { stdout } = await exec(cli, args, {
      timeout: 45000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, PATH: `${path.join(homedir(), '.local', 'bin')}:${process.env.PATH || ''}` },
    });
    const start = stdout.indexOf('{');
    const payload = JSON.parse(start >= 0 ? stdout.slice(start) : stdout);
    return (payload.projects || []).map((project) => ({
      id: `vercel-${project.id}`,
      name: project.name,
      url: project.latestProductionUrl,
      vercelProjectId: project.id,
      updatedAt: project.updatedAt,
    }));
  } catch (error) {
    const message = error && error.message ? error.message : 'vercel CLI 调用失败';
    throw new Error(message.split('\n')[0]);
  }
}

export async function controlVercelProject(config, projectId, action) {
  const token = resolveVercelToken(config);
  if (!token) throw new Error('没有可用的 Vercel 登录态（vercel CLI 未登录，也未配置 token）');
  const url = new URL(
    `https://api.vercel.com/v1/projects/${encodeURIComponent(projectId)}/${action === 'stop' ? 'pause' : 'unpause'}`
  );
  if (config.vercel.teamId) url.searchParams.set('teamId', config.vercel.teamId);
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'user-agent': USER_AGENT },
  });
  if (!response.ok) {
    let detail = '';
    try {
      const payload = await response.json();
      detail = payload?.error?.message || '';
    } catch {
      detail = '';
    }
    throw new Error(detail || `HTTP ${response.status}`);
  }
  return action === 'stop' ? '已暂停' : '已恢复';
}

export async function controlSupabaseProject(config, ref, action) {
  if (!config.supabase.token) throw new Error('未配置 Supabase Personal Access Token，无法启停 Supabase 项目');
  const url = `https://api.supabase.com/v1/projects/${encodeURIComponent(ref)}/${action === 'stop' ? 'pause' : 'restore'}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.supabase.token}`, 'user-agent': USER_AGENT },
  });
  if (!response.ok) {
    let detail = '';
    try {
      const payload = await response.json();
      detail = payload?.message || payload?.error || '';
    } catch {
      detail = '';
    }
    throw new Error(detail || `HTTP ${response.status}`);
  }
  return action === 'stop' ? '已暂停' : '已恢复';
}
