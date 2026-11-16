// 通用输入补全：一个浮层服务所有带 data-suggest 的输入框。
//
// 为什么不用原生 <datalist>：这里要双语（英文 tag + 中文对照）、要分组、要右侧
// 附带计数/来源，而且多值字段（过滤表达式、负向词）只能「替换最后一个逗号段」。
// datalist 这三件都做不到，样式也完全不可控。
//
// 为什么浮层挂 body：所有浮层都长在 overflow:auto 的容器里（装配面板、抽卡侧栏、
// 表格滚动区），行内绝对定位一定会被裁。position:fixed + body 是项目里已验证的
// 做法（见 features/covers.js 的画师缩略图）。
//
// 接线只有三步：input 上写 data-suggest="<provider>"（多值字段再加
// data-suggest-append），app.js 的 input / keydown / change 委派会自动接管，
// 不需要给每个输入框单独绑事件。

import { api } from '../api.js';
import { cut, esc } from '../detail.js';
import { state } from '../store.js';
import { matchQuery, queryWords } from '../widgets.js';

const MAX = 12;
const DIR_KEY = 'gacha_dirs';

let box = null;        // 浮层本体（单例，挂 body）
let active = null;     // 当前正在补全的输入框
let cur = [];          // 当前候选
let idx = -1;          // 键盘高亮
let seq = 0;           // 请求序号：异步回来时若已换框/换词，直接丢弃
let timer = null;
let writing = false;   // 写回 value 时派发的 input 不能再触发一次查询

// ---------------- 候选来源 ----------------
// 每个 provider 收到 (q, input) 返回数组；返回的已过滤，上层不再二次过滤
// （双语候选的 value 是英文，用中文 q 再过滤一次会全被筛掉）。

/** 本地列表：按 q 过滤 value/hint/label，空格分词 AND，与快速筛选同一套语义。 */
function local(list, q, toItem) {
  const words = queryWords(q);
  const out = [];
  for (const x of list || []) {
    const it = toItem(x);
    if (!it || !it.value) continue;
    if (words.length && !matchQuery(`${it.value} ${it.label || ''} ${it.hint || ''}`, q)) continue;
    out.push(it);
    if (out.length >= MAX) break;
  }
  return out;
}

async function modelList(key) {
  if (!state.models || !Array.isArray(state.models[key]) || !state.models[key].length) {
    try { state.models = await api.get('/api/comfy/models'); } catch (_) { /* 离线：退回手填 */ }
  }
  return (state.models && state.models[key]) || [];
}

const modelItems = (list, hint) => list.map((v) => ({ value: v, hint }));

function dirs() {
  try {
    const list = JSON.parse(localStorage.getItem(DIR_KEY) || '[]');
    return Array.isArray(list) ? list.filter((x) => typeof x === 'string') : [];
  } catch (_) { return []; }
}

function rememberDir(v) {
  const val = String(v || '').trim();
  if (!val) return;
  const list = dirs().filter((x) => x !== val);
  list.unshift(val);
  try { localStorage.setItem(DIR_KEY, JSON.stringify(list.slice(0, 12))); } catch (_) { /* 隐私模式 */ }
}

/** 导入 / 扫描成功后由视图调用：手输的路径也该进候选，不能只有「点候选」才记。 */
export function noteDir(v) { rememberDir(v); }

// 负向词：内置常见项 + 用户自己预设里用过的，按出现次数排前面
const NEG_BASE = [
  'worst quality', 'low quality', 'normal quality', 'bad anatomy', 'bad hands',
  'extra digits', 'fewer digits', 'watermark', 'signature', 'username', 'text',
  'jpeg artifacts', 'blurry', 'lowres', 'deformed', 'mutated hands', 'bad feet',
];

function negItems(q) {
  const seen = new Map();
  for (const w of NEG_BASE) seen.set(w, 1);
  for (const p of state.profiles || []) {
    for (const w of String(p.negative || '').split(',').map((x) => x.trim()).filter(Boolean)) {
      seen.set(w, (seen.get(w) || 0) + 1);
    }
  }
  const list = [...seen.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([w, n]) => ({ value: w, hint: n > 1 ? `用过 ${n} 次` : '', group: '负向词' }));
  return local(list, q, (x) => x);
}

async function remoteTag(q, pool) {
  const p = new URLSearchParams({ q: q || '', limit: String(MAX) });
  if (pool) p.set('pool', pool);
  try {
    const d = await api.get('/api/pools/tag-suggest?' + p.toString());
    return (d.items || []).map((x) => ({
      value: x.value,
      hint: x.source === 'label' ? `${x.count} 条 · 条目名` : `${x.count} 条`,
    }));
  } catch (_) { return []; }
}

/** 过滤表达式 `池:tag` 的补全：冒号前当池/类别，冒号后查该池的 tag。 */
async function filterItems(q, t) {
  const last = String(t.value || '').split(',').pop() || '';
  const m = last.match(/^([^:：]+)[:：](.*)$/);
  if (m) {
    const pool = m[1].trim();
    const items = await remoteTag(m[2].trim(), pool);
    return items.map((x) => ({ ...x, value: `${pool}:${x.value}`, group: `池 ${pool}` }));
  }
  // 还没写冒号：先补类别，选中写成「角色:」并保持浮层打开，接着就能补 tag
  const kinds = [...new Set((state.pools || []).map((p) => p.kind).filter(Boolean))];
  return local(kinds, q, (k) => ({
    value: `${k}:`, label: `${k}:`, hint: '按类别筛', group: '类别', keepOpen: true,
  }));
}

const PROVIDERS = {
  profile: (q) => local(state.profiles, q, (p) => ({
    value: p.name, hint: p.checkpoint || '默认参数', group: '已有预设',
  })),
  recipe: (q) => local(state.recipes, q, (r) => ({
    value: r.name, hint: `${(r.slots || []).length} 个槽位`, group: '已有配方',
  })),
  pool: (q) => local(state.pools, q, (p) => ({ value: p.name, hint: p.kind })),
  concept: (q) => local(state.concepts && state.concepts.items, q, (c) => ({
    value: c.label || c.key, hint: c.kind,
  })),
  checkpoint: async (q) => local(await modelList('checkpoints'), q, (v) => ({ value: v, group: 'checkpoint' })),
  lora: async (q) => local(await modelList('loras'), q, (v) => ({ value: v, group: 'LoRA' })),
  clip: async (q) => local(await modelList('clip'), q, (v) => ({ value: v, group: '文本编码器' })),
  vae: async (q) => local(await modelList('vae'), q, (v) => ({ value: v, group: 'VAE' })),
  dir: (q) => local(dirs(), q, (v) => ({ value: v, hint: '用过的目录' })),
  neg: (q) => negItems(q),
  tag: async (q) => remoteTag(q, state.filterPool || ''),
  filter: filterItems,
  resolution: (q) => local(['1024×1360', '832×1216', '1216×832', '1536×864', '864×1536'],
    q, (v) => ({ value: v })),
};

// 选中后要记住的副作用（下次就能补出来）
const ON_PICK = { dir: rememberDir };

// ---------------- 查询与渲染 ----------------

function lastSegment(text) {
  const parts = String(text || '').split(',');
  return (parts[parts.length - 1] || '').trim();
}

async function query(kind, t) {
  if (active !== t) return;
  const my = ++seq;
  const fn = PROVIDERS[kind];
  if (!fn) { hide(); return; }
  const q = t.dataset.suggestAppend === undefined ? t.value : lastSegment(t.value);
  let items = [];
  try { items = (await fn(q, t)) || []; } catch (_) { items = []; }
  if (my !== seq || active !== t) return;     // 打字比请求快，旧结果作废
  cur = items.slice(0, MAX);
  idx = cur.length ? 0 : -1;
  paint(t);
}

function rowsHtml(items, at) {
  let html = '';
  let group = null;
  items.forEach((it, i) => {
    if (it.group && it.group !== group) {
      group = it.group;
      html += `<div class="suggest-group">${esc(group)}</div>`;
    }
    html += `<button type="button" class="suggest-item${i === at ? ' on' : ''}" data-i="${i}">
      <span class="suggest-val">${esc(cut(it.label || it.value, 60))}</span>
      ${it.hint ? `<span class="suggest-hint">${esc(cut(it.hint, 24))}</span>` : ''}
    </button>`;
  });
  return html;
}

function ensureBox() {
  if (box) return box;
  box = document.createElement('div');
  box.className = 'suggest-pop';
  box.hidden = true;
  // mousedown 而不是 click：click 前 input 会先 blur，浮层就没了
  box.addEventListener('mousedown', (e) => {
    const el = e.target.closest('.suggest-item');
    if (!el) return;
    e.preventDefault();
    const it = cur[Number(el.dataset.i)];
    if (it) apply(it);
  });
  document.body.appendChild(box);
  return box;
}

function paint(t) {
  if (!cur.length) { hide(); return; }
  const el = ensureBox();
  const r = t.getBoundingClientRect();
  el.style.left = `${Math.round(r.left)}px`;
  el.style.minWidth = `${Math.round(Math.max(r.width, 210))}px`;
  el.innerHTML = rowsHtml(cur, idx);
  el.hidden = false;
  // 默认贴在输入框下方；下面放不下就翻到上方，避免被视口裁掉
  const h = el.offsetHeight;
  const below = r.bottom + 4;
  el.style.top = `${Math.round(below + h > window.innerHeight - 8
    ? Math.max(8, r.top - h - 4) : below)}px`;
}

function hide() {
  if (box) box.hidden = true;
  cur = [];
  idx = -1;
}

/** 多值字段：只替换最后一个逗号段，前面的条件原样保留。 */
function buildValue(t, item) {
  const v = String(item.value || '');
  if (t.dataset.suggestAppend === undefined) return v;
  const parts = String(t.value || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (parts.length) parts.pop();
  parts.push(v);
  return parts.join(', ');
}

function apply(item) {
  const t = active;
  if (!t) return;
  writing = true;
  t.value = buildValue(t, item);
  // input 驱动 v-model / readDrawForm，change 驱动「选中即生效」的老逻辑
  t.dispatchEvent(new Event('input', { bubbles: true }));
  t.dispatchEvent(new Event('change', { bubbles: true }));
  writing = false;
  const hook = ON_PICK[t.dataset.suggest];
  if (hook) hook(t.value);
  if (item.keepOpen) {
    t.focus();
    const end = t.value.length;
    try { t.setSelectionRange(end, end); } catch (_) { /* number 类型没有选区 */ }
    query(t.dataset.suggest, t);
  } else {
    hide();
  }
}

// ---------------- 对外接口（app.js 委派调用） ----------------

export function suggestInput(t) {
  if (writing || !t.dataset.suggest) return;
  active = t;
  clearTimeout(timer);
  timer = setTimeout(() => query(t.dataset.suggest, t), 130);
}

/** 键盘：↑↓ 选、Enter 落、Esc 关。返回 true 表示已消费，调用方不要再处理。 */
export function suggestKey(t, e) {
  if (!box || box.hidden || active !== t) return false;
  const n = cur.length;
  if (!n) return false;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    idx = (idx + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
    paint(t);
    return true;
  }
  if (e.key === 'Enter') {
    if (idx < 0 || !cur[idx]) return false;
    e.preventDefault();
    apply(cur[idx]);
    return true;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    hide();
    return true;
  }
  return false;
}

/** 失焦 / change 收起。写回 value 时我们自己派发的 change 不能把浮层关掉。 */
export function suggestBlur() {
  if (writing) return;
  hide();
}

/** 视口一动就对不齐了，直接收起（与缩略图浮层同一策略）。由 boot 调用。 */
export function initSuggest() {
  window.addEventListener('scroll', () => { if (box && !box.hidden) hide(); }, true);
  window.addEventListener('resize', () => { if (box && !box.hidden) hide(); });
}
