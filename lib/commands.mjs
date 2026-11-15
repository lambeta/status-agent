const STATUS_ICON = {
  operational: '✅',
  degraded: '⚠️',
  down: '🔴',
  paused: '⏸',
  unknown: '⚪',
};

const STATUS_TEXT = {
  operational: '正常',
  degraded: '降级',
  down: '异常',
  paused: '已暂停',
  unknown: '未知',
};

export const EXPLAIN = [
  { match: /降级/, text: '「降级」表示服务还能访问，但有问题：通常是返回了 4xx（比如 404 DEPLOYMENT_NOT_FOUND），或者响应明显变慢。' },
  { match: /404|DEPLOYMENT_NOT_FOUND|部署不存在/i, text: '404 / DEPLOYMENT_NOT_FOUND 表示域名指向的 Vercel 部署已经不存在了——项目还在，但生产部署被删或从未 promote 到这个域名，需要重新部署或把域名指到新的生产部署。' },
  { match: /storage/, text: 'Supabase storage 是项目里的文件存储服务；我会用 /storage/v1/status 探测它，异常时单列出来。' },
];

const HELP = [
  '**我能做什么**',
  '· 「状态」看所有应用和 Supabase',
  '· 「停 <名字>」暂停应用或 Supabase 项目',
  '· 「启 <名字>」恢复应用或 Supabase 项目',
  '· 「应用」列出可操作的项目',
].join('\n');

export function stripMentions(text, mentions = []) {
  let out = String(text || '');
  for (const mention of mentions) {
    if (mention.key) out = out.split(mention.key).join(' ');
    if (mention.name) out = out.split(`@${mention.name}`).join(' ');
  }
  return out
    .replace(/@_user_\d+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeText(input) {
  return String(input || '')
    .replace(/@_user_\d+/g, ' ')
    .replace(/@_all/g, ' ')
    .replace(/\u2005/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\//, '');
}

export function parseCommand(input) {
  const text = normalizeText(input);
  if (!text) return { kind: 'empty' };
  const lower = text.toLowerCase();
  if (/^(帮助|help|commands|说明|\?|？)$/.test(lower)) return { kind: 'help' };
  if (/^(状态|status|怎么样|现在怎么样|查看|看看|report)$/.test(lower) || /^(状态|status)/.test(lower)) {
    return { kind: 'status' };
  }
  if (/^(应用|项目|apps|projects|列表|list)$/.test(lower)) return { kind: 'list' };
  let match = text.match(/^(?:把|将)\s*(.+?)\s*(?:停掉|暂停|停止|关掉|停了)$/);
  if (match) return { kind: 'stop', target: match[1].trim() };
  match = text.match(/^(?:把|将)\s*(.+?)\s*(?:启动|恢复|开起来|打开)$/);
  if (match) return { kind: 'start', target: match[1].trim() };
  match = text.match(/^(?:停止|暂停|停|stop|pause|disable)\s*[:：]?\s*(.+)$/i);
  if (match) return { kind: 'stop', target: match[1].trim() };
  match = text.match(/^(?:启动|恢复|启|start|resume|enable|unpause)\s*[:：]?\s*(.+)$/i);
  if (match) return { kind: 'start', target: match[1].trim() };
  if (/(状态|情况|怎么样|如何|还好吗|正常吗)/.test(text)) return { kind: 'status' };
  return { kind: 'unknown', text };
}

export function findApp(apps, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return { candidates: apps };
  const exact = apps.filter(
    (app) => app.id.toLowerCase() === needle || app.name.toLowerCase() === needle
  );
  if (exact.length === 1) return { app: exact[0] };
  const partial = apps.filter(
    (app) => app.name.toLowerCase().includes(needle) || app.id.toLowerCase().includes(needle)
  );
  if (partial.length === 1) return { app: partial[0] };
  return { candidates: partial.length ? partial : apps };
}

export function formatStatus(snapshot) {
  if (!snapshot || !snapshot.checkedAt) return '还没有探测结果，稍等几秒再发一次「状态」。';
  const lines = [`**运行状态** · ${clock(snapshot.checkedAt)}`];
  if (!snapshot.apps.length) {
    lines.push('还没有配置应用。编辑配置文件里的 `apps`，或配置 Vercel Token 自动发现项目。');
  }
  for (const app of snapshot.apps) {
    lines.push(appLine(app));
  }
  if (snapshot.supabase.length) {
    lines.push('');
    lines.push('**Supabase**');
    for (const project of snapshot.supabase) {
      lines.push(supabaseLine(project));
    }
  }
  return lines.join('\n');
}

function appLine(app) {
  const icon = STATUS_ICON[app.status] || STATUS_ICON.unknown;
  const text = STATUS_TEXT[app.status] || STATUS_TEXT.unknown;
  const latency = app.ms == null ? '' : ` · ${formatMs(app.ms)}`;
  const error = app.error ? `（${app.error}）` : '';
  return `${icon} ${app.name} · ${text}${latency}${error}`;
}

function supabaseLine(project) {
  const storage = project.services.find((service) => service.name === 'storage');
  const status = storage ? storage.status : project.status;
  const icon = STATUS_ICON[status] || STATUS_ICON.unknown;
  const text = STATUS_TEXT[status] || STATUS_TEXT.unknown;
  const broken = project.services
    .filter((service) => service.status !== 'operational' && service.name !== 'storage')
    .map((service) => `${service.name} ${STATUS_TEXT[service.status] || service.status}`);
  const detail = broken.length ? `（${broken.join('，')}）` : '';
  return `${icon} ${project.name} · storage ${text}${detail}`;
}

export function formatList(snapshot) {
  const apps = snapshot && snapshot.apps ? snapshot.apps : [];
  const projects = snapshot && snapshot.supabase ? snapshot.supabase : [];
  if (!apps.length && !projects.length) return '还没有可操作的项目。';
  const lines = ['**可操作项目**'];
  for (const app of apps) {
    const controllable = app.vercelProjectId ? '可启停' : '只监控';
    lines.push(`· ${app.name}（${controllable}）`);
  }
  for (const project of projects) {
    lines.push(`· ${project.name} · Supabase（可暂停/恢复）`);
  }
  return lines.join('\n');
}

export async function handleText(input, ctx) {
  const command = parseCommand(input);
  if (command.kind === 'empty') return null;
  if (command.kind === 'help') return HELP;
  const explained = EXPLAIN.find((item) => item.match.test(normalizeText(input)));
  if (explained) return explained.text;
  if (command.kind === 'status') return formatStatus(ctx.snapshot);
  if (command.kind === 'list') return formatList(ctx.snapshot);

  if (command.kind === 'stop' || command.kind === 'start') {
    return control(command, ctx);
  }

  return `没听懂「${command.text}」。发「帮助」看看我能做什么。`;
}

async function control(command, ctx) {
  const action = command.kind;
  const apps = (ctx.snapshot && ctx.snapshot.apps) || [];
  const projects = (ctx.snapshot && ctx.snapshot.supabase) || [];

  const appMatch = findApp(apps, command.target);
  if (appMatch.app) {
    const app = appMatch.app;
    if (!app.vercelProjectId) {
      return `「${app.name}」没有绑定 Vercel 项目 ID，改不了。把这个项目的 ID 填进配置即可启停。`;
    }
    try {
      const result = await ctx.controlApp(app, action);
      await ctx.refresh();
      return `${action === 'stop' ? '⏸' : '▶️'} ${app.name} ${result}`;
    } catch (error) {
      return `操作失败：${error.message}`;
    }
  }

  const projectMatch = findApp(projects, command.target);
  if (projectMatch.app) {
    try {
      const result = await ctx.controlSupabase(projectMatch.app, action);
      await ctx.refresh();
      return `${action === 'stop' ? '⏸' : '▶️'} ${projectMatch.app.name} ${result}`;
    } catch (error) {
      return `操作失败：${error.message}`;
    }
  }

  const candidates = [...apps, ...projects].slice(0, 8).map((item) => `· ${item.name}`).join('\n');
  return candidates ? `没找到「${command.target}」。可用的有：\n${candidates}` : '还没有可操作的项目。';
}

export function clock(ts) {
  const date = new Date(ts);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}

export function formatMs(ms) {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}
