import test from 'node:test';
import assert from 'node:assert/strict';

import { findApp, formatList, formatStatus, handleText, parseCommand } from '../lib/commands.mjs';

const snapshot = {
  checkedAt: Date.now(),
  apps: [
    { id: 'teacher-ai', name: 'Teacher AI', url: 'https://www.qianyan.app', status: 'operational', ms: 120, code: 200, error: '', vercelProjectId: 'prj_test' },
    { id: 'meridian', name: 'Meridian', url: 'https://meridian-evals.qianyan.app', status: 'degraded', ms: 110, code: 404, error: 'HTTP 404' },
  ],
  supabase: [
    {
      ref: 'gnqkasqcvsjirfkgdudj',
      name: 'Teacher AI',
      status: 'operational',
      storage: 'operational',
      services: [
        { name: 'storage', status: 'operational' },
        { name: 'auth', status: 'operational' },
        { name: 'db', status: 'degraded' },
      ],
    },
  ],
};

test('parses the Chinese and English commands', () => {
  assert.deepEqual(parseCommand('状态'), { kind: 'status' });
  assert.deepEqual(parseCommand('/status'), { kind: 'status' });
  assert.deepEqual(parseCommand('停 Teacher AI'), { kind: 'stop', target: 'Teacher AI' });
  assert.deepEqual(parseCommand('暂停 meridian'), { kind: 'stop', target: 'meridian' });
  assert.deepEqual(parseCommand('启动 Teacher AI'), { kind: 'start', target: 'Teacher AI' });
  assert.deepEqual(parseCommand('帮助'), { kind: 'help' });
  assert.deepEqual(parseCommand('应用'), { kind: 'list' });
  assert.equal(parseCommand('随便说点什么').kind, 'unknown');
});

test('strips mention placeholders', () => {
  assert.deepEqual(parseCommand('@_user_1 状态'), { kind: 'status' });
});

test('matches apps by id or name, exactly or partially', () => {
  const apps = snapshot.apps;
  assert.equal(findApp(apps, 'teacher-ai').app.id, 'teacher-ai');
  assert.equal(findApp(apps, 'Teacher AI').app.id, 'teacher-ai');
  assert.equal(findApp(apps, 'teacher').app.id, 'teacher-ai');
  assert.ok(findApp(apps, 'nothing').candidates);
});

test('formats a status snapshot with apps and Supabase', () => {
  const text = formatStatus(snapshot);
  assert.match(text, /Teacher AI · 正常 · 120 ms/);
  assert.match(text, /Meridian · 降级/);
  assert.match(text, /storage 正常/);
});

test('formats the controllable list', () => {
  const text = formatList({ apps: [{ name: 'A', vercelProjectId: 'prj_1' }, { name: 'B' }], supabase: [{ name: 'S' }] });
  assert.match(text, /A（可启停）/);
  assert.match(text, /B（只监控）/);
  assert.match(text, /S · Supabase/);
});

test('replies to people and never to empty input', async () => {
  const ctx = { snapshot };
  assert.equal(await handleText('', ctx), null);
  assert.match(await handleText('帮助', ctx), /我能做什么/);
  assert.match(await handleText('状态', ctx), /Teacher AI/);
  assert.match(await handleText('飞一下', ctx), /没听懂/);
});

test('refuses to control an app without a Vercel project id', async () => {
  const ctx = { snapshot: { apps: [{ id: 'x', name: 'X', url: 'https://x.test', status: 'operational' }], supabase: [] } };
  const reply = await handleText('停 X', ctx);
  assert.match(reply, /没有绑定 Vercel 项目 ID/);
});

test('executes a control command and refreshes', async () => {
  const calls = [];
  const ctx = {
    snapshot,
    refresh: async () => {},
    controlApp: async (app, action) => {
      calls.push([app.id, action]);
      return action === 'stop' ? '已暂停' : '已恢复';
    },
  };
  assert.match(await handleText('停 Teacher AI', ctx), /已暂停/);
  assert.match(await handleText('启 Teacher AI', ctx), /已恢复/);
  assert.deepEqual(calls, [['teacher-ai', 'stop'], ['teacher-ai', 'start']]);
});

test('understands natural phrasing in the fallback parser', () => {
  assert.deepEqual(parseCommand('Teacher AI 现在怎么样？'), { kind: 'status' });
  assert.deepEqual(parseCommand('把 Meridian 停掉'), { kind: 'stop', target: 'Meridian' });
  assert.deepEqual(parseCommand('将 Teacher AI 恢复'), { kind: 'start', target: 'Teacher AI' });
});
