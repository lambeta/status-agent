import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { probeApp, resolveVercelToken } from '../lib/services.mjs';

function serve(routes) {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      const route = routes[new URL(request.url, 'http://localhost').pathname];
      if (!route) {
        response.writeHead(404).end('nope');
        return;
      }
      response.writeHead(route, { 'content-type': 'text/plain' }).end('ok');
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('classifies HTTP responses into status levels', async () => {
  const server = await serve({ '/ok': 200, '/missing': 404, '/broken': 500 });
  const port = server.address().port;
  try {
    const ok = await probeApp({ url: `http://127.0.0.1:${port}/ok` });
    assert.equal(ok.status, 'operational');
    assert.equal(ok.code, 200);
    assert.ok(ok.ms >= 0);

    const missing = await probeApp({ url: `http://127.0.0.1:${port}/missing` });
    assert.equal(missing.status, 'degraded');
    assert.equal(missing.code, 404);

    const broken = await probeApp({ url: `http://127.0.0.1:${port}/broken` });
    assert.equal(broken.status, 'down');
    assert.equal(broken.code, 500);
  } finally {
    server.close();
  }
});

test('reports an unreachable host as down', async () => {
  const result = await probeApp({ url: 'http://127.0.0.1:1/' }, { timeoutMs: 1000 });
  assert.equal(result.status, 'down');
  assert.equal(result.code, null);
});

test('reads a token from an explicit token file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'status-agent-'));
  const file = path.join(dir, 'auth.json');
  writeFileSync(file, JSON.stringify({ token: 'test-token' }));
  const config = { vercel: { token: '', tokenFile: file } };
  assert.equal(resolveVercelToken(config), 'test-token');
  assert.equal(resolveVercelToken({ vercel: { token: 'explicit' } }), 'explicit');
});
