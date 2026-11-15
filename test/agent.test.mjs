import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { createAgent } from '../lib/agent.mjs';

const snapshot = {
  checkedAt: Date.now(),
  apps: [
    { id: 'teacher-ai', name: 'Teacher AI', url: 'https://www.qianyan.app', status: 'operational', ms: 120, code: 200, error: '', supabase: null },
    { id: 'meridian', name: 'Meridian', url: 'https://meridian.test', status: 'degraded', ms: 110, code: 404, error: 'HTTP 404', supabase: null },
  ],
  supabase: [
    { ref: 'ref1', name: 'Teacher AI', url: 'https://ref1.supabase.co', status: 'operational', storage: 'operational', services: [{ name: 'storage', status: 'operational' }] },
  ],
};

function fakeMonitor() {
  const controlled = [];
  return {
    controlled,
    snapshot: () => snapshot,
    check: async () => snapshot,
    controlApp: async (app, action) => {
      controlled.push([app.name, action]);
      return action === 'stop' ? '已暂停' : '已恢复';
    },
    controlSupabase: async (project, action) => {
      controlled.push([project.name, action]);
      return action === 'stop' ? '已暂停' : '已恢复';
    },
  };
}

function llmServer(responses) {
  let index = 0;
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        const payload = responses[Math.min(index, responses.length - 1)];
        index += 1;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: payload }] }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('uses no LLM and still answers commands', async () => {
  const agent = createAgent({ llm: {} }, fakeMonitor());
  assert.equal(agent.enabled, false);
  assert.match(await agent.run('状态'), /Teacher AI/);
});

test('runs the tool loop and returns the final answer', async () => {
  const server = await llmServer([
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'get_status', arguments: '{}' } },
      ],
    },
    { role: 'assistant', content: 'Teacher AI 正常，Meridian 返回 404。' },
  ]);
  const port = server.address().port;
  const monitor = fakeMonitor();
  const agent = createAgent({ llm: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'test', model: 'test' } }, monitor);
  try {
    const reply = await agent.run('现在状态怎么样？');
    assert.match(reply, /Meridian 返回 404/);
    assert.equal(monitor.controlled.length, 0);
  } finally {
    server.close();
  }
});

test('control tool really pauses the project', async () => {
  const server = await llmServer([
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'control_app', arguments: '{"name":"Meridian","action":"stop"}' } },
      ],
    },
    { role: 'assistant', content: '已经停掉 Meridian。' },
  ]);
  const port = server.address().port;
  const monitor = fakeMonitor();
  const agent = createAgent({ llm: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'test', model: 'test' } }, monitor);
  try {
    const reply = await agent.run('把 Meridian 停掉');
    assert.match(reply, /已经停掉 Meridian/);
    assert.deepEqual(monitor.controlled, [['Meridian', 'stop']]);
  } finally {
    server.close();
  }
});

test('falls back to commands when the LLM fails', async () => {
  const monitor = fakeMonitor();
  const agent = createAgent({ llm: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'test', model: 'test' } }, monitor);
  const reply = await agent.run('帮助');
  assert.match(reply, /我能做什么/);
});
