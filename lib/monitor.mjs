import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import {
  controlSupabaseProject,
  controlVercelProject,
  discoverSupabaseRef,
  discoverVercelApps,
  probeApp,
  probeSupabasePublic,
  probeSupabaseServices,
} from './services.mjs';

const STATE_DIR = path.join(homedir(), '.local', 'state', 'status-agent');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const DISCOVERY_TTL_MS = 5 * 60 * 1000;

const SEVERITY = { unknown: 0, operational: 1, degraded: 2, paused: 3, down: 4 };

function worse(a, b) {
  return (SEVERITY[b] || 0) > (SEVERITY[a] || 0) ? b : a;
}

export function createMonitor(config, { log = () => {} } = {}) {
  const snapshot = {
    checkedAt: 0,
    apps: [],
    supabase: [],
    discovery: { vercel: 'off', message: '', updatedAt: 0 },
  };
  const previous = loadJson(STATE_FILE, { apps: [], supabase: [] });
  const refCache = loadJson(path.join(STATE_DIR, 'supabase-refs.json'), {});
  const alerts = [];
  let discovered = [];

  async function refreshDiscovery() {
    if (Date.now() - snapshot.discovery.updatedAt < DISCOVERY_TTL_MS && discovered.length) return;
    try {
      discovered = await discoverVercelApps(config);
      snapshot.discovery.vercel = 'ok';
      snapshot.discovery.message = '';
      snapshot.discovery.updatedAt = Date.now();
      log(`Vercel 项目：${discovered.length} 个`);
    } catch (error) {
      // Keep the previous list; only report when we have nothing at all.
      if (!discovered.length) {
        snapshot.discovery.vercel = 'error';
        snapshot.discovery.message = error.message;
        log(`Vercel 项目发现失败：${error.message}`);
      }
    }
  }

  function mergeApps() {
    const byUrl = new Map();
    for (const app of config.apps) byUrl.set(app.url, { ...app });
    for (const app of discovered) {
      if (!app.url) continue;
      if (byUrl.has(app.url)) {
        const existing = byUrl.get(app.url);
        byUrl.set(app.url, {
          ...app,
          ...existing,
          vercelProjectId: existing.vercelProjectId || app.vercelProjectId,
          supabaseRef: existing.supabaseRef || '',
        });
      } else {
        byUrl.set(app.url, { ...app, supabaseRef: '' });
      }
    }
    return [...byUrl.values()];
  }

  async function resolveSupabaseRef(app) {
    if (app.supabaseRef) return app.supabaseRef;
    if (refCache[app.url] !== undefined) return refCache[app.url];
    const ref = await discoverSupabaseRef(app.url);
    refCache[app.url] = ref;
    saveJson(path.join(STATE_DIR, 'supabase-refs.json'), refCache);
    if (ref) log(`${app.name} 依赖的 Supabase：${ref}`);
    return ref;
  }

  async function check() {
    await refreshDiscovery();
    const apps = mergeApps();
    const refs = new Map();
    for (const app of apps) {
      const ref = await resolveSupabaseRef(app);
      if (ref) refs.set(ref, app.name);
    }

    const supabase = [];
    for (const [ref, name] of refs) {
      const publicHealth = await probeSupabasePublic(ref);
      const services = config.supabase.token
        ? (await probeSupabaseServices(config, ref)) || publicHealth.services
        : publicHealth.services;
      const status = services.reduce((worst, service) => worse(worst, service.status), 'operational');
      supabase.push({
        ref,
        name,
        url: publicHealth.url,
        status,
        services,
        storage: services.find((service) => service.name === 'storage')?.status || status,
        error: publicHealth.error || '',
      });
    }

    const checkedAt = Date.now();
    const results = [];
    for (const app of apps) {
      const result = await probeApp(app);
      const linked = app.supabaseRef ? supabase.find((project) => project.ref === app.supabaseRef) : null;
      results.push({
        ...app,
        status: result.status,
        ms: result.ms,
        code: result.code,
        error: result.error,
        checkedAt,
        supabase: linked ? { ref: linked.ref, name: linked.name, storage: linked.storage, status: linked.status } : null,
        controllable: Boolean(app.vercelProjectId),
      });
    }

    const changes = diffStatuses(previous, { apps: results, supabase });
    snapshot.checkedAt = checkedAt;
    snapshot.apps = results;
    snapshot.supabase = supabase;
    for (const change of changes) alerts.push(change);
    saveJson(STATE_FILE, {
      apps: results.map((app) => ({ id: app.id, status: app.status })),
      supabase: supabase.map((project) => ({ ref: project.ref, status: project.status })),
    });
    return snapshot;
  }

  function diffStatuses(before, after) {
    const changes = [];
    const oldApps = new Map((before.apps || []).map((app) => [app.id, app.status]));
    for (const app of after.apps) {
      const old = oldApps.get(app.id);
      if (old && old !== app.status) {
        changes.push({ type: 'app', name: app.name, from: old, to: app.status });
      }
    }
    const oldProjects = new Map((before.supabase || []).map((project) => [project.ref, project.status]));
    for (const project of after.supabase) {
      const old = oldProjects.get(project.ref);
      if (old && old !== project.status) {
        changes.push({ type: 'supabase', name: project.name, from: old, to: project.status });
      }
    }
    return changes;
  }

  return {
    snapshot: () => snapshot,
    check,
    drainAlerts() {
      return alerts.splice(0, alerts.length);
    },
    async controlApp(app, action) {
      if (!app.vercelProjectId) throw new Error('这个应用没有 Vercel 项目 ID');
      return controlVercelProject(config, app.vercelProjectId, action);
    },
    async controlSupabase(project, action) {
      return controlSupabaseProject(config, project.ref, action);
    },
  };
}

function loadJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJson(file, data) {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(data, null, 2));
  } catch {
    /* best effort */
  }
}
