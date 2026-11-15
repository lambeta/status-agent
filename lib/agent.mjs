/**
 * The agent brain.
 *
 * A small tool-using loop on top of any OpenAI-compatible chat completions
 * endpoint. When no endpoint is configured it degrades to the deterministic
 * command parser, so the project always works.
 */
import { formatList, formatStatus, handleText } from './commands.mjs';

const MAX_STEPS = 6;
const HISTORY_LIMIT = 12;

const SYSTEM_PROMPT = `你是「运行状态 Agent」，负责用户部署在 Vercel 上的应用，以及它们依赖的 Supabase 服务。

规则：
- 先看清楚用户要什么，再选择工具；状态类问题必须用工具取真实数据，绝不编造数字。
- 只回答用户关心的：应用状态、Supabase（尤其 storage）状态、异常与启停结果。不要主动扩展话题。
- 需要启停时先确认对象，执行后复核结果。
- 回答中文、简短：先给结论，再给关键细节；有异常就指出下一步。
- 工具失败时如实说明，不要假装成功。`;

export function createAgent(config, monitor, { log = () => {} } = {}) {
  const history = [];
  const llm = config.llm || {};
  const enabled = Boolean(llm.apiKey && llm.baseUrl);
  const ctx = () => ({
    snapshot: monitor.snapshot(),
    refresh: async () => {
      await monitor.check();
      return monitor.snapshot();
    },
    controlApp: (app, action) => monitor.controlApp(app, action),
    controlSupabase: (project, action) => monitor.controlSupabase(project, action),
  });

  const tools = [
    {
      type: 'function',
      function: {
        name: 'get_status',
        description: '获取所有应用与 Supabase 项目的当前状态（状态、HTTP 码、延迟、storage 健康）。',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'refresh_status',
        description: '立刻重新探测一遍所有应用与 Supabase，返回最新状态。',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'control_app',
        description: '暂停或恢复一个 Vercel 应用（按名字匹配）。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '应用名称，例如 Teacher AI' },
            action: { type: 'string', enum: ['stop', 'start'], description: 'stop 暂停，start 恢复' },
          },
          required: ['name', 'action'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'control_supabase',
        description: '暂停或恢复一个 Supabase 项目（按名字匹配）。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Supabase 项目名称' },
            action: { type: 'string', enum: ['stop', 'start'], description: 'stop 暂停，start 恢复' },
          },
          required: ['name', 'action'],
        },
      },
    },
  ];

  async function runTool(name, args) {
    const text = ctx();
    if (name === 'get_status') return compactStatus(text.snapshot);
    if (name === 'refresh_status') return compactStatus(await text.refresh());
    if (name === 'control_app') {
      const { app, candidates } = findByName(text.snapshot.apps, args.name);
      if (!app) return { ok: false, message: `没找到应用「${args.name}」`, candidates: candidates.map((item) => item.name) };
      try {
        const message = await text.controlApp(app, args.action);
        const snapshot = await text.refresh();
        return { ok: true, message: `${app.name} ${message}`, status: snapshot.apps.find((item) => item.id === app.id)?.status };
      } catch (error) {
        return { ok: false, message: error.message };
      }
    }
    if (name === 'control_supabase') {
      const { app, candidates } = findByName(text.snapshot.supabase, args.name);
      if (!app) return { ok: false, message: `没找到 Supabase 项目「${args.name}」`, candidates: candidates.map((item) => item.name) };
      try {
        const message = await text.controlSupabase(app, args.action);
        await text.refresh();
        return { ok: true, message: `${app.name} ${message}` };
      } catch (error) {
        return { ok: false, message: error.message };
      }
    }
    return { ok: false, message: `未知工具 ${name}` };
  }

  async function run(input) {
    const text = String(input || '').trim();
    if (!text) return '';
    if (!enabled) return fallback(text);

    history.push({ role: 'user', content: text });
    if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);

    try {
      const reply = await loop(text);
      if (reply) {
        history.push({ role: 'assistant', content: reply });
        return reply;
      }
      return fallback(text);
    } catch (error) {
      log(`LLM 调用失败，退回命令解析：${error.message}`);
      return fallback(text);
    }
  }

  async function loop() {
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'system', content: `当前快照：${JSON.stringify(compactStatus(monitor.snapshot()))}` },
      ...history,
    ];

    for (let step = 0; step < MAX_STEPS; step += 1) {
      const response = await fetch(`${llm.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${llm.apiKey}`,
        },
        body: JSON.stringify({
          model: llm.model || 'deepseek-chat',
          temperature: 0.2,
          tools,
          tool_choice: 'auto',
          messages,
        }),
        signal: AbortSignal.timeout(60000),
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`HTTP ${response.status} ${body.slice(0, 200)}`);
      }
      const payload = await response.json();
      const message = payload.choices && payload.choices[0] && payload.choices[0].message;
      if (!message) throw new Error('LLM 返回为空');
      messages.push(message);

      const toolCalls = message.tool_calls || [];
      if (!toolCalls.length) return String(message.content || '').trim();

      for (const call of toolCalls) {
        let args = {};
        try {
          args = JSON.parse(call.function.arguments || '{}');
        } catch {
          args = {};
        }
        const result = await runTool(call.function.name, args);
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
    }
    return '';
  }

  function fallback(text) {
    return handleText(text, ctx());
  }

  return { run, enabled };
}

function compactStatus(snapshot) {
  return {
    checkedAt: snapshot.checkedAt,
    apps: snapshot.apps.map((app) => ({
      name: app.name,
      url: app.url,
      status: app.status,
      http: app.code,
      latencyMs: app.ms,
      error: app.error || undefined,
      supabaseStorage: app.supabase ? app.supabase.storage : undefined,
    })),
    supabase: snapshot.supabase.map((project) => ({
      name: project.name,
      ref: project.ref,
      status: project.status,
      storage: project.storage,
      services: project.services.map((service) => `${service.name}:${service.status}`),
    })),
  };
}

function findByName(items, name) {
  const needle = String(name || '').trim().toLowerCase();
  const exact = items.filter((item) => item.name.toLowerCase() === needle);
  if (exact.length === 1) return { app: exact[0], candidates: [] };
  const partial = items.filter((item) => item.name.toLowerCase().includes(needle));
  if (partial.length === 1) return { app: partial[0], candidates: [] };
  return { app: null, candidates: partial.length ? partial : items };
}

export { formatList, formatStatus };
