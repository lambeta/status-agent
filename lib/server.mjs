import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function publicConfig(config) {
  return {
    configPath: config.file,
    intervalMs: config.intervalMs,
    hasVercelToken: Boolean(config.vercel.token),
    hasSupabaseToken: Boolean(config.supabase.token),
    feishuEnabled: Boolean(config.feishu.chatId && config.feishu.ownerOpenId),
    llmEnabled: Boolean(config.llm && config.llm.apiKey && config.llm.baseUrl),
  };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 100_000) {
        reject(new Error('payload too large'));
        request.destroy();
      }
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

export function startServer(config, monitor, { log = () => {}, agent = null } = {}) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

    try {
      if (url.pathname === '/api/status') {
        if (Date.now() - monitor.snapshot().checkedAt > Math.max(5000, config.intervalMs / 2)) {
          await monitor.check();
        }
        sendJson(response, 200, { ...monitor.snapshot(), config: publicConfig(config) });
        return;
      }

      if (url.pathname === '/api/chat' && request.method === 'POST') {
        if (!agent) {
          sendJson(response, 503, { ok: false, message: 'agent 未启动' });
          return;
        }
        const body = await readBody(request);
        let payload = {};
        try {
          payload = JSON.parse(body || '{}');
        } catch {
          sendJson(response, 400, { ok: false, message: '请求体不是 JSON' });
          return;
        }
        const reply = await agent.run(payload.text || '');
        sendJson(response, 200, { ok: true, reply });
        return;
      }

      if (url.pathname === '/api/refresh' && request.method === 'POST') {
        await monitor.check();
        sendJson(response, 200, { ok: true, ...monitor.snapshot(), config: publicConfig(config) });
        return;
      }

      const control = url.pathname.match(/^\/api\/(apps|supabase)\/([^/]+)\/(stop|start)$/);
      if (control && request.method === 'POST') {
        const [, scope, id, action] = control;
        try {
          const message =
            scope === 'apps'
              ? await monitor.controlApp(findApp(monitor.snapshot(), id), action)
              : await monitor.controlSupabase(findProject(monitor.snapshot(), id), action);
          await monitor.check();
          sendJson(response, 200, {
            ok: true,
            message,
            ...monitor.snapshot(),
            config: publicConfig(config),
          });
        } catch (error) {
          sendJson(response, 400, { ok: false, message: error.message });
        }
        return;
      }

      const relative = url.pathname === '/' ? '/index.html' : url.pathname;
      const file = path.join(PUBLIC_DIR, path.normalize(relative).replace(/^(\.\.[/\\])+/, ''));
      if (!file.startsWith(PUBLIC_DIR)) {
        sendJson(response, 403, { ok: false, message: 'forbidden' });
        return;
      }
      const body = await readFile(file);
      response.writeHead(200, {
        'content-type': MIME[path.extname(file)] || 'application/octet-stream',
        'cache-control': 'no-cache',
      });
      response.end(body);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        sendJson(response, 404, { ok: false, message: 'not found' });
      } else {
        log(`HTTP 请求失败：${error.message}`);
        sendJson(response, 500, { ok: false, message: error.message });
      }
    }
  });

  server.listen(config.http.port, config.http.host, () => {
    log(`看板：http://${config.http.host}:${config.http.port}/`);
  });
  return server;
}

function findApp(snapshot, id) {
  const app = snapshot.apps.find((item) => item.id === id);
  if (!app) throw new Error('应用不存在');
  return app;
}

function findProject(snapshot, ref) {
  const project = snapshot.supabase.find((item) => item.ref === ref);
  if (!project) throw new Error('Supabase 项目不存在');
  return project;
}
