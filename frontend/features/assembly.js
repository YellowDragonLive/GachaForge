import { $ } from '../core/ui.js';
import { api, friendlyError } from '../api.js';
import { cut, esc } from '../detail.js';
import { ASM_KEY } from '../state.js';
import { state } from '../store.js';
import { DOLL_PARTS, PERSON_SLOTS, SCENE_SLOTS, assemblyIsEmpty, countTagsFor, dollFigureHtml, makePerson, makeScene, matchQuery, personTitle, poolChipsHtml, poolSearchText, portraitKeys, queryWords, rankPools, sceneStageHtml } from '../widgets.js';
import { refresh } from '../core/router.js';
import { setQfCount } from './quickfilter.js';
import { vocabSuggestHtml } from './vocab.js';

// 装配面板：场景 / 人物。
// 人数是「人物卡的张数」，不是开关：删卡就少一个人，0 张就是纯场景图。
// 所有对抽卡台的整页刷新一律走 refresh('draw')——抽卡视图在 views/draw，
// 这里 import 它就是循环依赖。

// ---------------- 装配面板：场景 / 人物 ----------------
// 人数是「人物卡的张数」，不是开关：删卡就少一个人，0 张就是纯场景图。

export function asmSummaryText() {
  const a = state.assembly;
  const n = a.people.length;
  const base = n ? `${n} 人 · ${countTagsFor(a.people)}` : '纯场景 · 无人物';
  // 全关是默认状态，必须写在标题上：否则「什么都没开」看起来像面板坏了
  if (assemblyIsEmpty(a)) return `${base} · 全关`;
  // 意群自由输入会真的进 prompt；不露头的话出图对不上
  const groups = [a.scene, ...a.people].filter((g) => g && String(g.extra || '').trim()).length;
  return groups ? `${base} · ${groups} 个意群带自定义词` : base;
}

export function assemblyPanelHtml() {
  const a = state.assembly;
  const tab = a.tab === 'scene' ? 'scene' : 'people';
  return `<div class="asm">
    <div class="asm-tabs">
      <button type="button" class="asm-tab${tab === 'scene' ? ' on' : ''}"
        data-act="asm-tab" data-v="scene">场景</button>
      <button type="button" class="asm-tab${tab === 'people' ? ' on' : ''}"
        data-act="asm-tab" data-v="people">人物 · ${a.people.length}</button>
    </div>
    <div class="asm-body">${tab === 'scene' ? asmSceneHtml() : asmPeopleHtml()}</div>
  </div>`;
}

/**
 * 意群自由输入：每个场景 / 每个人物卡各一个。
 *
 * 输入框是「查询工具」，g.extra 是「已确认的英文 tag 串」——两者分离，
 * 所以中文查询词绝不会误进 prompt。词表本质是 英文↔中文 的 map：
 *   中文输入 → 中文候选 → 点选写入对应英文
 *   英文输入 → 英文候选 → 点选写入英文本身
 * 候选一律显示「主语言 · 对照语言」双语；写进 prompt 的永远是英文 tag。
 * 已选词以 chip 展示，可点 × 删除；输入框回车可原样追加一个英文 tag（逃生口）。
 */
export function asmGroupInputHtml(scope, uid, label) {
  const g = scope === 'scene' ? state.assembly.scene
    : state.assembly.people.find((p) => p.uid === uid);
  if (!g) return '';
  const active = state.vocab.scope === scope
    && Number(state.vocab.uid || 0) === Number(uid || 0);
  const q = active ? String(state.vocab.q || '') : '';
  const words = String(g.extra || '').split(',').map((x) => x.trim()).filter(Boolean);
  const su = `data-scope="${scope}" data-uid="${uid || 0}"`;
  const chips = words.map((w, i) => `<span class="vocab-chip" title="已选词，点 × 删除">${esc(cut(w, 30))}
    <button type="button" data-act="vocab-del" data-i="${i}" ${su} title="删除这个词">×</button></span>`).join('');
  return `<div class="asm-extra${words.length ? ' on' : ''}" ${su}>
    <span class="asm-extra-k">${esc(label)} · 自由词</span>
    <input type="text" class="asm-extra-q" data-act="asm-extra" ${su}
      value="${esc(q)}" placeholder="输入 黑发 / silver hair 查词表，点候选加入"
      autocomplete="off" spellcheck="false"
      title="中英文都能查；候选显示双语，点一下把英文写进这个词群">
  </div>
  ${words.length ? `<div class="vocab-chosen" ${su}>${chips}</div>` : ''}
  <div class="vocab-suggest" ${su} ${active && state.vocab.open ? '' : 'hidden'}>${active ? vocabSuggestHtml() : ''}</div>`;
}

export function asmSceneHtml() {
  const a = state.assembly;
  const scene = a.scene;
  const open = (k) => a.picking && a.picking.scope === 'scene' && a.picking.key === k;
  const part = (key, label, side) => asmPartHtml(scene[key], {
    label, key, scope: 'scene', open: open(key), side,
  });
  // 场景也是一张图：虚线画框里点画面 = 背景、点色点 = 画风、点左下角签名 = 画师、
  // 点画框 = 构图。
  return `<div class="stage-grid">
    ${part('background', '背景', 'l')}
    ${part('style', '画风', 'r')}
    <div class="doll doll-stage">${sceneStageHtml(scene)}</div>
    ${part('artist', '画师', 'l')}
    ${part('composition', '构图', 'r')}
  </div>
  ${asmGroupInputHtml('scene', 0, '场景意群')}
  ${a.picking && a.picking.scope === 'scene' ? asmPickerHtml(a.picking.key) : ''}
  <p class="hint" style="margin:8px 0 0">画风 / 画师对所有人物统一生效。场景全关 = 白底纯人物。</p>`;
}

export function asmPeopleHtml() {
  const a = state.assembly;
  const cards = a.people.map((p, i) => asmPersonCard(p, i)).join('');
  if (!a.people.length) {
    // 0 张卡 = 纯场景图。空位也摆一个虚线小人：一眼看出「这里本该站个人」。
    return `<div class="asm-empty">
      <div class="doll doll-person is-empty">${dollFigureHtml({}, { ghost: true })}</div>
      <p class="hint">0 个人物 = 纯场景图，prompt 会写 no humans。点下面加人。</p>
    </div>
    <button type="button" class="asm-add" data-act="asm-add">＋ 添加人物</button>`;
  }
  return `${cards}
    <button type="button" class="asm-add" data-act="asm-add">＋ 添加人物</button>`;
}

/**
 * 一张人物卡 = 身体部位面板：角色条在头顶，左右两列是「部位 → 当前值」，
 * 中间是虚线小人。点左/右的格子或直接点身体，都打开同一格的条目选择器。
 */
export function asmPersonCard(p, idx) {
  const a = state.assembly;
  const picking = a.picking && a.picking.scope === 'person' && a.picking.uid === p.uid
    ? a.picking.key : null;
  const g = p.gender || 'female';
  const gBtn = (v, t) => `<button type="button" class="${g === v ? 'on' : ''}"
    data-act="asm-gender" data-uid="${p.uid}" data-v="${v}">${t}</button>`;
  const role = p.slots.role || {};
  const name = personTitle(p);
  const keys = portraitKeys(role);
  const part = (key, side) => asmPartHtml(p.slots[key], {
    label: (DOLL_PARTS.find((d) => d.key === key) || {}).label || key,
    key, uid: p.uid, open: picking === key, side,
  });
  return `<div class="char-sheet${picking ? ' picking' : ''}" data-uid="${p.uid}">
    <div class="char-head">
      <span class="char-idx">P${idx + 1}</span>
      <span class="char-name" title="${esc(name || '角色交给骰子')}">${esc(name || '随机角色')}</span>
      <span class="asm-gender">${gBtn('female', '女')}${gBtn('male', '男')}${gBtn('other', '其他')}</span>
      <span class="asm-card-ops">
        <button type="button" data-act="asm-copy" data-uid="${p.uid}">复制</button>
        <button type="button" data-act="asm-del" data-uid="${p.uid}">移除</button>
      </span>
    </div>
    <div class="char-body">
      ${asmPartHtml(role, { label: '角色', key: 'role', uid: p.uid, open: picking === 'role', side: 'role' })}
      ${part('hair', 'l')}
      ${part('face', 'r')}
      <div class="doll doll-person">
        <button type="button" class="doll-art" data-act="asm-portrait" data-uid="${p.uid}"
          data-portrait="${esc(keys.join(','))}" data-title="${esc(name)}"
          title="${keys.length ? '点这里看这个角色出过的全部历史图'
            : '点这里锁角色；出过图之后这块就是他的立绘'}"></button>
        ${dollFigureHtml(p.slots, { uid: p.uid, gender: g })}
      </div>
      ${part('outfit', 'l')}
      ${part('gear', 'r')}
      ${part('action', 'wide')}
    </div>
    ${asmGroupInputHtml('person', p.uid, `P${idx + 1} 意群`)}
    ${picking ? asmPickerHtml(picking) : ''}
  </div>`;
}

/** 一格槽位（左/右列成员、角色条、场景格共用）：点开就是这一格的条目选择器。 */
export function asmPartHtml(cfg, { label, key, uid, scope = 'person', open, side = '' }) {
  const c = cfg || { mode: 'off', pick: '', kind: '' };
  const mode = c.mode || 'off';
  // 锁定的值有两种来源：从池里点的条目（pick）和用户手写的任意值（free）。
  // 手填值挂 is-free，格子上用不同边框区分——一眼看出「这个不是池里的东西」。
  const hand = mode === 'locked' && !c.pick && !!c.free;
  const val = mode === 'locked' ? (c.pick || c.free || '已锁定')
    : (mode === 'off' ? '关闭' : '随机');
  const attrs = scope === 'scene'
    ? `data-scope="scene" data-key="${key}"`
    : `data-scope="person" data-uid="${uid}" data-key="${key}"`;
  return `<button type="button" class="part m-${mode}${open ? ' open' : ''}${hand ? ' is-free' : ''}${side ? ' side-' + side : ''}"
    data-act="asm-open" ${attrs}
    title="${esc(`${label}：${val}${hand ? '（手填）' : ''}`)}">
    <span class="part-k"><i class="stat-dot"></i>${esc(label)}</span>
    <span class="part-v">${esc(mode === 'locked' ? cut(val, 20) : val)}</span>
  </button>`;
}

/**
 * 一行条目。画师池的条目带风格样图地址（后端按画师名配好的）：
 * 行尾挂一个「图」标，悬停 / 聚焦时浮出那位画师的样图——
 * 名字是 `dore (gilles dore)` 还是 `nawakena`，光看字判断不了画风。
 * 浮层不进 DOM 常驻、不在行内铺 <img>：一千多条画师名一次铺图会拖垮列表。
 */
export function asmEntryRow(e, showPool) {
  const thumb = String(e.thumb_url || '');
  const eye = thumb
    ? `<span class="asm-entry-eye" title="悬停看这位画师的风格样图">图</span>` : '';
  const cover = thumb
    ? ` data-thumb-url="${esc(thumb)}" data-thumb-name="${esc(e.label)}"` : '';
  return `<button type="button" class="asm-entry${thumb ? ' has-thumb' : ''}"${cover}
    data-act="asm-pick" data-label="${esc(e.label)}" data-tags="${esc(e.tags || '')}"
    title="${esc([e.tags || '', e.pool || ''].filter(Boolean).join(' · '))}">
    <span class="asm-entry-label">${esc(cut(e.label, 42))}</span>
    ${eye}
    ${showPool ? `<span class="asm-entry-pool">${esc(cut(e.pool, 16))}</span>` : ''}
  </button>`;
}

export function asmEntriesHtml() {
  const a = state.assembly;
  if (a.entriesLoading) return '<div class="hint">加载中…</div>';
  const list = a.entries || [];
  if (!list.length) return '<div class="hint">没有匹配条目：换个词试试（支持半截词，如 black h），或点池 chip 限定范围</div>';
  // 已经选定单池时，每行右侧再写一遍同一个池名是废话，把宽度让给条目名。
  // 搜索跨池时不算「单池」，仍按池分组，否则看不出这条来自哪儿。
  const single = a.pickerPool && (!a.pickerQ || a.pickerLocked);
  if (single) return list.map((e) => asmEntryRow(e, false)).join('');

  // 「全部」= 多池混排（后端每池只给几条）。按池分组，组顺序跟匹配度走，
  // 组头本身就是「只看这一池」的按钮 —— 想深挖点一下就行，不用回去找 chip。
  const groups = new Map();
  list.forEach((e) => {
    const k = String(e.pool || '');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  });
  const order = rankPools(state.pools, asmPickingKind(), a.picking && a.picking.key)
    .map((p) => p.name);
  const names = [...groups.keys()].sort((x, y) => {
    const ix = order.indexOf(x), iy = order.indexOf(y);
    return (ix < 0 ? 1e6 : ix) - (iy < 0 ? 1e6 : iy);
  });
  return names.map((name) => `<div class="asm-group" data-act="asm-pick-pool"
      data-v="${esc(name)}" title="只看「${esc(name)}」">${esc(cut(name, 26))}</div>`
    + groups.get(name).map((e) => asmEntryRow(e, false)).join('')).join('');
}

/** 当前选择器那一格的类别（kind），「全部」模式给组排序用。 */
export function asmPickingKind() {
  const pk = state.assembly.picking;
  if (!pk) return '';
  const def = [...SCENE_SLOTS, ...PERSON_SLOTS].find((d) => d.key === pk.key);
  return def ? def.kind : '';
}

export function asmCountHtml() {
  const a = state.assembly;
  const scope = a.pickerQ && !a.pickerLocked ? ' · 跨全部匹配池搜索' : '';
  return `共 ${a.entriesTotal || 0} 条${a.entriesTotal > 60 ? ' · 只显示前 60 条，用搜索缩小' : ''}${scope}`;
}

export function asmPickerHtml(key) {
  const a = state.assembly;
  const def = [...SCENE_SLOTS, ...PERSON_SLOTS].find((d) => d.key === key);
  const kind = def ? def.kind : '';
  const label = (def && def.label) || (key === 'role' ? '角色' : key);
  const cfg = asmCurrentCfg();
  const ranked = rankPools(state.pools, kind, key);
  const picked = a.pickerPool;
  const pickedPool = ranked.find((p) => p.name === picked);
  return `<div class="asm-picker">
    <div class="asm-picker-head"><i class="stat-dot"></i>${esc(label)} · 选条目或改状态
      <span class="asm-picker-kind">${kind ? `${ranked.length} 池匹配` : ''}</span>
    </div>
    <div class="row">
      <button type="button" class="chip${cfg && cfg.mode === 'random' ? ' on' : ''}"
        data-act="asm-mode" data-v="random">随机</button>
      <button type="button" class="chip${cfg && cfg.mode === 'off' ? ' on' : ''}"
        data-act="asm-mode" data-v="off">关闭</button>
      <span class="hint" style="flex:1">点条目即固定，之后每抽都不变${
        kind === '画师' ? '；带「图」的悬停看画风样图' : ''}</span>
      <button type="button" class="btn small" data-act="asm-close">收起</button>
    </div>
    <div class="row asm-pool-q"><input type="text" class="qf" data-asm-pool-q
      value="${esc(a.pickerPoolQ)}" placeholder="筛选卡池：如 服装 / hair"
      style="max-width:999px" autocomplete="off" spellcheck="false"
      title="输入池名片段，chip 行只留命中的池">
      <span class="hint" data-qf-count="asmPoolList"></span></div>
    <div class="asm-pools" id="asmPoolList">${poolChipsHtml(state.pools, kind, key, picked, 8, a.pickerPoolQ)}</div>
    <div class="row" style="margin-top:6px">
      <select class="asm-pool" data-act="asm-pool" title="全部 ${ranked.length} 池">${asmPoolOptionsHtml(ranked, picked)}</select>
      <input type="text" class="asm-q" data-act="asm-q" value="${esc(a.pickerQ)}"
        placeholder="搜条目，也可直接写任意 tag（英文，不限池子）"
        title="池里的条目点一下就锁定；池里没有的词，用下面那颗「直接写进 prompt」">
    </div>
    <div class="asm-entries">${asmEntriesHtml()}</div>
    <div class="asm-free-slot">${asmFreeRowHtml()}</div>
    <div class="hint asm-count">${asmCountHtml()}</div>
  </div>`;
}

/**
 * 「池里没有的东西也要能用」：把搜索框里的词直接写成 prompt 的一个 tag。
 * 只打过字才出现 —— 空着时它是纯噪音 + 白占一行高度。
 * 有命中时是「没找到？」，零命中时加重（池里根本不存在，这是唯一出路）。
 */
export function asmFreeRowHtml() {
  const a = state.assembly;
  const q = String(a.pickerQ || '').trim();
  if (!q) return '';
  const n = (a.entries || []).length;
  const k = n ? '没找到？' : '池里没有';
  return `<button type="button" class="asm-free${n ? '' : ' strong'}"
    data-act="asm-free" data-v="${esc(q)}"
    title="不查池子，直接把这段文字当一个 tag 写进 prompt（逗号可分隔多个）">
    <span class="asm-free-k">${k}</span>把「${esc(cut(q, 40))}」直接写进 prompt
  </button>`;
}

/** 下拉兜底：chip 行只摆前 8 个匹配池，剩下的都在这里，选哪池都行。
 * 冷存池不进推荐（chip 行），但必须出现在下拉里 —— 否则「action 这个池明明导入过，
 * 选择器里怎么没有」永远是个谜；名字前挂（冷存）说明它为什么排在最后。 */
export function asmPoolOptionsHtml(ranked, current, q = '') {
  const extra = state.pools.filter((p) => p && p.enabled === false
    && String(p.kind || '') === String(asmPickingKind() || '')
    && !ranked.some((r) => r.name === p.name));
  const list = [...ranked, ...extra];
  const words = queryWords(q);
  // 别名一起搜：打「艺术家」要能选到「画师图鉴」。
  const hit = words.length
    ? list.filter((p) => matchQuery(poolSearchText(p), q))
    : list;
  const total = hit.reduce((s, p) => s + Number(p.item_count || 0), 0);
  const opts = [`<option value="">${words.length ? '筛选后' : '全部'} ${total} 条</option>`];
  hit.forEach((p) => {
    const name = String(p.name || '');
    const mark = p.enabled === false ? '（冷存）' : '';
    opts.push(`<option value="${esc(name)}"${name === current ? ' selected' : ''}>${mark}${esc(cut(name, 34))} · ${p.item_count || 0}</option>`);
  });
  if (words.length && !hit.length) opts.push('<option value="">没有匹配的池</option>');
  return opts.join('');
}

/** 池筛选只重画 chip 行 + 下拉，不碰外层输入框（否则每敲一字就失焦）。 */
export function refreshAsmPools() {
  const a = state.assembly;
  if (!a.picking) return;
  const def = [...SCENE_SLOTS, ...PERSON_SLOTS].find((d) => d.key === a.picking.key);
  const kind = def ? def.kind : '';
  const ranked = rankPools(state.pools, kind, a.picking.key);
  const box = $('#asmPoolList');
  if (box) box.innerHTML = poolChipsHtml(state.pools, kind, a.picking.key, a.pickerPool, 8, a.pickerPoolQ);
  const sel = $('.asm-pool');
  if (sel) sel.innerHTML = asmPoolOptionsHtml(ranked, a.pickerPool, a.pickerPoolQ);
  const words = queryWords(a.pickerPoolQ);
  setQfCount('asmPoolList',
    words.length ? ranked.filter((p) => matchQuery(poolSearchText(p), a.pickerPoolQ)).length : ranked.length,
    a.pickerPoolQ);
}

export function asmCurrentCfg() {
  const pk = state.assembly.picking;
  if (!pk) return null;
  if (pk.scope === 'scene') return state.assembly.scene[pk.key];
  const p = state.assembly.people.find((x) => x.uid === pk.uid);
  return p ? p.slots[pk.key] : null;
}

/**
 * 打开某一格的选择器：先按该格类别拉一批条目（空 q = 前 60 条）。
 * 默认落在「匹配度最高的池」上——点衣着就直接看到能穿的衣服，而不是 106 池
 * 按导入顺序混出来的前 60 条；想跨池就点 chip 行的「全部」。
 */
export async function asmOpenPicker(scope, uid, key) {
  const a = state.assembly;
  a.picking = { scope, uid, key };
  a.entries = []; a.entriesTotal = 0; a.pickerQ = '';
  a.pickerPoolQ = ''; a.pickerLocked = false;
  const def = [...SCENE_SLOTS, ...PERSON_SLOTS].find((d) => d.key === key);
  const best = rankPools(state.pools, def ? def.kind : '', key)
    .find((p) => Number(p.item_count || 0) > 0);
  a.pickerPool = best ? String(best.name) : '';
  await refresh('draw');
  await asmLoadEntries();
}

/** 点池 chip：只换池，不重建输入框，保留搜索词与焦点。 */
export async function asmPickPool(name) {
  const a = state.assembly;
  if (!a.picking) return;
  a.pickerPool = String(name || '');
  // 手动点过 chip = 明确要看这一池，搜索也不再跨池；点「全部」则解锁恢复跨池
  a.pickerLocked = !!a.pickerPool;
  await refresh('draw');          // chip 高亮与下拉选中值都要跟着变
  await asmLoadEntries();
}

export async function asmLoadEntries() {
  const a = state.assembly;
  if (!a.picking) return;
  const token = a.picking;    // 过期防护：等待期间换了格，旧响应不许写进新格的列表
  const def = [...SCENE_SLOTS, ...PERSON_SLOTS].find((d) => d.key === a.picking.key);
  const kind = def ? def.kind : '';
  a.entriesLoading = true;
  const box = $('.asm-entries');
  if (box) box.innerHTML = '<div class="hint">加载中…</div>';
  try {
    const qs = new URLSearchParams({ kind, limit: 60 });
    if (a.pickerQ) qs.set('q', a.pickerQ);
    // 搜索 = 跨池。默认落在「匹配度最高的池」只是浏览起点；一旦打了字，就该在这一类
    // 的所有池里找 —— `black h` 想命中 `black hair`，而 hair 不在「女性时尚穿搭」池里。
    // 只有用户手动点过 chip / 下拉，才把范围锁在他明确选中的那一池。
    if (a.pickerPool && (!a.pickerQ || a.pickerLocked)) qs.set('pool', a.pickerPool);
    const data = await api.get('/api/pools/items?' + qs.toString());
    if (a.picking !== token) return;   // 已经在别的格了：丢弃
    a.entries = data.items || [];
    a.entriesTotal = data.total || 0;
  } catch (err) {
    if (a.picking !== token) return;
    a.entries = []; a.entriesTotal = 0;
    if (box) box.innerHTML = `<div class="hint err-text">条目加载失败：${esc(friendlyError(err))}</div>`;
    return;
  } finally {
    if (a.picking === token) a.entriesLoading = false;
  }
  // 只更新列表与计数，不重建输入框：否则打字时每次都失焦。
  // 自由值按钮跟着命中数变文案（没找到？/ 池里没有），也在这里同步。
  if (box) box.innerHTML = asmEntriesHtml();
  const freeSlot = $('.asm-free-slot');
  if (freeSlot) freeSlot.innerHTML = asmFreeRowHtml();
  const cnt = $('.asm-count');
  if (cnt) cnt.textContent = asmCountHtml();
}

/** 改某一格的状态（随机 / 关闭），并收起选择器。 */
export async function asmSetMode(mode) {
  const cfg = asmCurrentCfg();
  if (!cfg) return;
  cfg.mode = mode;
  state.assembly.picking = null;
  await refresh('draw');
}

/** 锁定到具体条目。锁角色时顺手按条目里的人数 tag 校正性别，避免 1girl + 男角色的冲突。 */
export async function asmPick(label, tags, free = false) {
  const cfg = asmCurrentCfg();
  if (!cfg) return;
  const pk = state.assembly.picking;
  cfg.mode = 'locked';
  // free = 用户手写的任意值：不进池子查，pick 留空（后端按 free 直接写 prompt）。
  // pick 与 free 必须互斥，否则「池里改了名」和「我手写的词」会混成一笔糊涂账。
  cfg.free = free ? String(label || '').trim() : '';
  cfg.pick = free ? '' : String(label || '');
  cfg.tags = free ? cfg.free : String(tags || '');
  if (pk && pk.scope === 'person' && pk.key === 'role') {
    const p = state.assembly.people.find((x) => x.uid === pk.uid);
    // 判断性别要看英文 tags：label 是中文（「艾比蓋兒·威廉斯 (旅行服)」），拿它匹配 1girl 永远匹配不到。
    // 这里必须用原始 tags——stripCountTags 恰好会把 1girl/1boy 剥掉。
    const hay = `${tags || ''} ${label || ''}`.toLowerCase();
    const girls = (hay.match(/\b\d*girls?\b/g) || []).length;
    const boys = (hay.match(/\b\d*boys?\b/g) || []).length;
    if (p && boys > girls) p.gender = 'male';
    else if (p && girls > boys) p.gender = 'female';
  }
  state.assembly.picking = null;
  await refresh('draw');
}

/** 装配状态随抽卡台一起持久化：刷新 / 切视图回来不用重配一遍两个人物。 */
export function saveAssembly() {
  const a = state.assembly;
  try {
    // 意群的 extra 已在 scene / people 对象里，无需单独存全局 extra
    sessionStorage.setItem(ASM_KEY, JSON.stringify({
      people: a.people, scene: a.scene, nextUid: a.nextUid, tab: a.tab,
    }));
  } catch (_) { /* 配额满或隐私模式：装配只是丢一次配置，不影响抽卡 */ }
}

export function restoreAssembly() {
  try {
    const raw = sessionStorage.getItem(ASM_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (!saved || !Array.isArray(saved.people)) return;
    const people = saved.people.filter((p) => p && p.uid && p.slots);
    state.assembly.people = people;
    // 用 makeScene() 打底再合并：老版本存的场景可能缺格，缺的按默认补上
    state.assembly.scene = { ...makeScene(), ...(saved.scene || {}) };
    state.assembly.nextUid = Number(saved.nextUid)
      || (people.reduce((m, p) => Math.max(m, Number(p.uid) || 0), 0) + 1);
    state.assembly.tab = saved.tab === 'scene' ? 'scene' : 'people';
    // 老会话的全局 extra 迁移到场景意群，避免升级后自定义词凭空消失
    const legacy = String(saved.extra || '').trim();
    if (legacy && !state.assembly.scene.extra) state.assembly.scene.extra = legacy;
  } catch (_) { /* 坏数据忽略，用默认单人 */ }
}

// ---- 供 app.js 事件委派调用的输入入口 ----

/** 池筛选输入：只重画 chip 行 + 下拉，不碰外层输入框（否则每敲一字就失焦）。 */
export function asmPoolQInput(t) {
  state.assembly.pickerPoolQ = t.value;
  refreshAsmPools();
}

/** 装配选择器搜索输入：防抖后只刷新条目列表，不动输入框本身。 */
export function asmQueryInput(t) {
  state.assembly.pickerQ = t.value;
  clearTimeout(asmTimer);
  asmTimer = setTimeout(() => asmLoadEntries(), 280);
}

/** 回车立刻搜，不等防抖：`black h` + Enter = 直接看到 black hair。 */
export function asmSearchNow(t) {
  clearTimeout(asmTimer);
  state.assembly.pickerQ = t.value;
  asmLoadEntries();
}

/** 下拉选池与点 chip 同一语义：明确选了池就锁住，选「全部」解锁恢复跨池。 */
export function asmPoolChange(t) {
  const a = state.assembly;
  a.pickerPool = t.value;
  a.pickerLocked = !!t.value;
  refreshAsmPools();
  asmLoadEntries();
}

let asmTimer = null;

// ---- 动作注册表：data-act → 处理器（app.js 事件委派调用）----
export const actions = {
  'asm-tab': async (btn) => {
    const id = Number(btn.dataset.id), i = Number(btn.dataset.i);
state.assembly.tab = btn.dataset.v; await refresh('draw');
  },
  'asm-add': async (btn) => {
    const id = Number(btn.dataset.id), i = Number(btn.dataset.i);
{
        const a = state.assembly;
        a.people.push(makePerson(a.nextUid++));
        a.tab = 'people';
        await refresh('draw');

      }
  },
  'asm-del': async (btn) => {
    const id = Number(btn.dataset.id), i = Number(btn.dataset.i);
{
        const a = state.assembly;
        a.people = a.people.filter((p) => p.uid !== Number(btn.dataset.uid));
        a.picking = null;
        await refresh('draw');

      }
  },
  'asm-copy': async (btn) => {
    const id = Number(btn.dataset.id), i = Number(btn.dataset.i);
{
        const a = state.assembly;
        const src = a.people.find((p) => p.uid === Number(btn.dataset.uid));
        if (src) {
          const clone = makePerson(a.nextUid++, src.gender);
          clone.slots = JSON.parse(JSON.stringify(src.slots));
          a.people.push(clone);
        }
        await refresh('draw');

      }
  },
  'asm-gender': async (btn) => {
    const id = Number(btn.dataset.id), i = Number(btn.dataset.i);
{
        const p = state.assembly.people.find((x) => x.uid === Number(btn.dataset.uid));
        if (p) p.gender = btn.dataset.v;
        await refresh('draw');

      }
  },
  'asm-open': async (btn) => {
    const id = Number(btn.dataset.id), i = Number(btn.dataset.i);
        await asmOpenPicker(btn.dataset.scope, Number(btn.dataset.uid) || undefined,
          btn.dataset.key);

  },
  'asm-pick-pool': async (btn) => {
    const id = Number(btn.dataset.id), i = Number(btn.dataset.i);
        await asmPickPool(btn.dataset.v);

  },
  'asm-close': async (btn) => {
    const id = Number(btn.dataset.id), i = Number(btn.dataset.i);
state.assembly.picking = null; await refresh('draw');
  },
  'asm-portrait': async (btn) => {
    const id = Number(btn.dataset.id), i = Number(btn.dataset.i);
{
        // 有历史图 → 进概念详情页看全部（对比「这次出的像不像」）；还没图 → 直接开角色格
        const keys = String(btn.dataset.portrait || '').split(',').filter(Boolean);
        const hit = keys.find((k) => state.portraits[k] && state.portraits[k].found);
        if (hit) { location.hash = '#/concept/' + encodeURIComponent(hit); return; }
        await asmOpenPicker('person', Number(btn.dataset.uid) || undefined, 'role');

      }
  },
  'asm-mode': async (btn) => {
    const id = Number(btn.dataset.id), i = Number(btn.dataset.i);
await asmSetMode(btn.dataset.v);
  },
  'asm-pick': async (btn) => {
    const id = Number(btn.dataset.id), i = Number(btn.dataset.i);
await asmPick(btn.dataset.label, btn.dataset.tags);
      // 手填值：同一套锁定逻辑，只是 tags 不来自池子
  },
  'asm-free': async (btn) => {
    const id = Number(btn.dataset.id), i = Number(btn.dataset.i);
await asmPick(btn.dataset.v, btn.dataset.v, true);
  },
};
