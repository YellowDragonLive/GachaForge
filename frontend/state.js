// 应用状态与持久化的唯一出口。
//
// 过去 FORM_KEY 的序列化表达式散落 5 处，readDrawForm() 用字面量对象整体替换
// state.form 时会静默丢掉 filterMode（用户在「看图选概念」模式改一下连抽数，
// 过滤面板就自己跳回「按池」）。多模型改造后 form 还会加字段，必须收口。
//
// 依赖：只 import widgets.js 的 makePerson/makeScene（纯函数），不碰 DOM/API。

import { makePerson, makeScene } from './widgets.js';

export const LAST_SESSION_KEY = 'gacha_last_session';
export const FORM_KEY = 'gacha_draw_form';
export const ASM_KEY = 'gacha_assembly_v2';   // v2：默认全关，旧 key 的默认随机不能复活
// 池内切片的选择：按池各记各的，跨会话保留（用户口径是「长期设定」）。
// 用 localStorage 而不是 sessionStorage —— 关掉浏览器还要在，但必须在 UI 上
// 一直看得见（chip 高亮 + 条数变少），否则「抽出来的东西莫名变窄」无从排查。
export const FACET_KEY = 'gacha_facets_v1';

/** 创建初始 state。视图只有一个字段 view（过去 currentView/route 双份，靠纪律保持一致）。 */
export function createState() {
  return {
    recipes: [], profiles: [], pools: [], batches: [], jobs: [], images: [],
    config: {}, comfy: {}, models: {}, session: null, draws: [], warnings: [],
    view: 'draw', editingRecipe: null, openPool: null,
    // 结果卡片内联状态：draw_id → 最新任务 / 已出图片
    drawJobs: {}, drawImages: {},
    tuning: false, tuneDraft: null, settingsPid: null,
    gallery: { favorite: '', origin: '', min_rating: 0 },
    // 装配：人数 = 人物卡张数；所有格子默认关闭（白纸起步）
    assembly: {
      enabled: true, tab: 'people', people: [makePerson(1)], scene: makeScene(), nextUid: 2,
      picking: null, entries: [], entriesTotal: 0, entriesLoading: false,
      pickerPool: '', pickerQ: '', pickerPoolQ: '', pickerLocked: false,
      facetGroups: [], facetLoading: false, facetCache: {},
    },
    // 池内切片选择：{池名: [切片 slug]}。空数组 / 缺键 = 整池，行为与没有切片时一致。
    facets: {},
    // 意群双语补全的临时 UI 态：不持久化
    vocab: { ready: null, items: [], q: '', scope: '', uid: 0, open: false, loading: false },
    form: { recipe_id: '', pulls: 3, count: 1, seed: '', filter: '',
      gen_profile_id: '', filterMode: 'pool' },
    filterPool: null, filterTagQ: '', tagOptions: [], hotTags: [],
    // 槽位 / LoRA 草稿不再放这里：它们只在配方页与设置页内部有意义，
    // 住在各自 Vue 组件的 reactive 里，跟着组件一起创建与销毁。
    concepts: { items: [], kinds: [], kind: '', q: '', image_count: 0, loaded: false },
    semantics: { ready: null, reason: '', items: [], q: '', mode: '' },
    conceptThumbMap: {},
    covers: { cache: {}, pending: {} },
    portraits: {},
    conceptPage: { key: '', label: '', kind: '', pool: '', items: [], total: 0, offset: 0 },
  };
}

/** 表单持久化的唯一出口。加任何 form 新字段只需改这一处。 */
export function persistForm(state) {
  sessionStorage.setItem(FORM_KEY, JSON.stringify({
    ...state.form, filterPool: state.filterPool,
  }));
}

/** 恢复表单：用默认对象做底，逐字段合并——绝不整体替换，否则新字段/未存字段会丢。 */
export function restoreForm(state) {
  const raw = sessionStorage.getItem(FORM_KEY);
  if (!raw) return;
  try {
    const saved = JSON.parse(raw);
    Object.assign(state.form, saved);
    if (saved.filterPool !== undefined) state.filterPool = saved.filterPool;
  } catch (_) { /* 坏数据忽略，用默认值 */ }
}

/** 通用防抖：过去 4 个 timer（asm/vocab/concept/tag）各写各的，口径不一。 */
export function debounce(fn, ms) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

/** 切片选择的唯一写出口。空数组直接删键，避免 localStorage 里堆一堆 `[]`。 */
export function persistFacets(state) {
  try {
    const clean = {};
    Object.entries(state.facets || {}).forEach(([pool, slugs]) => {
      const list = (slugs || []).filter(Boolean);
      if (list.length) clean[pool] = list;
    });
    localStorage.setItem(FACET_KEY, JSON.stringify(clean));
  } catch (_) { /* 隐私模式：切片只是丢一次配置，不影响抽卡 */ }
}

export function restoreFacets(state) {
  try {
    const saved = JSON.parse(localStorage.getItem(FACET_KEY) || '{}');
    state.facets = (saved && typeof saved === 'object') ? saved : {};
  } catch (_) { state.facets = {}; }
}
