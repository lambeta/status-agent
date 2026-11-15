const $ = (selector, root = document) => root.querySelector(selector);

const STATUS_TEXT = {
  operational: '正常',
  degraded: '降级',
  down: '异常',
  paused: '已暂停',
  unknown: '未知',
};

const SEVERITY = { unknown: 0, operational: 1, degraded: 2, paused: 3, down: 4 };

const ICON = { operational: '✅', degraded: '⚠️', down: '🔴', paused: '⏸', unknown: '⚪' };

let snapshot = null;
let loading = false;

function h(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

const pad = (n) => String(n).padStart(2, '0');

function clock(ts) {
  if (!ts) return '—';
  const date = new Date(ts);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function duration(ms) {
  if (ms == null) return '—';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function worst(a, b) {
  return (SEVERITY[b] || 0) > (SEVERITY[a] || 0) ? b : a;
}

function overall() {
  if (!snapshot) return 'unknown';
  let status = 'operational';
  for (const app of snapshot.apps || []) status = worst(status, app.status);
  for (const project of snapshot.supabase || []) status = worst(status, project.status);
  return (snapshot.apps || []).length || (snapshot.supabase || []).length ? status : 'unknown';
}

let toastTimer = null;

function toast(message, level = 'info') {
  const node = $('#toast');
  node.textContent = message;
  node.dataset.level = level;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 4000);
}

async function load() {
  if (loading) return;
  loading = true;
  try {
    const response = await fetch('/api/status', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    snapshot = await response.json();
    render();
  } catch (error) {
    $('#live').dataset.state = 'offline';
    $('#liveText').textContent = '连接失败';
    toast(`读取状态失败：${error.message}`, 'error');
  } finally {
    loading = false;
  }
}

function render() {
  renderHero();
  renderApps();
  renderSupabase();
  $('#live').dataset.state = 'ok';
  const times = snapshot && snapshot.config && snapshot.config.reportTimes;
  $('#liveText').textContent = times && times.length ? `每日 ${times.join(' / ')} 汇报` : '按计划汇报';
  if (snapshot && snapshot.config) {
    const parts = [`配置：${snapshot.config.configPath}`];
    parts.push(`Vercel ${snapshot.config.hasVercelToken ? '✓' : '（用 CLI 登录态）'}`);
    parts.push(`Supabase ${snapshot.config.hasSupabaseToken ? '✓' : '仅公开探测'}`);
    parts.push(`飞书命令 ${snapshot.config.feishuEnabled ? '✓' : '未配置'}`);
    $('#configLine').textContent = parts.join(' · ');
  }
}

function renderHero() {
  const status = overall();
  const hero = $('#hero');
  hero.dataset.status = status;
  const apps = (snapshot && snapshot.apps) || [];
  const projects = (snapshot && snapshot.supabase) || [];
  const appsUp = apps.filter((app) => app.status === 'operational').length;
  const storageOk = projects.filter((project) => project.storage === 'operational').length;

  const headline = {
    operational: '全部正常',
    degraded: '部分项目降级',
    down: '检测到异常',
    paused: '有项目已暂停',
    unknown: '正在检查…',
  }[status];
  $('#headline').textContent = headline;
  $('#subline').textContent = apps.length
    ? `${apps.length} 个应用 · ${projects.length} 个 Supabase 项目 · 最近一次检查 ${clock(snapshot.checkedAt)}`
    : '还没有可监控的应用';
  $('#statApps').textContent = `${appsUp}/${apps.length}`;
  $('#statSupabase').textContent = `${storageOk}/${projects.length}`;
  $('#statChecked').textContent = clock(snapshot && snapshot.checkedAt);
}

function renderApps() {
  const grid = $('#apps');
  const apps = (snapshot && snapshot.apps) || [];
  grid.replaceChildren(...apps.map(appCard));
  $('#appsEmpty').hidden = apps.length > 0;
}

function appCard(app) {
  const status = app.status || 'unknown';
  const controllable = Boolean(app.controllable);
  const button = h(
    'button',
    {
      class: `btn btn-sm ${status === 'paused' ? 'btn-ok' : 'btn-danger'}`,
      type: 'button',
      onclick: () => control('apps', app.id, status === 'paused' ? 'start' : 'stop', button),
    },
    status === 'paused' ? '启动' : '停止'
  );
  if (!controllable) button.disabled = true;

  const linked = app.supabase
    ? h(
        'span',
        { class: 'chip', dataset: { status: app.supabase.storage } },
        h('span', { class: 'dot', 'aria-hidden': 'true' }),
        'Supabase storage ',
        STATUS_TEXT[app.supabase.storage] || '未知'
      )
    : null;

  return h(
    'article',
    { class: 'card', dataset: { status } },
    h(
      'div',
      { class: 'card-head' },
      h('span', { class: 'dot', 'aria-hidden': 'true' }),
      h(
        'div',
        { class: 'card-title' },
        h('h3', null, app.name),
        h('p', { class: 'card-url' }, app.url)
      ),
      h('span', { class: 'pill' }, STATUS_TEXT[status] || '未知')
    ),
    h(
      'div',
      { class: 'metrics' },
      h('span', null, 'HTTP ', h('b', null, app.code == null ? '—' : app.code)),
      h('span', null, '延迟 ', h('b', null, duration(app.ms))),
      app.error && app.error !== `HTTP ${app.code}` ? h('span', { class: 'error' }, app.error) : null,
      linked
    ),
    h(
      'div',
      { class: 'card-foot' },
      h('span', { class: 'updated' }, `检查于 ${clock(app.checkedAt)}`),
      h(
        'div',
        { class: 'actions' },
        h('a', { class: 'btn btn-sm', href: app.url, target: '_blank', rel: 'noreferrer noopener' }, '打开'),
        button
      )
    )
  );
}

function renderSupabase() {
  const grid = $('#supabase');
  const projects = (snapshot && snapshot.supabase) || [];
  grid.replaceChildren(...projects.map(supabaseCard));
  $('#supabaseEmpty').hidden = projects.length > 0;
}

function supabaseCard(project) {
  const status = project.status || 'unknown';
  const pause = h(
    'button',
    {
      class: `btn btn-sm ${status === 'paused' ? 'btn-ok' : 'btn-danger'}`,
      type: 'button',
      onclick: () => control('supabase', project.ref, status === 'paused' ? 'start' : 'stop', pause),
    },
    status === 'paused' ? '恢复' : '暂停'
  );
  const services = (project.services || []).map((service) =>
    h(
      'span',
      { class: 'chip', dataset: { status: service.status } },
      h('span', { class: 'dot', 'aria-hidden': 'true' }),
      `${service.name} ${STATUS_TEXT[service.status] || '未知'}`
    )
  );

  return h(
    'article',
    { class: 'card', dataset: { status } },
    h(
      'div',
      { class: 'card-head' },
      h('span', { class: 'dot', 'aria-hidden': 'true' }),
      h(
        'div',
        { class: 'card-title' },
        h('h3', null, project.name),
        h('p', { class: 'card-url' }, project.url)
      ),
      h('span', { class: 'pill' }, `storage ${STATUS_TEXT[project.storage] || '未知'}`)
    ),
    h('div', { class: 'services' }, services),
    h(
      'div',
      { class: 'card-foot' },
      h('span', { class: 'updated' }, `检查于 ${clock(snapshot.checkedAt)}`),
      h('div', { class: 'actions' }, h('a', { class: 'btn btn-sm', href: project.url, target: '_blank', rel: 'noreferrer noopener' }, '打开'), pause)
    )
  );
}

async function control(scope, id, action, button) {
  if (!window.confirm(action === 'stop' ? '确定要停止吗？' : '确定要启动吗？')) return;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = '处理中…';
  try {
    const response = await fetch(`/api/${scope}/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
    const payload = await response.json();
    if (!response.ok || payload.ok === false) throw new Error(payload.message || `HTTP ${response.status}`);
    snapshot = payload;
    render();
    toast(action === 'stop' ? '已停止' : '已启动');
  } catch (error) {
    toast(`操作失败：${error.message}`, 'error');
    button.disabled = false;
    button.textContent = original;
  }
}

function formatReply(text) {
  const escaped = String(text).replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]);
  return escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

function appendMessage(role, text, extraClass = '') {
  const log = $('#chatLog');
  const item = h('li', { class: `msg ${role} ${extraClass}`.trim() }, text);
  log.append(item);
  log.scrollTop = log.scrollHeight;
  return item;
}

async function sendChat(event) {
  event.preventDefault();
  const input = $('#chatInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  appendMessage('user', text);
  const pending = appendMessage('agent', '思考中…', 'pending');
  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || `HTTP ${response.status}`);
    pending.innerHTML = formatReply(payload.reply || '（没有回复）');
    pending.classList.remove('pending');
    if (payload.reply) setTimeout(load, 400);
  } catch (error) {
    pending.classList.remove('pending');
    pending.classList.add('error');
    pending.textContent = `出错了：${error.message}`;
  }
}

async function refresh() {
  const button = $('#refresh');
  button.disabled = true;
  button.textContent = '检查中…';
  try {
    const response = await fetch('/api/refresh', { method: 'POST' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || `HTTP ${response.status}`);
    snapshot = payload;
    render();
  } catch (error) {
    toast(`刷新失败：${error.message}`, 'error');
  } finally {
    button.disabled = false;
    button.textContent = '立即检查';
  }
}

function start() {
  load();
}

$('#refresh').addEventListener('click', refresh);
$('#chatForm').addEventListener('submit', sendChat);
start();
