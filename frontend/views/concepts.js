import { api, friendlyError } from '../api.js';
import { esc } from '../detail.js';
import { state } from '../store.js';
import { addFilter, conceptCardsHtml, conceptDetailHtml, conceptKindChipsHtml, parseFilterSpec, semanticCardsHtml } from '../widgets.js';
import { $, done, view } from '../core/ui.js';
import { setFilterSpec } from '../features/filter.js';

// 概念墙 / 语义找画师 / 概念详情页（#/concept/<key>）。
// 概念墙完全由数据库驱动，不依赖语义索引 / 外部项目 / 任何 AI 服务。

let conceptTimer = null;

export function semanticHintHtml() {
  const s = state.semantics;
  if (s.ready === false) {
    return `<div class="hint">语义索引未就绪（${esc(s.reason || '尚未构建')}）· 下方数据库概念墙不受影响</div>`;
  }
  return '';
}

export function syncConceptPanel() {
  const selectedKeys = parseFilterSpec(state.form.filter).map((r) => r.tag.toLowerCase());
  const wall = $('#conceptWall');
  if (wall) wall.innerHTML = conceptCardsHtml(state.concepts.items.slice(0, 12), { selectedKeys });
  const kinds = $('#conceptKinds');
  if (kinds) kinds.innerHTML = conceptKindChipsHtml(state.concepts.kinds, state.concepts.kind);
  const sem = $('#semanticCards');
  if (sem) sem.innerHTML = semanticCardsHtml(state.semantics.items);
  const hint = $('#semanticHint');
  if (hint) hint.innerHTML = semanticHintHtml();
}

/** 概念墙完全由数据库驱动，不依赖语义索引 / 外部项目 / 任何 AI 服务。
 *  列表只取文字与计数，一张图都不铺；封面在 hover / focus 时按需请求。 */
export async function loadConcepts() {
  const p = new URLSearchParams({ limit: '60' });
  if (state.concepts.kind) p.set('kind', state.concepts.kind);
  if (state.concepts.q) p.set('q', state.concepts.q);
  try {
    const d = await api.get('/api/concepts/wall?' + p.toString());
    state.concepts.items = d.items || [];
    state.concepts.kinds = d.kinds || [];
    state.concepts.image_count = d.image_count || 0;
    state.concepts.loaded = true;
    state.conceptThumbMap = {};
    syncConceptPanel();
  } catch (_) { /* 概念墙是增强能力，失败不阻塞抽卡主流程 */ }
}

// ---------------- 概念详情页：#/concept/<key>，首屏最多 50 张 ----------------
export async function renderConceptPage(key) {
  const d = await api.get('/api/concepts/images?'
    + new URLSearchParams({ key, limit: '50', offset: '0' }).toString());
  state.conceptPage = {
    key, label: d.label || key, kind: d.kind || '', pool: d.pool || '',
    items: d.items || [], total: Number(d.total || 0), offset: 0,
  };
  view.innerHTML = conceptDetailHtml(state.conceptPage);
}

export async function loadSemantics(q = '') {
  state.semantics.q = q;
  try {
    const d = await api.get('/api/semantics/suggest?'
      + new URLSearchParams({ q, top_k: '12' }).toString());
    state.semantics.items = d.items || [];
    state.semantics.mode = d.mode || '';
    state.semantics.ready = true;
  } catch (err) {
    state.semantics.items = [];
    state.semantics.ready = false;
    state.semantics.reason = friendlyError(err);
  }
  syncConceptPanel();   // 只更新面板，不重绘整页，避免打断表单输入
}

export async function loadSemanticsStatus() {
  try {
    const d = await api.get('/api/semantics/status');
    state.semantics.ready = !!d.ready;
    if (!d.ready) state.semantics.reason = d.reason || '索引未构建';
    return state.semantics.ready;
  } catch (_) {
    state.semantics.ready = false;
    state.semantics.reason = '语义服务不可用';
    return false;
  }
}

/** 概念墙搜索输入（input 委派）：防抖后刷新概念墙，不动输入框本身。 */
export function conceptQueryInput(t) {
  state.concepts.q = t.value;
  clearTimeout(conceptTimer);
  conceptTimer = setTimeout(() => loadConcepts(), 250);
}

/** 概念详情页「加载更多」：按当前页 offset 续 50 张，局部重绘。 */
export async function conceptMore() {
  const p = state.conceptPage;
  const d = await api.get('/api/concepts/images?' + new URLSearchParams({
    key: p.key, limit: '50', offset: String(p.items.length),
  }).toString());
  p.items = p.items.concat(d.items || []);
  p.total = Number(d.total || p.total);
  view.innerHTML = conceptDetailHtml(p);
}

// ---- 动作注册表：data-act → 处理器（app.js 事件委派调用）----
export const actions = {
  'concept-open': async (btn) => {
    // 不可过滤的概念卡：点整卡进详情页（概念名本就有 #/concept/<key> 链接，
    // 之前这里缺 case，点了整卡没反应——靠链接侥幸掩盖了）。
    location.hash = '#/concept/' + encodeURIComponent(btn.dataset.key || '');
  },
  'concept-pick': async (btn) => {
    setFilterSpec(addFilter(state.form.filter, btn.dataset.pool || '', btn.dataset.v));
    syncConceptPanel();
    done(`已加入过滤：${(btn.dataset.pool ? btn.dataset.pool + ':' : '') + btn.dataset.v}`);
  },
  'concept-kind': async (btn) => {
    state.concepts.kind = btn.dataset.v || '';
    syncConceptPanel(); await loadConcepts();
  },
  'concept-refresh': async () => {
    await loadConcepts(); done('概念墙已刷新');
  },
  'concept-back': async () => {
    location.hash = '#draw';
  },
  'concept-more': async () => {
    await conceptMore();
  },
};
