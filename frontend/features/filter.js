import { api } from '../api.js';
import { esc } from '../detail.js';
import { debounce, persistForm } from '../state.js';
import { state } from '../store.js';
import { addFilter, conceptCardsHtml, conceptKindChipsHtml, filterChipsHtml, hotTagChipsHtml, missingFilterSlots, parseFilterSpec, poolOptionsHtml, quickFilterHtml, removeFilter, semanticCardsHtml, tagOptionsHtml } from '../widgets.js';
import { $, done } from '../core/ui.js';
import { loadConcepts, loadSemantics, semanticHintHtml, syncConceptPanel } from '../views/concepts.js';
import { renderDraw } from '../views/draw.js';

// 过滤构造器：三种输入方式（按池/tag、看图选概念、一句话找画师）共用一条表达式。
// 这里只负责「表达式怎么构造、提示怎么显示」；概念墙数据在 views/concepts。

const FEEL_PRESETS = ['黄昏逆光、有点忧郁的校园少女', '厚涂暗色调',
  '萌系水彩治愈', '精致水光肌韩系'];

/** 过滤的两种「看起来生效其实没有」的情况，输入时就地提示，不必等抽完。 */
export function filterHintText() {
  const f = state.form;
  const notes = [];
  const bare = String(f.filter || '').split(',').map((s) => s.trim())
    .filter((s) => s && !s.includes(':') && !s.includes('：'));
  if (bare.length) {
    const withRecipe = String(f.recipe_id || '') !== '';
    notes.push(`⚠ 裸关键字 ${bare.join('、')} 会筛掉所有不含它的卡池` +
      `${withRecipe ? '（配方槽位可能变空）' : ''}；只筛某个池请写「角色:fate」。`);
  }
  // 配方没有对应槽位时，后端会自动补一个槽位把 tag 写进 prompt；这里先讲清楚，
  // 避免用户以为「选了画师却没写进 prompt」又是一次静默失效。
  const recipe = state.recipes.find((r) => String(r.id) === String(f.recipe_id));
  const missing = missingFilterSlots(f.filter, recipe, state.pools);
  if (missing.length) {
    notes.push(`ℹ ${missing.map((r) => `${r.pool}:${r.tag}`).join('、')} ` +
      '在当前配方里没有对应槽位：抽卡时会自动补一个槽位，把所选 tag 写进 prompt；' +
      '点下面「把缺的槽位加进配方」可固定下来，下次不用再补。');
  }
  return notes.join('　');
}

export function updateFilterHint() {
  const box = $('#filterHintBox');
  if (box) box.innerHTML = filterHintBoxHtml();
}

/** 当前配方缺哪些槽位：缺得掉就顺手给一个「加进配方」的按钮。 */
export function missingSlots() {
  const f = state.form;
  if (!f.recipe_id) return [];
  const recipe = state.recipes.find((r) => String(r.id) === String(f.recipe_id));
  return missingFilterSlots(f.filter, recipe, state.pools);
}

export function filterHintBoxHtml() {
  const text = filterHintText();
  const fixable = missingSlots().length > 0;
  if (!text && !fixable) return '';
  return `${text ? `<div class="hint warn-text" id="filterHint">${esc(text)}</div>` : ''}
    ${fixable ? '<button class="btn small" data-act="fix-recipe">把缺的槽位加进配方</button>' : ''}`;
}

/** 把「配方没有对应槽位」的条件一步固定进配方：不用跳配方编辑器再手动选一遍池。 */
export async function addFilterToRecipe() {
  const rid = Number(state.form.recipe_id);
  if (!rid) throw new Error('先选一个配方（或改成全池随机）才能固定槽位');
  const recipe = state.recipes.find((r) => Number(r.id) === rid);
  if (!recipe) throw new Error('配方已不存在，请刷新页面');
  const missing = missingFilterSlots(state.form.filter, recipe, state.pools);
  if (!missing.length) { done('当前配方槽位已覆盖这些条件'); return; }
  const def = JSON.parse(JSON.stringify(recipe.definition || {}));
  def.slots = Array.isArray(def.slots) ? def.slots : [];
  const added = [];
  for (const m of missing) {
    if (def.slots.some((s) => String(s.pool) === String(m.pool))) continue;
    def.slots.push({ pool: m.pool, count: 1, weight: 1, filter: m.tag });
    added.push(m.pool);
  }
  await api.put('/api/recipes/' + rid, {
    name: recipe.name,
    definition: def,
    // 必须带回原有的参数预设关联，否则后端会把它置空
    gen_profile_id: recipe.gen_profile_id ?? null,
  });
  state.recipes = await api.get('/api/recipes');
  done(`已加进配方「${recipe.name}」：${added.join('、')}`);
  updateFilterHint();
}

/** 过滤面板的三条输入路径：按池 / tag、看图选概念、一句话找画师。
 *  三者最终都写同一条过滤表达式，所以放在同一块面板里——选完主按钮就在下面几十像素，
 *  不用像之前那样在「左栏顶部过滤」和「右栏底部概念墙」之间来回滚。 */
export function filterPaneHtml(mode) {
  const f = state.form;
  if (mode === 'concept') {
    const c = state.concepts;
    const selectedKeys = parseFilterSpec(f.filter).map((r) => r.tag.toLowerCase());
    return `<div class="concept-bar">
      <input type="text" id="conceptQ" value="${esc(c.q)}" placeholder="搜概念名（留空浏览）">
      <button class="btn small" data-act="concept-refresh">刷新</button>
    </div>
    <div class="hot-tags" id="conceptKinds">${conceptKindChipsHtml(c.kinds, c.kind)}</div>
    <div id="conceptWall" class="concept-wall tight">${conceptCardsHtml(c.items.slice(0, 8), { selectedKeys })}</div>
    <div class="hint">悬浮看一张代表图 · 点卡片加入过滤 · 点概念名看全部（首屏 50 张）· ${c.image_count} 张历史图</div>`;
  }
  if (mode === 'feel') {
    const feels = FEEL_PRESETS.map((x) =>
      `<button type="button" class="chip hot" data-act="feel-chip" data-v="${esc(x)}">${esc(x)}</button>`).join('');
    return `<div class="semantic-bar">
      <input type="text" id="semanticQ" value="${esc(state.semantics.q)}"
        placeholder="想要的感觉：一句话描述画风">
      <button class="btn small primary" data-act="semantic-go">找画师</button>
    </div>
    <div class="hot-tags"><span class="hint">试着点一个：</span>${feels}</div>
    <div id="semanticHint">${semanticHintHtml()}</div>
    <div id="semanticCards">${semanticCardsHtml(state.semantics.items)}</div>`;
  }
  return `<div class="row" style="margin-bottom:6px">
      ${quickFilterHtml('dFilterPool', '筛选卡池 / 类别（如 角色 / attire）', { width: 999 })}
      <span class="hint" data-qf-count="dFilterPool"></span>
    </div>
    <div class="row">
      <select id="dFilterPool" style="flex:1;min-width:108px">${poolOptionsHtml(state.pools, state.filterPool)}</select>
      <select id="dFilterTag" style="flex:1;min-width:100px">${tagOptionsHtml(state.tagOptions, '')}</select>
      <button class="btn small primary" data-act="filter-add">＋ 添加</button>
    </div>
    <div class="row" style="margin-top:6px">
      <input type="text" id="dFilterTagQ" value="${esc(state.filterTagQ)}"
        placeholder="找 tag：输入 2 个字自动联想" style="width:100%">
    </div>
    <div class="hot-tags"><span class="hint">热门 tag · 点一下就加：</span>
      <span id="hotTags">${hotTagChipsHtml(state.hotTags.slice(0, 12))}</span></div>`;
}

/** 切换过滤输入方式：重绘面板即可，过滤表达式本身不变。 */
export async function setFilterMode(mode) {
  if (!['pool', 'concept', 'feel'].includes(mode)) return;
  state.form.filterMode = mode;
  persistForm(state);
  await renderDraw();
  if (mode === 'concept' && !state.concepts.loaded) await loadConcepts();
}

// ---------------- 点选控件：数据加载与局部刷新 ----------------
let tagTimer = null;
export async function loadTagOptions(pool = state.filterPool, q = '', debounce = false) {
  if (debounce) {
    clearTimeout(tagTimer);
    tagTimer = setTimeout(() => loadTagOptions(pool, q), 250);
    return;
  }
  const params = new URLSearchParams({ limit: '40' });
  if (pool) params.set('pool', pool);
  if (q) params.set('q', q);
  try {
    const d = await api.get('/api/pools/tag-suggest?' + params.toString());
    state.tagOptions = d.items || [];
    if (!q) state.hotTags = state.tagOptions;
    syncTagControls();
  } catch (_) { /* 候选加载失败不阻塞抽卡，高级模式仍可手填 */ }
}

export function syncTagControls() {
  const sel = $('#dFilterTag');
  if (sel) sel.innerHTML = tagOptionsHtml(state.tagOptions, sel.value);
  const hot = $('#hotTags');
  if (hot) hot.innerHTML = hotTagChipsHtml(state.hotTags.slice(0, 12));
  const chips = $('#filterChips');
  if (chips) chips.innerHTML = filterChipsHtml(state.form.filter);
  const dl = $('#slotTagList');
  if (dl) dl.innerHTML = state.hotTags.map((x) =>
    `<option value="${esc(x.value)}"></option>`).join('');
}

/** 构造器写回唯一的过滤表达式输入框，提示与提交逻辑完全复用原来的链路。 */
export function setFilterSpec(spec) {
  state.form.filter = spec;
  const el = $('#dFilter');
  if (el) el.value = spec;
  syncTagControls();
  updateFilterHint();
  persistForm(state);
}

/** tag 联想输入（input 委派）：防抖拉候选，不动输入框本身。 */
export function filterTagQInput(t) {
  state.filterTagQ = t.value;
  loadTagOptions(state.filterPool, t.value.trim(), true);
}

// ---- 动作注册表：data-act → 处理器（app.js 事件委派调用）----
export const actions = {
  'filter-mode': async (btn) => {
    await setFilterMode(btn.dataset.v);
  },
  'filter-add': async () => {
    // 搜索框里手打的优先于下拉选中项；加完清空并把候选恢复成热门。
    const tag = $('#dFilterTagQ')?.value.trim() || $('#dFilterTag')?.value;
    if (!tag) throw new Error('先选一个 tag，或点下方热门 tag');
    setFilterSpec(addFilter(state.form.filter, state.filterPool, tag));
    const q = $('#dFilterTagQ'); if (q) q.value = '';
    state.filterTagQ = '';
    loadTagOptions(state.filterPool, '');
    done(`已添加过滤：${state.filterPool ? state.filterPool + ':' : ''}${tag}`);
  },
  'filter-hot': async (btn) => {
    setFilterSpec(addFilter(state.form.filter, state.filterPool, btn.dataset.v));
  },
  'filter-del': async (btn) => {
    const i = Number(btn.dataset.i);
    setFilterSpec(removeFilter(state.form.filter, i));
  },
  'filter-clear': async () => {
    setFilterSpec(''); syncConceptPanel();
  },
  'fix-recipe': async () => {
    await addFilterToRecipe();
  },
  'feel-chip': async (btn) => {
    const el = $('#semanticQ'); if (el) el.value = btn.dataset.v;
    await loadSemantics(btn.dataset.v);
  },
  'semantic-go': async () => {
    await loadSemantics($('#semanticQ')?.value.trim() || '');
  },
  'semantic-pick': async (btn) => {
    setFilterSpec(addFilter(state.form.filter, '画师', btn.dataset.v));
    syncConceptPanel();
    done(`已按画师过滤：${btn.dataset.v}`);
  },
};
