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
    },
    // 意群双语补全的临时 UI 态：不持久化
    vocab: { ready: null, items: [], q: '', scope: '', uid: 0, open: false, loading: false },
    form: { recipe_id: '', pulls: 3, count: 1, seed: '', filter: '',
      gen_profile_id: '', filterMode: 'pool' },
    filterPool: null, filterTagQ: '', tagOptions: [], hotTags: [],
    loraDraft: [], slotsDraft: [],
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
