// 抽卡工作台前端：原生 ES Modules，零框架、零构建。
import { api, jobStream, friendlyError } from './api.js';
import { esc, cut, slotChips } from './detail.js';
import { SAMPLERS, SCHEDULERS, profileDraft, tuningWorkflowHtml,
  settingsWorkflowHtml, modelExtraFields, tuningBody, settingsBody,
  loraPickerHtml } from './features/generation.js';
import {
  parseFilterSpec, addFilter, removeFilter, missingFilterSlots,
  filterChipsHtml, hotTagChipsHtml,
  poolOptionsHtml, tagOptionsHtml, normalizeLoras, loraOptionsHtml, loraRowsHtml,
  normalizeSlots, slotRowsHtml, slotPoolOptionsHtml,
  conceptCardsHtml, conceptKindChipsHtml, semanticCardsHtml, conceptStripHtml,
  coverPopoverHtml, conceptDetailHtml, ratingStarsHtml,
  PERSON_SLOTS, SCENE_SLOTS, makePerson, makeScene, countTagsFor,
  assemblyToDefinition, assemblyIsEmpty,
  splitTags, stripCountTags, portraitKeys, personTitle,
  dollFigureHtml, sceneStageHtml, DOLL_PARTS,
  rankPools, poolChipsHtml, poolSearchText,
  queryWords, matchQuery, quickFilterHtml,
} from './widgets.js';

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
const num = (v, d) => (v === '' || v === undefined || v === null ? d : Number(v));
const LAST_SESSION_KEY = 'gacha_last_session';
const FORM_KEY = 'gacha_draw_form';
const ASM_KEY = 'gacha_assembly_v2';   // v2：默认全关。旧 key 里的「默认随机」不能复活
let asmTimer = null;

const state = {
  recipes: [], profiles: [], pools: [], batches: [], jobs: [], images: [],
  config: {}, comfy: {}, models: {}, session: null, draws: [], warnings: [],
  currentView: 'draw', route: 'draw', editingRecipe: null, openPool: null,
  // 结果卡片内联状态：draw_id → 最新任务 / 已出图片（抽完即看，不必跳任务队列或画廊）
  drawJobs: {}, drawImages: {},
  // 参数预设就地编辑：高频调参不再占一个一级页面
  tuning: false, tuneDraft: null,
  // 设置页正在编辑的预设 id：null = 新建草稿。之前写死 profiles[0]，其余预设永远改不了
  settingsPid: null,
  gallery: { favorite: '', origin: '', min_rating: 0 },
  // 装配面板：人数 = 人物卡片张数，0 张即无人。所有格子默认关闭（白纸起步），
  // 用户主动打开哪格，哪格才进 prompt。
  assembly: {
    enabled: true,          // false = 改用配方模式（保留原有能力）
    tab: 'people',          // 'people' | 'scene'
    people: [makePerson(1)],
    scene: makeScene(),
    nextUid: 2,
    picking: null,          // {uid, key}：正在为哪一格的哪个人物挑条目（null 表示未展开）
    entries: [], entriesTotal: 0, entriesLoading: false,
    pickerPool: '', pickerQ: '', pickerPoolQ: '', pickerLocked: false,
  },
  // 意群双语补全的临时 UI 态：不进装配数据、不持久化。
  // 输入中/英文 → 候选 → 选中写英文 tag 到该意群的 extra。
  vocab: { ready: null, items: [], q: '', scope: '', uid: 0, open: false, loading: false },
  form: { recipe_id: '', pulls: 3, count: 1, seed: '', filter: '',
    gen_profile_id: '', filterMode: 'pool' },
  // 可选控件的编辑态：过滤构造器 / LoRA 列表 / 配方槽位表
  filterPool: null, filterTagQ: '', tagOptions: [], hotTags: [],
  loraDraft: [], slotsDraft: [],
  // 概念缩略图：数据库驱动的概念墙 + 本地语义检索（索引未构建时静默降级）
  concepts: { items: [], kinds: [], kind: '', q: '', image_count: 0, loaded: false },
  semantics: { ready: null, reason: '', items: [], q: '', mode: '' },
  conceptThumbMap: {},
  // 封面按需加载：按概念 key 缓存，新图产出后整体失效
  covers: { cache: {}, pending: {} },
  // 状态栏立绘：概念 key → 封面。与 covers 分开，立绘是常驻显示的，不走 hover 浮层。
  portraits: {},
  conceptPage: { key: '', label: '', kind: '', pool: '', items: [], total: 0, offset: 0 },
};

let toastTimer = null;
function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast ' + kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3600);
}
const fail = (e) => toast(friendlyError(e), 'err');
const done = (msg) => toast(msg, 'ok');

function setNav(v) {
  state.currentView = v;
  document.querySelectorAll('#nav button').forEach((b) =>
    b.classList.toggle('active', b.dataset.view === v));
}

function updateStatus() {
  const dot = $('#comfyDot'), text = $('#comfyText');
  if (!state.comfy.online) {
    dot.className = 'dot off'; text.textContent = 'ComfyUI 离线';
  } else if (state.comfy.mock) {
    dot.className = 'dot mock'; text.textContent = 'mock 模式（占位图）';
  } else {
    dot.className = 'dot on'; text.textContent = 'ComfyUI 在线';
  }
}

async function refreshBase() {
  const [recipes, profiles, pools, batches, config, comfy, jobs] = await Promise.all([
    api.get('/api/recipes'), api.get('/api/gen-profiles'), api.get('/api/pools'),
    api.get('/api/pools/batches'), api.get('/api/config'),
    api.get('/api/comfy/status'), api.get('/api/jobs'),
  ]);
  Object.assign(state, { recipes, profiles, pools, batches, config, comfy, jobs });
  updateStatus();
}

async function refreshStatusOnly() {
  try {
    state.comfy = await api.get('/api/comfy/status');
    state.config = await api.get('/api/config');
    updateStatus();
  } catch (_) { /* 状态灯静默 */ }
}

// ---------------- 抽卡台 ----------------
function drawForm() {
  const f = state.form;
  // 过滤的三种入口（池/tag、概念图、自然语言）共用同一块面板，避免互相滚到对角
  const mode = ['pool', 'concept', 'feel'].includes(f.filterMode) ? f.filterMode : 'pool';
  const sel = (a, b) => String(a ?? '') === String(b ?? '') ? 'selected' : '';
  const recipeOpts = state.recipes.map((r) =>
    `<option value="${r.id}" ${sel(r.id, f.recipe_id)}>${esc(r.name)}</option>`).join('');
  const profileOpts = state.profiles.map((p) =>
    `<option value="${p.id}" ${sel(p.id, f.gen_profile_id)}>${esc(p.name)} · ${esc(p.checkpoint || '未设模型')}</option>`).join('');
  // 左右排布：设置栏 sticky 常驻，结果在右栏；过滤与概念探索收在同一块面板里，
  // 选完条件主按钮就在下方，不用跨到另一栏去找。
  return `<div class="draw-shell">
    <aside class="draw-side">
    <div class="panel">
      <div class="panel-head"><h2>装配</h2>
        <span class="sub">${asmSummaryText()}</span></div>
      ${assemblyPanelHtml()}
      <details class="asm-alternate">
        <summary>改用配方抽卡 · 保留原有配方与过滤</summary>
        <div class="field" style="margin-top:10px"><span>配方</span><select id="dRecipe"><option value="" ${sel('', f.recipe_id)}>（不用配方 · 全池随机）</option>${recipeOpts}</select></div>
        <div class="field picker" style="margin-top:12px">
          <span>过滤 · 点选即可，无需打字</span>
          <div class="filter-tabs">
            <button type="button" class="chip hot${mode === 'pool' ? ' on' : ''}"
              data-act="filter-mode" data-v="pool">按池 / tag</button>
            <button type="button" class="chip hot${mode === 'concept' ? ' on' : ''}"
              data-act="filter-mode" data-v="concept">看图选概念</button>
            <button type="button" class="chip hot${mode === 'feel' ? ' on' : ''}"
              data-act="filter-mode" data-v="feel">一句话找画师</button>
          </div>
          ${filterPaneHtml(mode)}
          <div class="filter-chips" id="filterChips">${filterChipsHtml(f.filter)}</div>
          <div id="filterHintBox">${filterHintBoxHtml()}</div>
          <div class="row" style="margin-top:6px">
            <button class="btn small" data-act="filter-clear">清空条件</button>
            <span class="hint">已选条件在上方，点 × 删除</span>
          </div>
          <details class="advanced">
            <summary>高级：手动编辑过滤表达式 / 查看当前值</summary>
            <input type="text" id="dFilter" value="${esc(f.filter)}" placeholder="留空 = 全部卡池">
            <div class="hint">写法：<code>角色:fate</code> 只筛角色池；裸 <code>fate</code> 会筛掉所有不含它的池（画师/动作槽位可能变空）。大小写不敏感。填了过滤会<b>临时覆盖</b>配方槽位里的 filter；留空才按槽位 filter 抽。</div>
          </details>
        </div>
      </details>
      <div class="row" style="margin-top:12px">
        <div class="field"><span>连抽数</span><input type="number" id="dPulls" value="${esc(f.pulls)}" min="1" max="50"></div>
        <div class="field"><span>种子</span><input type="number" id="dSeed" value="${esc(f.seed)}" placeholder="留空随机"></div>
        <input type="hidden" id="dCount" value="1">
      </div>
      <div class="field" style="margin-top:10px"><span>生成参数预设</span>
        <div class="row">
          <select id="dProfile" style="flex:1;min-width:120px"><option value="" ${sel('', f.gen_profile_id)}>（跟随配方 / 默认）</option>${profileOpts}</select>
          <button class="btn small" data-act="tune-open">${state.tuning ? '收起调参' : '调参'}</button>
        </div>
        ${state.tuning ? tuningHtml() : ''}
      </div>
      <div class="row" style="margin-top:14px">
        <button class="btn primary" style="flex:1" data-act="draw-and-gen">抽卡并生图</button>
        <button class="btn" data-act="draw">只抽卡</button>
      </div>
      ${assemblyIsEmpty(state.assembly) ? `<p class="hint warn-text" style="margin:8px 0 0">
        装配全是「关闭」：这一抽会${state.form.recipe_id ? '按所选配方' : '从全部卡池随机'}执行。
        想控制内容，就打开左边任意一格（点部位 → 选条目，或点「随机」）。</p>` : ''}
      <div class="row" style="margin-top:8px">
        <button class="btn small" data-act="gen-all" ${state.draws.length ? '' : 'disabled'}>本批全部生图</button>
        ${state.draws.length ? '<button class="btn small" data-act="draw-clear">清空结果</button>' : ''}
      </div>
      <p class="hint" style="margin-bottom:0">人数 = 人物卡张数；锁定的格子每抽都不变，随机格每次重摇。同种子可复现。</p>
    </div>
    </aside>
    <section class="draw-main">
      ${state.warnings.length ? `<div class="panel warn-panel"><b>本次抽卡提示</b>
        ${state.warnings.map((w) => `<div class="hint warn-text" style="margin-top:6px">${esc(w)}</div>`).join('')}</div>` : ''}
      ${state.draws.length ? `<div class="panel-head"><h2>本批结果 · ${state.draws.length} 抽</h2>
        <span class="sub">会话 #${state.session?.session_id ?? '-'} · seed ${esc(state.session?.seed ?? '随机')}</span></div>
        <div class="cards">${state.draws.map(drawCard).join('')}</div>` :
        `<div class="panel"><div class="loading">调好参数后点「抽卡并生图」，抽到的图和生成进度都会出现在这里。</div></div>`}
    </section>
  </div>`;
}

// ---------------- 装配面板：场景 / 人物 ----------------
// 人数是「人物卡的张数」，不是开关：删卡就少一个人，0 张就是纯场景图。

function asmSummaryText() {
  const a = state.assembly;
  const n = a.people.length;
  const base = n ? `${n} 人 · ${countTagsFor(a.people)}` : '纯场景 · 无人物';
  // 全关是默认状态，必须写在标题上：否则「什么都没开」看起来像面板坏了
  if (assemblyIsEmpty(a)) return `${base} · 全关`;
  // 意群自由输入会真的进 prompt；不露头的话出图对不上
  const groups = [a.scene, ...a.people].filter((g) => g && String(g.extra || '').trim()).length;
  return groups ? `${base} · ${groups} 个意群带自定义词` : base;
}

function assemblyPanelHtml() {
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
function asmGroupInputHtml(scope, uid, label) {
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

/** 补全候选行：display 已是「主 · 对照」双语；data-en 是真正写入的英文。 */
function vocabSuggestHtml() {
  const v = state.vocab;
  if (v.loading) return '<div class="hint">查词表中…</div>';
  if (!v.q.trim()) return '<div class="hint">输入中文（黑发）或英文（silver hair）看候选</div>';
  if (!v.items.length) {
    return `<div class="hint">词表里没有「${esc(cut(v.q, 20))}」——回车可原样写一个英文 tag</div>`;
  }
  return v.items.map((x, i) => `<button type="button" class="vocab-item${i === 0 ? ' first' : ''}"
    data-act="vocab-pick" data-en="${esc(x.en)}" data-scope="${esc(v.scope)}" data-uid="${v.uid}"
    title="${esc(x.en)} = ${esc(x.zh)}｜点一下写进这个词群">
    <span class="vocab-en">${esc(cut(x.en, 34))}</span><span class="vocab-zh">${esc(cut(x.zh, 18))}</span>
  </button>`).join('');
}

/** 当前激活意群的对象（场景 / 某个人物）。 */
function vocabTarget(scope, uid) {
  if (scope === 'scene') return state.assembly.scene;
  return state.assembly.people.find((p) => p.uid === Number(uid)) || null;
}

/** 只刷候选容器与 chip 区，不重建输入框：打字时不能失焦。 */
function refreshVocabParts() {
  const v = state.vocab;
  const box = document.querySelector(`.vocab-suggest[data-scope="${v.scope}"][data-uid="${v.uid}"]`);
  if (box) {
    box.innerHTML = vocabSuggestHtml();
    box.hidden = !v.open;
  }
  const chosen = document.querySelector(`.vocab-chosen[data-scope="${v.scope}"][data-uid="${v.uid}"]`);
  const g = vocabTarget(v.scope, v.uid);
  if (g && chosen) {
    const words = String(g.extra || '').split(',').map((x) => x.trim()).filter(Boolean);
    chosen.innerHTML = words.map((w, i) => `<span class="vocab-chip" title="已选词，点 × 删除">${esc(cut(w, 30))}
      <button type="button" data-act="vocab-del" data-i="${i}" data-scope="${esc(v.scope)}" data-uid="${v.uid}">×</button></span>`).join('');
  }
}

let vocabTimer = null;
async function loadVocabSuggest() {
  const v = state.vocab;
  if (!v.q.trim()) { v.items = []; v.open = true; refreshVocabParts(); return; }
  v.loading = true; v.open = true;
  refreshVocabParts();
  try {
    const data = await api.get('/api/vocab/suggest?' + new URLSearchParams({ q: v.q, limit: 12 }));
    if (state.vocab !== v) return;           // 换意群了，丢弃旧响应
    v.items = data.items || []; v.ready = true;
  } catch (err) {
    if (state.vocab !== v) return;
    v.items = []; v.ready = false;
  } finally {
    if (state.vocab === v) v.loading = false;
  }
  refreshVocabParts();
}

/** 点候选 / 回车：把一个英文 tag 追加到该意群 extra，清空查询框。 */
function vocabAddWord(scope, uid, en) {
  const g = vocabTarget(scope, uid);
  const word = String(en || '').trim();
  if (!g || !word) return false;
  const words = String(g.extra || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!words.some((w) => w.toLowerCase() === word.toLowerCase())) words.push(word);
  g.extra = words.join(', ');
  state.vocab.q = ''; state.vocab.open = false; state.vocab.items = [];
  renderDraw().catch(fail);
  return true;
}

function asmSceneHtml() {
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

function asmPeopleHtml() {
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
function asmPersonCard(p, idx) {
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
function asmPartHtml(cfg, { label, key, uid, scope = 'person', open, side = '' }) {
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
function asmEntryRow(e, showPool) {
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

function asmEntriesHtml() {
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
function asmPickingKind() {
  const pk = state.assembly.picking;
  if (!pk) return '';
  const def = [...SCENE_SLOTS, ...PERSON_SLOTS].find((d) => d.key === pk.key);
  return def ? def.kind : '';
}

function asmCountHtml() {
  const a = state.assembly;
  const scope = a.pickerQ && !a.pickerLocked ? ' · 跨全部匹配池搜索' : '';
  return `共 ${a.entriesTotal || 0} 条${a.entriesTotal > 60 ? ' · 只显示前 60 条，用搜索缩小' : ''}${scope}`;
}

function asmPickerHtml(key) {
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
function asmFreeRowHtml() {
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
function asmPoolOptionsHtml(ranked, current, q = '') {
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
function refreshAsmPools() {
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

function asmCurrentCfg() {
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
async function asmOpenPicker(scope, uid, key) {
  const a = state.assembly;
  a.picking = { scope, uid, key };
  a.entries = []; a.entriesTotal = 0; a.pickerQ = '';
  a.pickerPoolQ = ''; a.pickerLocked = false;
  const def = [...SCENE_SLOTS, ...PERSON_SLOTS].find((d) => d.key === key);
  const best = rankPools(state.pools, def ? def.kind : '', key)
    .find((p) => Number(p.item_count || 0) > 0);
  a.pickerPool = best ? String(best.name) : '';
  await renderDraw();
  await asmLoadEntries();
}

/** 点池 chip：只换池，不重建输入框，保留搜索词与焦点。 */
async function asmPickPool(name) {
  const a = state.assembly;
  if (!a.picking) return;
  a.pickerPool = String(name || '');
  // 手动点过 chip = 明确要看这一池，搜索也不再跨池；点「全部」则解锁恢复跨池
  a.pickerLocked = !!a.pickerPool;
  await renderDraw();          // chip 高亮与下拉选中值都要跟着变
  await asmLoadEntries();
}

async function asmLoadEntries() {
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
async function asmSetMode(mode) {
  const cfg = asmCurrentCfg();
  if (!cfg) return;
  cfg.mode = mode;
  state.assembly.picking = null;
  await renderDraw();
}

/** 锁定到具体条目。锁角色时顺手按条目里的人数 tag 校正性别，避免 1girl + 男角色的冲突。 */
async function asmPick(label, tags, free = false) {
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
  await renderDraw();
}

/** 过滤的两种「看起来生效其实没有」的情况，输入时就地提示，不必等抽完。 */
function filterHintText() {
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

function updateFilterHint() {
  const box = $('#filterHintBox');
  if (box) box.innerHTML = filterHintBoxHtml();
}

/** 当前配方缺哪些槽位：缺得掉就顺手给一个「加进配方」的按钮。 */
function missingSlots() {
  const f = state.form;
  if (!f.recipe_id) return [];
  const recipe = state.recipes.find((r) => String(r.id) === String(f.recipe_id));
  return missingFilterSlots(f.filter, recipe, state.pools);
}

function filterHintBoxHtml() {
  const text = filterHintText();
  const fixable = missingSlots().length > 0;
  if (!text && !fixable) return '';
  return `${text ? `<div class="hint warn-text" id="filterHint">${esc(text)}</div>` : ''}
    ${fixable ? '<button class="btn small" data-act="fix-recipe">把缺的槽位加进配方</button>' : ''}`;
}

/** 把「配方没有对应槽位」的条件一步固定进配方：不用跳配方编辑器再手动选一遍池。 */
async function addFilterToRecipe() {
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

// ---------------- 通用概念缩略图：抽卡时先看图再选 ----------------
const FEEL_PRESETS = ['黄昏逆光、有点忧郁的校园少女', '厚涂暗色调',
  '萌系水彩治愈', '精致水光肌韩系'];
let conceptTimer = null;

function semanticHintHtml() {
  const s = state.semantics;
  if (s.ready === false) {
    return `<div class="hint">语义索引未就绪（${esc(s.reason || '尚未构建')}）· 下方数据库概念墙不受影响</div>`;
  }
  return '';
}

/** 过滤面板的三条输入路径：按池 / tag、看图选概念、一句话找画师。
 *  三者最终都写同一条过滤表达式，所以放在同一块面板里——选完主按钮就在下面几十像素，
 *  不用像之前那样在「左栏顶部过滤」和「右栏底部概念墙」之间来回滚。 */
function filterPaneHtml(mode) {
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
async function setFilterMode(mode) {
  if (!['pool', 'concept', 'feel'].includes(mode)) return;
  state.form.filterMode = mode;
  sessionStorage.setItem(FORM_KEY,
    JSON.stringify({ ...state.form, filterPool: state.filterPool }));
  await renderDraw();
  if (mode === 'concept' && !state.concepts.loaded) await loadConcepts();
}

// ---------------- 参数预设就地调参 ----------------
/** 展开前先把当前选中的预设读进草稿，避免打开就看到空表单。 */
async function openTuning() {
  if (state.tuning) { state.tuning = false; await renderDraw(); return; }
  if (!Array.isArray(state.models.checkpoints) || !state.models.checkpoints.length) {
    try { state.models = await api.get('/api/comfy/models'); } catch (_) { /* 离线时退回手填值 */ }
  }
  state.tuneDraft = profileDraft(state);
  state.tuning = true;
  await renderDraw();
}

function tuningHtml() {
  const t = state.tuneDraft || {};
  const cks = state.models.checkpoints || [];
  const ckOpts = (cks.length ? cks : (t.checkpoint ? [t.checkpoint] : []))
    .map((m) => `<option value="${esc(m)}" ${m === t.checkpoint ? 'selected' : ''}>${esc(m)}</option>`)
    .join('');
  const opt = (list, cur) => list.map((v) =>
    `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(v)}</option>`).join('');
  return `<div class="tune-box">
    <div class="field"><span>保存为预设名</span>
      <input type="text" id="tName" value="${esc(t.name || '默认参数')}"></div>
    ${tuningWorkflowHtml(state, t.workflow)}
    ${modelExtraFields(state, t.workflow, t)}
    <div class="field" style="margin-top:8px"><span>checkpoint</span>
      <div class="row">
        ${quickFilterHtml('tCheckpoint', '筛选 checkpoint', { width: 180 })}
        <select id="tCheckpoint" style="flex:1;min-width:180px">${ckOpts || '<option value="">（未读到模型列表，可先去设置页刷新）</option>'}</select>
      </div></div>
    <div class="row" style="margin-top:8px">
      <div class="field"><span>步数</span><input type="number" id="tSteps" value="${esc(t.steps)}" min="1" max="150"></div>
      <div class="field"><span>CFG</span><input type="number" id="tCfg" value="${esc(t.cfg)}" step="0.5" min="0" max="30"></div>
    </div>
    <div class="row" style="margin-top:8px">
      <div class="field"><span>宽</span><input type="number" id="tWidth" value="${esc(t.width)}" min="64" max="4096"></div>
      <div class="field"><span>高</span><input type="number" id="tHeight" value="${esc(t.height)}" min="64" max="4096"></div>
    </div>
    <div class="field" style="margin-top:8px"><span>采样器</span>
      <select id="tSampler">${opt(SAMPLERS, t.sampler)}</select></div>
    <div class="field" style="margin-top:8px"><span>调度器</span>
      <select id="tScheduler">${opt(SCHEDULERS, t.scheduler)}</select></div>
    <div class="field" style="margin-top:8px"><span>负向提示词</span>
      <textarea id="tNegative" style="min-height:48px">${esc(t.negative || '')}</textarea></div>
    <div class="hint">LoRA 仍在「设置」里调（列表太长，放这里会挤掉抽卡按钮）；当前已启用 ${(t.loras || []).length} 个。</div>
    <div class="row" style="margin-top:8px">
      <button class="btn small primary" data-act="tune-save">保存并应用</button>
    </div>
  </div>`;
}

/** 保存后立刻把表单指向这个预设，下一批抽卡就用新参数。 */
async function saveTuning() {
  const t = state.tuneDraft || {};
  const body = tuningBody(state);
  const name = body.name;
  const saved = await api.post('/api/gen-profiles', body);
  state.profiles = await api.get('/api/gen-profiles');
  state.form.gen_profile_id = String(saved.id);
  state.tuning = false;
  sessionStorage.setItem(FORM_KEY,
    JSON.stringify({ ...state.form, filterPool: state.filterPool }));
  await renderDraw();
  done(`参数已保存并应用：${saved.name} · ${saved.steps} 步 / CFG ${saved.cfg}`);
}

function syncConceptPanel() {
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
async function loadConcepts() {
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

// ---------------- 按需悬浮封面：一次只显示一张，按 key 缓存 ----------------
function hideCover(el) {
  const pop = el && el.querySelector ? el.querySelector('.cover-pop') : null;
  if (pop) pop.remove();
}

function paintCover(el, cover) {
  // coverActive 由进入时置位、离开时清除；异步请求返回时若已离开就不插入孤儿浮层
  if (!el || !el.isConnected || el.dataset.coverActive !== '1') return;
  hideCover(el);
  el.insertAdjacentHTML('beforeend', coverPopoverHtml(cover));
}

async function showCover(el) {
  if (!el || el.querySelector('.cover-pop')) return;
  const key = String(el.dataset.coverKey || '');
  if (!key) return;
  el.dataset.coverActive = '1';
  // 语义卡的外部风格锚点已随卡片给出，无需再打后端
  const direct = el.dataset.coverUrl;
  if (direct) {
    paintCover(el, {
      key, found: true, image_count: Number(el.dataset.coverCount || 0),
      image: { url: direct.startsWith('/api/') ? direct : '' },
    });
    return;
  }
  const cache = state.covers.cache;
  if (cache[key]) { paintCover(el, cache[key]); return; }
  if (state.covers.pending[key]) return;
  state.covers.pending[key] = true;
  try {
    const d = await api.get('/api/concepts/cover?' + new URLSearchParams({ key }));
    cache[key] = d;
    paintCover(el, d);
  } catch (_) {
    paintCover(el, { key, found: false });
  } finally {
    delete state.covers.pending[key];
  }
}

function onCoverOver(e) {
  const el = e.target.closest ? e.target.closest('[data-cover-key]') : null;
  if (!el || (e.relatedTarget && el.contains(e.relatedTarget))) return;
  showCover(el);
}

function onCoverOut(e) {
  const el = e.target.closest ? e.target.closest('[data-cover-key]') : null;
  if (!el || (e.relatedTarget && el.contains(e.relatedTarget))) return;
  delete el.dataset.coverActive;
  hideCover(el);
}

// ---------------- 画师样图浮层：名字判断不了画风，得看图 ----------------
// 条目列表在 `overflow:auto` 的小盒子里，浮层挂在行内会被裁掉，挂在 .draw-side
// （同样 overflow:auto）也会被裁。所以浮层单独挂在 body 上，用 position:fixed
// 按行的位置定位——滚列表时直接收起来，不做跟随（跟随要每帧算位置，不值）。
const THUMB_POP_W = 198;
const THUMB_POP_H = 224;
let thumbPop = null;

function thumbPopEl() {
  if (thumbPop && thumbPop.isConnected) return thumbPop;
  thumbPop = document.createElement('div');
  thumbPop.className = 'thumb-pop';
  thumbPop.hidden = true;
  document.body.appendChild(thumbPop);
  return thumbPop;
}

function showThumbPop(el) {
  const url = String(el.dataset.thumbUrl || '');
  if (!url) return;
  const pop = thumbPopEl();
  if (pop.dataset.url !== url) {
    pop.dataset.url = url;
    pop.innerHTML = `<img src="${esc(url)}" alt="${esc(el.dataset.thumbName || '画师')} 的风格样图">`;
  }
  pop.hidden = false;
  const r = el.getBoundingClientRect();
  // 优先放右栏外侧；右边没地方就翻到左边，再夹进视口，别跑出屏幕。
  let left = r.right + 10;
  if (left + THUMB_POP_W > window.innerWidth - 8) left = r.left - THUMB_POP_W - 10;
  left = Math.max(8, Math.min(left, window.innerWidth - THUMB_POP_W - 8));
  const top = Math.max(8, Math.min(r.top - 12, window.innerHeight - THUMB_POP_H - 8));
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;
}

function hideThumbPop() {
  if (!thumbPop) return;
  thumbPop.hidden = true;
  thumbPop.dataset.url = '';
}

function onThumbOver(e) {
  const el = e.target.closest ? e.target.closest('[data-thumb-url]') : null;
  if (el) showThumbPop(el);
}

function onThumbOut(e) {
  const el = e.target.closest ? e.target.closest('[data-thumb-url]') : null;
  if (!el || (e.relatedTarget && el.contains(e.relatedTarget))) return;
  hideThumbPop();
}

// ---------------- 状态栏立绘：常驻一张，按概念 key 缓存 ----------------
// 和 hover 浮层不同：立绘是状态栏的一部分，必须一直在，才能和右栏出的图并排比对。
async function loadPortrait(el) {
  if (!el || el.dataset.loaded === '1') return;
  const keys = String(el.dataset.portrait || '').split(',').filter(Boolean);
  el.dataset.loaded = '1';
  if (!keys.length) return;
  for (const key of keys) {
    if (!(key in state.portraits)) {
      try {
        state.portraits[key] = await api.get('/api/concepts/cover?'
          + new URLSearchParams({ key }));
      } catch (_) {
        state.portraits[key] = { key, found: false, image: null };
      }
    }
    const c = state.portraits[key];
    if (c && c.found && c.image && c.image.url) {
      paintPortrait(el, c);
      return;
    }
  }
  el.dataset.miss = '1';   // 这个角色还没出过图：留着占位，等第一次生成后长立绘
}

function paintPortrait(el, cover) {
  if (!el || !el.isConnected) return;
  el.classList.add('has-img');
  if (el.parentElement) el.parentElement.classList.add('has-art');
  // 立绘铺在小人底下当底图：虚线轮廓叠在照片上，还是能一眼看出哪块是什么。
  el.innerHTML = `<img src="${esc(cover.image.url)}" alt="${esc(el.dataset.title || '角色立绘')}"
      loading="lazy"><span class="doll-cap">立绘</span>`;
}

async function loadPortraits(root = view) {
  const els = [...root.querySelectorAll('.doll-art[data-portrait]')];
  await Promise.all(els.map((el) => loadPortrait(el).catch(() => {})));
}

/** 出了新图就重置立绘：同一个角色刚生成的图，可能正是它该显示的那张。 */
function resetPortraits() {
  state.portraits = {};
  document.querySelectorAll('.doll-art[data-portrait]').forEach((el) => {
    delete el.dataset.loaded;
    delete el.dataset.miss;
  });
  loadPortraits().catch(() => {});
}

// ---------------- 概念详情页：#/concept/<key>，首屏最多 50 张 ----------------
async function renderConceptPage(key) {
  const d = await api.get('/api/concepts/images?'
    + new URLSearchParams({ key, limit: '50', offset: '0' }).toString());
  state.conceptPage = {
    key, label: d.label || key, kind: d.kind || '', pool: d.pool || '',
    items: d.items || [], total: Number(d.total || 0), offset: 0,
  };
  view.innerHTML = conceptDetailHtml(state.conceptPage);
}

async function loadSemantics(q = '') {
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

async function loadSemanticsStatus() {
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

// ---------------- 点选控件：数据加载与局部刷新 ----------------
let tagTimer = null;
async function loadTagOptions(pool = state.filterPool, q = '', debounce = false) {
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

function syncTagControls() {
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
function setFilterSpec(spec) {
  state.form.filter = spec;
  const el = $('#dFilter');
  if (el) el.value = spec;
  syncTagControls();
  updateFilterHint();
  sessionStorage.setItem(FORM_KEY, JSON.stringify({ ...state.form, filterPool: state.filterPool }));
}

/** 把抽卡台表单当前值同步进 state，任何重绘都不再丢失选择。 */
function readDrawForm() {
  const get = (id) => $(id)?.value;
  if (get('#dRecipe') === undefined) return;
  state.form = {
    recipe_id: get('#dRecipe'), pulls: num(get('#dPulls'), 3),
    count: num(get('#dCount'), 1), seed: get('#dSeed'),
    filter: get('#dFilter'), gen_profile_id: get('#dProfile'),
  };
  const poolEl = $('#dFilterPool');
  if (poolEl) state.filterPool = poolEl.value;
  sessionStorage.setItem(FORM_KEY, JSON.stringify({ ...state.form, filterPool: state.filterPool }));
  updateFilterHint();
  const chips = $('#filterChips');
  if (chips) chips.innerHTML = filterChipsHtml(state.form.filter);
}

/** 刷新页面后连表单选择一起恢复，避免「刚填的过滤条件又没了」。 */
function restoreForm() {
  try {
    const raw = sessionStorage.getItem(FORM_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      state.form = { ...state.form, ...saved };
      if (saved.filterPool !== undefined) state.filterPool = saved.filterPool;
    }
  } catch (_) { /* 坏数据忽略，用默认表单 */ }
}

/** 结果卡：状态与图直接长在卡片上，抽完就能看到，不必跳任务队列或画廊。
 *  prompt 收进折叠区——3 抽并排时长 textarea 会把图挤出首屏。 */
/** 任务状态：一抽就是一张任务卡，徽标与描边都跟着它变，不用切页面看队列。 */
function questState(d) {
  const job = state.drawJobs[d.id];
  const imgs = state.drawImages[d.id] || [];
  if (imgs.length) return { key: 'done', text: '已完成' };
  if (!job) return { key: 'todo', text: '待生成' };
  const s = job.status;
  if (s === 'queued' || s === 'submitted') return { key: 'queued', text: '排队中' };
  if (s === 'running' || s === 'cancelling') {
    const pct = Math.max(0, Math.min(99, Number(job.progress) || 0));
    return { key: 'running', text: `生成中 ${pct}%` };
  }
  if (s === 'succeeded') return { key: 'running', text: '取图中' };
  return { key: s === 'cancelled' ? 'cancelled' : 'failed',
    text: s === 'cancelled' ? '已取消' : '失败' };
}

function drawCard(d) {
  const chips = slotChips(d.detail);
  const st = questState(d);
  const no = String(d.idx ?? 1).padStart(2, '0');
  const lockedN = (Array.isArray(d.detail) ? d.detail : [])
    .filter((x) => x && x.locked).length;
  return `<article class="quest" data-card="${d.id}" data-status="${st.key}">
    <header class="quest-head">
      <span class="quest-badge">${esc(no)}</span>
      <div class="quest-title">
        <b>第 ${esc(d.idx ?? '?')} 抽</b>
        <span class="quest-sub">seed ${esc(d.seed ?? '随机')} · #${esc(d.id)}</span>
      </div>
      <span class="quest-flag" data-flag-for="${d.id}">${esc(st.text)}</span>
    </header>
    <div class="card-state" data-state-for="${d.id}">${drawStateHtml(d)}</div>
    <details class="card-prompt">
      <summary>prompt 快照 · ${esc(cut(d.prompt, 52))}</summary>
      <textarea data-prompt="${d.id}" id="prompt_${d.id}">${esc(d.prompt)}</textarea>
      <div class="hint">编辑只影响复制，生图始终按抽卡时的快照执行（同 seed 可复现）。</div>
    </details>
    <div class="quest-loadout">
      <span class="quest-loadout-k">本抽装配${lockedN ? ` · ${lockedN} 项锁定` : ''}</span>
      <div class="tags">${chips || '<span class="hint">无槽位明细</span>'}</div>
      ${conceptStripHtml(d.detail, state.conceptThumbMap)}
    </div>
    <footer class="quest-foot">
      <button class="btn small" data-act="copy" data-id="${d.id}">复制 prompt</button>
      <button class="btn small" data-act="gen-one" data-id="${d.id}"
        data-force="1">${st.key === 'done' ? '再抽一版' : '生成此图'}</button>
    </footer>
  </article>`;
}

/** 一抽的状态区：待生成 / 排队 / 进度 / 已出图 / 失败重试，全部内联。 */
function drawStateHtml(d) {
  const job = state.drawJobs[d.id];
  const imgs = state.drawImages[d.id] || [];
  if (imgs.length) {
    const im = imgs[0];
    return `<div class="shot">
      <img class="shot-img" src="/api/images/${im.id}/thumb" loading="lazy"
        alt="第 ${d.idx} 抽的生成图" data-act="img-open" data-id="${im.id}">
      <div class="shot-ops">
        <button class="btn small" data-act="img-fav" data-id="${im.id}" data-draw="${d.id}"
          data-v="${im.favorite ? 0 : 1}">${im.favorite ? '★ 已收藏' : '☆ 收藏'}</button>
        <button class="btn small" data-act="gen-one" data-id="${d.id}" data-force="1">重跑</button>
        ${imgs.length > 1 ? `<span class="hint">同抽 ${imgs.length} 张</span>` : ''}
      </div>
    </div>`;
  }
  if (!job) {
    return `<div class="state-row"><span class="state">待生成</span>
      <button class="btn small primary" data-act="gen-one" data-id="${d.id}">生成此图</button></div>`;
  }
  if (job.status === 'queued' || job.status === 'submitted') {
    return `<div class="state-row"><span class="state running">排队中</span>
      <span class="hint">进度会在这里更新，不用切页面</span></div>`;
  }
  if (job.status === 'running' || job.status === 'cancelling') {
    const pct = Math.max(0, Math.min(99, Number(job.progress) || 0));
    return `<div class="state-row"><span class="state running">生成中 ${pct}%</span>
      <span class="hint">${job.step || 0}/${job.steps_total || 0} 步</span></div>
      <div class="bar"><i style="width:${pct}%"></i></div>`;
  }
  if (job.status === 'succeeded') {
    return `<div class="state-row"><span class="state succeeded">已完成</span>
      <span class="hint">正在取图…</span></div>`;
  }
  const cancelled = job.status === 'cancelled';
  return `<div class="state-row"><span class="state ${cancelled ? 'cancelled' : 'failed'}">${cancelled ? '已取消' : '失败'}</span>
    <button class="btn small" data-act="gen-one" data-id="${d.id}" data-force="1">重试</button></div>
    ${job.error_message ? `<div class="err-text">${esc(cut(job.error_message, 200))}</div>` : ''}`;
}

/** 只换状态区，不重建整张卡：编辑 prompt 时不会因为进度更新而失焦。 */
function updateDrawCard(id) {
  const did = Number(id);
  const card = document.querySelector(`[data-card="${did}"]`);
  const d = state.draws.find((x) => x.id === did);
  if (!card || !d) return;
  const box = card.querySelector('[data-state-for]');
  if (box) box.innerHTML = drawStateHtml(d);
  // 徽标与卡片描边一起刷新：状态变化要整张卡都在说同一件事
  const st = questState(d);
  card.dataset.status = st.key;
  const flag = card.querySelector('[data-flag-for]');
  if (flag) flag.textContent = st.text;
}

/** 局部重绘星级：不重建列表，评分时画廊不闪、滚动位置也不丢。 */
function paintStars(id, rating) {
  const cur = Math.max(0, Math.min(5, Number(rating) || 0));
  document.querySelectorAll(`[data-stars-for="${id}"]`).forEach((box) => {
    box.setAttribute('aria-label', `评分 ${cur} / 5`);
    box.querySelectorAll('.star').forEach((b, i) => {
      const n = i + 1;
      b.classList.toggle('on', n <= cur);
      b.dataset.v = n === cur ? 0 : n;
    });
  });
}

/** 批量拉状态：抽 3~8 张只打一个请求。 */
async function refreshDrawStates(ids) {
  const list = (ids || []).map(Number).filter((x) => x > 0);
  if (!list.length) return;
  const rows = await api.get('/api/draws/status?draw_ids=' + list.join(','));
  for (const row of rows || []) {
    if (row.job) state.drawJobs[row.draw_id] = row.job;
    if (Array.isArray(row.images) && row.images.length) {
      state.drawImages[row.draw_id] = row.images;
    }
  }
  if (state.route === 'draw') list.forEach(updateDrawCard);
}

async function renderDraw() {
  saveAssembly();
  view.innerHTML = drawForm();
  // 立绘异步补，不阻塞面板渲染；同一个 key 只请求一次（state.portraits 缓存）
  loadPortraits().catch(() => {});
}

/** 装配状态随抽卡台一起持久化：刷新 / 切视图回来不用重配一遍两个人物。 */
function saveAssembly() {
  const a = state.assembly;
  try {
    // 意群的 extra 已在 scene / people 对象里，无需单独存全局 extra
    sessionStorage.setItem(ASM_KEY, JSON.stringify({
      people: a.people, scene: a.scene, nextUid: a.nextUid, tab: a.tab,
    }));
  } catch (_) { /* 配额满或隐私模式：装配只是丢一次配置，不影响抽卡 */ }
}

function restoreAssembly() {
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

/** 刷新页面后恢复上一批抽卡结果（只读回显，不产生新数据）。
 *  优先用上次记录的会话；旧版前端没记录过，就回退到库里最近一批。
 *  「清空结果」写入 '0' 作为持久屏蔽标记。 */
async function restoreLastDraw() {
  const raw = sessionStorage.getItem(LAST_SESSION_KEY);
  if (raw === '0') return;
  try {
    let sid = Number(raw || 0);
    if (!sid) {
      const recent = await api.get('/api/draws?limit=1');
      sid = Array.isArray(recent) && recent.length ? Number(recent[0].session_id) : 0;
    }
    if (!sid) return;
    const [s, rows] = await Promise.all([
      api.get(`/api/draw-sessions/${sid}`),
      api.get(`/api/draws?session_id=${sid}`),
    ]);
    if (Array.isArray(rows) && rows.length) {
      state.session = { session_id: sid, seed: s?.seed };
      state.draws = rows;
    } else {
      sessionStorage.setItem(LAST_SESSION_KEY, '0');
    }
  } catch (_) {
    sessionStorage.setItem(LAST_SESSION_KEY, '0');
  }
}

async function doDraw({ generate = false } = {}) {
  readDrawForm();
  const f = state.form;
  // 装配优先：只要面板上有任何一格不是「关闭」，就用装配编译出的定义，
  // 此时忽略配方与过滤——两者同时生效会互相筛，静默变空最难排查。
  const useAssembly = !assemblyIsEmpty(state.assembly);
  const def = useAssembly ? assemblyToDefinition(state.assembly) : null;
  const body = {
    recipe_id: useAssembly ? null : num(f.recipe_id, null),
    definition: def,
    pulls: num(f.pulls, 3),
    count: 1,
    seed: num(f.seed, null),
    filter: useAssembly ? '' : String(f.filter || '').trim(),
    gen_profile_id: num(f.gen_profile_id, null),
  };
  const data = await api.post('/api/draw-sessions', body);
  state.session = data; state.draws = data.draws;
  state.warnings = data.warnings || [];
  // 新批次：清掉上一批的卡片状态，避免同 id 撞车显示旧图
  state.drawJobs = {}; state.drawImages = {};
  sessionStorage.setItem(LAST_SESSION_KEY, String(data.session_id));
  await renderDraw();
  if (generate && state.draws.length) {
    try {
      await submitJobs(state.draws.map((d) => d.id), { silent: true });
      done(`抽到 ${data.draws.length} 抽，已提交生图`);
    } catch (err) {
      fail(err);   // 生图提交失败不影响抽卡结果，卡片仍在「待生成」可单独重试
    }
  } else {
    done(`抽卡完成：${data.draws.length} 抽 / ${data.pool_count} 个池`);
  }
}

/** 提交生图。不再强制跳任务队列：状态与图回到结果卡片上，页面不离开。 */
async function submitJobs(ids, opts = {}) {
  const list = (ids || []).map(Number).filter((x) => x > 0);
  if (!list.length) return null;
  const profileId = num(state.form.gen_profile_id, null);
  const data = await api.post('/api/jobs', {
    draw_ids: list, gen_profile_id: profileId, force: !!opts.force,
  });
  // 本地先标排队，点完立刻有反馈；真实状态由 SSE / refreshDrawStates 覆盖
  list.forEach((did) => {
    state.drawJobs[did] = { ...(state.drawJobs[did] || {}),
      draw_id: did, status: 'queued', progress: 0 };
  });
  if (state.route === 'draw') list.forEach(updateDrawCard);
  if (!opts.silent) {
    done(`已提交 ${data.created.length} 个任务` +
      `${data.reused.length ? `，复用 ${data.reused.length} 个` : ''}`);
  }
  if (opts.gotoJobs) location.hash = '#jobs';
  return data;
}

// ---------------- 卡池管理 ----------------
async function renderPools() {
  const items = state.openPool ? await api.get(`/api/pools/${state.openPool}/items?q=`) : null;
  // data-qtext 里放「池名 + 类别 + 别名」：搜「艺术家」也要能搜到「画师图鉴」。
  const rows = state.pools.map((p) => `<tr data-qtext="${esc(poolSearchText(p))} ${esc(p.source || '')}">
    <td>${p.enabled ? '' : '<span class="chip">冷存</span>'}${esc(p.name)}</td>
    <td><span class="chip hl">${esc(p.kind)}</span></td><td>${p.item_count}</td>
    <td>${esc(p.source)}</td>
    <td><button class="btn small" data-act="pool-toggle" data-id="${p.id}" data-on="${p.enabled ? 0 : 1}">
      ${p.enabled ? '停用' : '启用'}</button>
      <button class="btn small" data-act="pool-items" data-id="${p.id}">条目</button></td></tr>`).join('');
  const batches = state.batches.map((b) => `<tr><td>#${b.id}</td><td>${esc(b.kind)}</td>
    <td>${b.item_count}</td><td class="sub">${esc(cut(b.source_path, 46))}</td>
    <td><button class="btn small danger" data-act="rollback" data-id="${b.id}">回滚</button></td></tr>`).join('');
  view.innerHTML = `<div class="panel">
    <div class="panel-head"><h2>卡池</h2><span class="sub">共 ${state.pools.length} 池 / ${state.pools.reduce((a, p) => a + p.item_count, 0)} 条</span></div>
    <div class="row" style="margin-bottom:10px">
      <input type="text" id="poolSearch" placeholder="搜索池名 / 类别" style="max-width:280px">
      <span class="hint">冷存池不参与抽卡，可手动启用</span>
    </div>
    <div class="scroll"><table id="poolTable"><thead><tr><th>名称</th><th>类别</th><th>条数</th><th>来源</th><th>操作</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
  </div>
  ${items ? `<div class="panel"><div class="panel-head"><h3>条目预览（前 ${items.items.length} / ${items.total}）</h3>
      <button class="btn small" data-act="pool-close">关闭</button></div>
      <div class="row" style="margin-bottom:8px">
        ${quickFilterHtml('poolItemList', '筛选条目：label / tags', { width: 999 })}
        <span class="hint" data-qf-count="poolItemList"></span></div>
      <div class="scroll" id="poolItemList">${items.items.map((i) => `<div class="chip" data-qtext="${esc(i.label)} ${esc(i.tags)}" style="display:block;margin-bottom:4px">
        ${esc(cut(i.label, 60))} <span class="sub">→ ${esc(cut(i.tags, 80))}</span></div>`).join('')}</div></div>` : ''}
  <div class="panel"><div class="panel-head"><h2>导入与批次</h2></div>
    <div class="row"><input type="text" id="importPath" placeholder="项目内相对路径，如 vendor/.../wildcards 或 my_pool.json" style="max-width:460px">
      <button class="btn" data-act="import">导入</button></div>
    <p class="hint">支持 .json（任意结构）、.csv（中文名,英文 tag）、目录（每个 .txt 一个词卡池）。重复导入会自动跳过同名池。</p>
    <div class="scroll" style="margin-top:10px"><table><thead><tr><th>批次</th><th>类型</th><th>条数</th><th>来源</th><th>操作</th></tr></thead>
      <tbody>${batches}</tbody></table></div>
  </div>`;
  $('#poolSearch').addEventListener('input', (e) => {
    const q = e.target.value;
    document.querySelectorAll('#poolTable tbody tr').forEach((tr) => {
      const text = tr.dataset.qtext || tr.textContent || '';
      tr.style.display = matchQuery(text, q) ? '' : 'none';
    });
  });
}

// ---------------- 配方编辑器 ----------------
function recipeForm() {
  const r = state.editingRecipe;
  const def = r?.definition || { fixed_head: 'masterpiece, best quality, 1girl', slots: [], template: '', fixed_tail: '' };
  return `<div class="field"><span>配方名</span><input type="text" id="rName" value="${esc(r?.name || '')}" placeholder="如 角色 × 风格"></div>
    <div class="field" style="margin-top:8px"><span>固定头部（质量词 / 主体）</span>
      <textarea id="rHead" style="min-height:56px">${esc(def.fixed_head || '')}</textarea></div>
    <div class="field picker" style="margin-top:12px"><span>槽位 · 点选配置，无需手写 JSON</span>
      <div id="slotRows">${slotRowsHtml(state.slotsDraft, state.pools, state.hotTags)}</div>
      <datalist id="slotTagList">${state.hotTags.map((x) =>
        `<option value="${esc(x.value)}"></option>`).join('')}</datalist>
      <div class="row" style="margin-top:8px">
        <button class="btn small" data-act="slot-add">＋ 添加槽位</button>
        <button class="btn small" data-act="slot-apply-json">读取下方 JSON</button></div>
      <div class="hint">槽位里的 tag 过滤只在抽卡台「按池过滤」<b>留空</b>时生效；表单填了过滤会以表单为准。</div>
      <details class="advanced"><summary>高级：直接编辑 / 粘贴槽位 JSON</summary>
        <textarea id="rSlots" style="min-height:110px">${esc(JSON.stringify(state.slotsDraft, null, 2))}</textarea>
        <div class="hint">改完点上方「读取下方 JSON」，保存时也会以这里的内容为准。</div></details>
    </div>
    <div class="field" style="margin-top:8px"><span>模板（__池名__ / __池名#3__ / __池名~__）</span>
      <div class="row" style="margin-bottom:6px">
        ${quickFilterHtml('rTplPool', '筛选池：输入片段', { width: 280 })}
        <span class="hint" data-qf-count="rTplPool"></span></div>
      <div class="row" style="margin-bottom:6px">
        <select id="rTplPool" style="max-width:280px">${slotPoolOptionsHtml(state.pools, '')}</select>
        <button class="btn small" data-act="tpl-insert">插入 __池名__</button></div>
      <textarea id="rTpl" style="min-height:56px">${esc(def.template || '')}</textarea></div>
    <div class="field" style="margin-top:8px"><span>固定尾部</span>
      <input type="text" id="rTail" value="${esc(def.fixed_tail || '')}"></div>`;
}

/** 只重绘槽位区，避免整页重绘把配方名 / 模板里未保存的输入清掉。 */
function refreshSlots() {
  const box = $('#slotRows');
  if (box) box.innerHTML = slotRowsHtml(state.slotsDraft, state.pools, state.hotTags);
  const ta = $('#rSlots');
  if (ta) ta.value = JSON.stringify(state.slotsDraft, null, 2);
  const dl = $('#slotTagList');
  if (dl) dl.innerHTML = state.hotTags.map((x) =>
    `<option value="${esc(x.value)}"></option>`).join('');
}

async function renderRecipes() {
  state.slotsDraft = normalizeSlots(
    state.editingRecipe?.definition?.slots ??
    [{ pool: '', count: 1, weight: 1, filter: '' }]);
  view.innerHTML = `<div class="grid-2">
    <div class="panel"><div class="panel-head"><h2>配方</h2>
      <button class="btn small" data-act="recipe-new">＋ 新建</button></div>
      ${state.recipes.map((r) => `<div class="row" style="justify-content:space-between;border-bottom:1px solid var(--line);padding:7px 0">
        <button class="btn small" data-act="recipe-select" data-id="${r.id}">${esc(r.name)}</button>
        <span class="sub">v${r.version}</span></div>`).join('') || '<p class="hint">暂无配方</p>'}
    </div>
    <div class="panel"><div class="panel-head"><h2>${state.editingRecipe ? '编辑' : '新建'}配方</h2>
      <div class="row"><button class="btn small" data-act="recipe-preview">预览 3 条</button>
        <button class="btn small primary" data-act="recipe-save">保存</button>
        ${state.editingRecipe ? `<button class="btn small danger" data-act="recipe-del">删除</button>` : ''}</div></div>
      ${recipeForm()}
      <div id="recipePreview" style="margin-top:12px"></div>
    </div></div>`;
}

function readRecipeForm() {
  // 可视化表格与高级 JSON 始终同步；用户手动改过 JSON 时以 JSON 为准，方便粘贴旧配方。
  let slots = normalizeSlots(state.slotsDraft);
  const raw = $('#rSlots')?.value;
  if (raw !== undefined) {
    let parsed;
    try { parsed = JSON.parse(raw || '[]'); }
    catch (e) { throw new Error('槽位 JSON 格式不对：' + e.message); }
    if (!Array.isArray(parsed)) throw new Error('槽位必须是数组');
    slots = normalizeSlots(parsed);
  }
  return {
    name: $('#rName').value.trim(),
    definition: {
      fixed_head: $('#rHead').value, fixed_tail: $('#rTail').value,
      template: $('#rTpl').value, slots,
    },
  };
}

// ---------------- 任务队列 ----------------
function jobsBody() {
  if (!state.jobs.length) return '<div class="loading">还没有生成任务</div>';
  return state.jobs.map((j) => `<div class="card" style="margin-bottom:10px">
    <div class="card-head"><b>任务 #${j.id} · 抽卡 #${j.draw_id}</b>
      <span class="state ${esc(j.status)}">${esc(j.status)} ${j.progress || 0}%</span></div>
    <div class="bar"><i style="width:${j.progress || 0}%"></i></div>
    <div class="row" style="margin-top:9px">
      <span class="hint">步数 ${j.step || 0}/${j.steps_total || 0} · 重试 ${j.retry_count || 0} · ${esc(j.created_at || '')}</span>
      ${['queued', 'submitted', 'running', 'cancelling'].includes(j.status)
        ? `<button class="btn small danger" data-act="job-cancel" data-id="${j.id}">取消</button>` : ''}
      ${['failed', 'dead', 'cancelled', 'succeeded'].includes(j.status)
        ? `<button class="btn small" data-act="job-retry" data-id="${j.id}">重新生成</button>` : ''}
    </div>
    ${j.error_message ? `<div class="err-text">${esc(cut(j.error_message, 260))}</div>` : ''}
  </div>`).join('');
}

async function renderJobs() {
  state.jobs = await api.get('/api/jobs');
  view.innerHTML = `<div class="panel"><div class="panel-head"><h2>生成任务</h2>
    <div class="row"><span class="sub" id="streamState">SSE 连接中…</span>
      <button class="btn small" data-act="job-refresh">刷新</button>
      <button class="btn small" data-act="goto-gallery">去画廊</button></div></div>
    <div id="jobsBody">${jobsBody()}</div></div>`;
}
const refreshJobsBody = () => { const el = $('#jobsBody'); if (el) el.innerHTML = jobsBody(); };

// ---------------- 画廊 ----------------
async function loadImages() {
  const g = state.gallery;
  const q = new URLSearchParams({ limit: '120' });
  if (g.favorite !== '') q.set('favorite', g.favorite);
  if (g.origin) q.set('origin', g.origin);
  if (g.min_rating) q.set('min_rating', String(g.min_rating));
  state.images = (await api.get('/api/images?' + q.toString())).items;
}

function galleryTiles() {
  if (!state.images.length) return '<div class="loading">还没有图片。生成任务完成后会出现在这里；也可在下方注册历史图鉴目录。</div>';
  return state.images.map((im) => `<div class="tile">
    <img src="/api/images/${im.id}/thumb" alt="图片 ${im.id}" data-act="img-open" data-id="${im.id}">
    <div class="meta">#${im.id} · ${esc(im.origin)} · ${im.width}×${im.height}<br>
      ${esc(cut(im.meta?.prompt || im.meta?.name || '', 46))}</div>
    <div class="ops">
      <button class="btn small" data-act="img-fav" data-id="${im.id}" data-v="${im.favorite ? 0 : 1}">${im.favorite ? '★ 已收藏' : '☆ 收藏'}</button>
      ${ratingStarsHtml(im.id, im.rating)}
      ${im.meta?.draw_id ? `<button class="btn small" data-act="img-rerun" data-id="${im.id}">同参重跑</button>` : ''}
    </div></div>`).join('');
}

async function renderGallery() {
  await loadImages();
  view.innerHTML = `<div class="panel"><div class="panel-head"><h2>画廊</h2>
    <span class="sub">${state.images.length} 张 · 生成图与画师图鉴已合并</span></div>
    <div class="row" style="margin-bottom:12px">
      <select id="gFav" style="max-width:150px">
        <option value="">全部</option><option value="true">仅收藏</option><option value="false">未收藏</option></select>
      <select id="gOrigin" style="max-width:160px">
        <option value="">全部来源</option><option value="generated">生成图</option><option value="gallery">图鉴注册</option></select>
      <select id="gRating" style="max-width:140px">
        <option value="0">不限评分</option><option value="3">3 分以上</option><option value="4">4 分以上</option></select>
      <button class="btn small" data-act="gallery-export">导出元数据</button>
    </div>
    <div class="gallery" id="galleryGrid">${galleryTiles()}</div></div>
  <div class="panel"><div class="panel-head"><h2>并入历史画师图鉴</h2></div>
    <div class="row"><input type="text" id="galleryDir" placeholder="项目内图片目录，如 artist_style_test_20260526" style="max-width:440px">
      <button class="btn" data-act="gallery-scan">扫描并注册</button></div>
    <p class="hint">只读扫描，不移动原图；注册后缩略图会显示在上方画廊。历史目录不存在时请先确认路径。</p></div>`;
  $('#gFav').value = state.gallery.favorite;
  $('#gOrigin').value = state.gallery.origin;
  $('#gRating').value = String(state.gallery.min_rating);
}

function openLightbox(id) {
  // 抽卡台的图不在 state.images 里，先从结果卡缓存找一遍，找不到也照样打开原图
  const im = state.images.find((x) => x.id === id)
    || Object.values(state.drawImages).flat().find((x) => x.id === id);
  $('#lightboxImg').src = `/api/images/${id}/file`;
  const parts = [`#${id}`];
  if (im?.width) parts.push(`${im.width}×${im.height}`);
  const desc = im?.meta?.prompt || im?.meta?.name || '';
  if (desc) parts.push(desc);
  if (im?.meta?.seed !== undefined && im?.meta?.seed !== null) parts.push(`seed ${im.meta.seed}`);
  $('#lightboxInfo').textContent = parts.join(' · ');
  $('#lightbox').hidden = false;
}

// ---------------- 设置 ----------------
function refreshLoraRows() {
  const box = $('#loraRows');
  if (box) box.innerHTML = loraRowsHtml(state.loraDraft);
  const pick = $('#pLoraPick');
  if (pick) {
    const keep = pick.value;
    pick.innerHTML = loraOptionsHtml(state.models.loras || [], state.loraDraft);
    pick.value = keep;
  }
}

async function renderSettings() {
  // 模型列表只在为空时才拉：ComfyUI /object_info 可能要几十秒，
  // 每次切预设 / 保存都重拉会让表单冻结在那儿，看起来像「点了没反应」。
  // 想手动刷新模型列表（新装了 LoRA / 换了 checkpoint）用左栏「刷新状态」。
  if (!Array.isArray(state.models?.checkpoints) || !state.models.checkpoints.length) {
    try { state.models = await api.get('/api/comfy/models'); } catch (_) { state.models = {}; }
  }
  // 只编辑选中的那条；删掉/新建后指向有效条目。之前写死 profiles[0]。
  state.settingsPid = state.profiles.some((x) => x.id === state.settingsPid)
    ? state.settingsPid : (state.profiles[0]?.id ?? null);
  const p = state.profiles.find((x) => x.id === state.settingsPid) || {};
  const c = state.config;
  state.loraDraft = normalizeLoras(p.loras || []);
  const models = (state.models.checkpoints || []).map((m) =>
    `<option value="${esc(m)}" ${m === p.checkpoint ? 'selected' : ''}>${esc(m)}</option>`).join('');
  // 模型枚举来自 ComfyUI；当前预设值即使不在枚举里也保留，避免换机器后被迫改配置。
  const opts = (list, cur) => {
    const arr = (Array.isArray(list) ? list : []).map(String);
    if (cur && !arr.includes(String(cur))) arr.unshift(String(cur));
    return arr.map((v) => `<option value="${esc(v)}" ${String(v) === String(cur ?? '') ? 'selected' : ''}>${esc(v)}</option>`).join('');
  };
  view.innerHTML = `<div class="grid-2">
    <div class="panel"><div class="panel-head"><h2>运行环境</h2>
      <button class="btn small" data-act="comfy-refresh">刷新状态</button></div>
      <div class="kv">
        <span>服务地址</span><span>${esc(c.host)}:${esc(c.port)}</span>
        <span>ComfyUI</span><span>${esc(c.comfy_url)} · ${state.comfy.online ? (state.comfy.mock ? 'mock 模式' : '在线') : '离线'}</span>
        <span>数据库</span><span>${esc(c.db_path)}</span>
        <span>输出目录</span><span>${esc(c.outputs_dir)}</span>
        <span>词卡目录</span><span>${esc(c.wildcards_dir)} ${c.wildcards_ready ? '✓' : '（缺失）'}</span>
        <span>workflow 模板</span><span>${esc((c.workflows || []).join(', '))}</span>
        <span>认证</span><span>${c.auth_required ? '需令牌' : '免登录（仅本机）'}</span>
      </div>
      <p class="hint">${state.comfy.mock
        ? '当前为 mock 模式：生图返回占位图，用于离线验证链路。把 .env 里 GACHA_COMFY_MOCK 改为 0 并重启即可真实出图。'
        : '真实出图需要本机 ComfyUI 运行在 8188，且所选 checkpoint 在 /object_info 列表中。'}</p>
      <div class="field" style="margin-top:8px"><span>访问令牌（仅当 .env 设置 GACHA_TOKEN 时才需要）</span>
        <div class="row"><input type="text" id="pToken" placeholder="留空 = 免登录"
          value="${esc(localStorage.getItem('gacha_token') || '')}" style="max-width:320px">
          <button class="btn small" data-act="token-save">保存令牌</button></div></div>
    </div>
    <div class="panel"><div class="panel-head"><h2>生成参数预设</h2>
      <span class="sub">保存后新抽卡会话生效</span></div>
      <div class="row" style="margin-bottom:10px">
        <select id="pPick" style="flex:1;min-width:150px">${state.profiles.map((x) =>
          `<option value="${esc(x.id)}" ${x.id === p.id ? 'selected' : ''}>${esc(x.name)} · #${x.id}</option>`).join('')
          || '<option value="">（还没有预设）</option>'}</select>
        <button class="btn small" data-act="profile-new">＋ 新建</button>
        <button class="btn small danger" data-act="profile-del" ${p.id ? '' : 'disabled'}
          title="${esc(p.name || '')}">删除</button>
      </div>
      <div class="field"><span>预设名</span><input type="text" id="pName"
        value="${esc(p.name || (p.id ? '默认 SDXL' : '新预设'))}"></div>
      ${settingsWorkflowHtml(state, p.workflow)}
      ${modelExtraFields(state, p.workflow, p)}
      <div class="field" style="margin-top:8px"><span>Checkpoint · 点选，来自 ComfyUI /object_info</span>
        <div class="row">
          ${quickFilterHtml('pCheckpoint', '筛选 checkpoint：如 sdxl / wai', { width: 200 })}
          <select id="pCheckpoint" style="flex:1;min-width:210px"><option value="">（留空 = ComfyUI 默认）</option>${models}</select>
          <span class="hint" data-qf-count="pCheckpoint"></span>
        </div>
        <details class="advanced"><summary>手动填写 ckpt 文件名（一般不需要）</summary>
          <input type="text" id="pCheckpointFree" placeholder="或手动填写 ckpt 文件名"
            value="${esc(p.checkpoint || '')}"></details></div>
      <div class="row" style="margin-top:8px">
        <div class="field"><span>步数</span><input type="number" id="pSteps" value="${p.steps || 20}"></div>
        <div class="field"><span>CFG</span><input type="number" id="pCfg" step="0.5" value="${p.cfg || 6}"></div>
        <div class="field"><span>宽</span><input type="number" id="pWidth" value="${p.width || 1024}"></div>
        <div class="field"><span>高</span><input type="number" id="pHeight" value="${p.height || 1360}"></div>
      </div>
      <div class="row" style="margin-top:8px">
        <div class="field"><span>采样器</span><select id="pSampler">${opts(state.models.samplers || [], p.sampler || 'euler_ancestral')}</select></div>
        <div class="field"><span>调度器</span><select id="pScheduler">${opts(state.models.schedulers || [], p.scheduler || 'normal')}</select></div>
      </div>
      <div class="field" style="margin-top:8px"><span>负向提示词</span>
        <input type="text" id="pNegative" value="${esc(p.negative || '')}"></div>
      ${loraPickerHtml(state)}
      <div class="row" style="margin-top:12px"><button class="btn primary" data-act="profile-save">保存预设</button></div>
    </div></div>`;
}

// ---------------- 快速筛选：一个 input 让长列表就地变短 ----------------
// 一个处理器服务所有落点：select 隐藏不匹配的 option；普通容器隐藏不匹配的子项。
// 输入即过滤，Enter 直接选中第一个匹配项，Esc 清空 —— 「筛 → 选 → 重来」三种键盘动作，
// 鼠标用户照旧点。落点见设置页（LoRA / checkpoint）、调参抽屉、抽卡装配、配方模板池。
function applyQuickFilter(el, q) {
  if (!el) return 0;
  const words = queryWords(q);
  let shown = 0;
  if (el.tagName === 'SELECT') {
    for (const o of el.options) {
      const hit = !words.length || matchQuery(`${o.textContent} ${o.value}`, q);
      // 当前值永远留着：隐藏它会让用户以为预设是空的，保存时还以为丢了
      o.hidden = !(hit || (o.value && o.value === el.value));
      if (hit) shown += 1;
    }
    el.querySelectorAll('optgroup').forEach((g) => {
      g.hidden = ![...g.children].some((o) => !o.hidden);
    });
    // 还没选过东西时自动落在第一个命中项：筛「neg」下拉直接停在 neg4all…，
    // 不用再点开确认。已有选择的场合不抢（Enter 才是明确的「就选这个」）。
    if (!el.value) {
      const hit = [...el.options].find((o) => !o.hidden && o.value);
      if (hit) el.value = hit.value;
    }
  } else {
    for (const k of el.querySelectorAll('[data-qtext]')) {
      const hit = !words.length || matchQuery(k.dataset.qtext || k.textContent, q);
      k.hidden = !hit;
      if (hit) shown += 1;
    }
  }
  return shown;
}

/** 筛选框右侧的小计数：「12 项」，清空后消失，不占常驻空间。 */
function setQfCount(targetId, n, q) {
  const box = document.querySelector(`[data-qf-count="${targetId}"]`);
  if (box) box.textContent = String(q || '').trim() ? `${n} 项` : '';
}

function onQuickFilterInput(t) {
  const el = document.getElementById(t.dataset.qf);
  setQfCount(t.dataset.qf, applyQuickFilter(el, t.value), t.value);
}

function onQuickFilterKey(t, e) {
  const el = document.getElementById(t.dataset.qf);
  if (e.key === 'Escape') {
    t.value = '';
    setQfCount(t.dataset.qf, applyQuickFilter(el, ''), '');
    return;
  }
  if (e.key !== 'Enter' || !el || el.tagName !== 'SELECT') return;
  // 回车即选定第一个匹配项：`neg` + Enter 就落定，不用再点开下拉找
  const hit = [...el.options].find((o) => !o.hidden && o.value);
  if (!hit) return;
  e.preventDefault();
  if (el.value !== hit.value) {
    el.value = hit.value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

function onKeydown(e) {
  const t = e.target;
  if (!t.dataset) return;
  if (t.dataset.qf) { onQuickFilterKey(t, e); return; }
  if (t.dataset.act === 'asm-q' && e.key === 'Enter') {
    // 回车立刻搜，不等防抖：`black h` + Enter = 直接看到 black hair
    clearTimeout(asmTimer);
    state.assembly.pickerQ = t.value;
    asmLoadEntries();
  }
  if (t.dataset.act === 'asm-extra') {
    if (e.key === 'Escape') {
      state.vocab.open = false; renderDraw().catch(fail); return;
    }
    if (e.key === 'Enter') {
      clearTimeout(vocabTimer);
      // 有候选 → 选第一个；没有候选但输入了英文 → 原样写入（逃生口）；
      // 没有候选且是中文 → 提示换词，绝不把中文写进 prompt。
      const v = state.vocab;
      if (v.items && v.items.length) {
        vocabAddWord(v.scope, v.uid, v.items[0].en);
        done(`已加入「${v.items[0].en}」（${v.items[0].zh}）`);
      } else {
        const q = t.value.trim();
        if (!q) return;
        if (/[\u4e00-\u9fff]/.test(q)) {
          toast('词表里没有这个词，换一个或改用英文 tag');
          return;
        }
        vocabAddWord(v.scope, v.uid, q);
        done(`已原样加入「${q}」`);
      }
    }
  }
}

// ---------------- 事件 ----------------
async function onClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act, id = Number(btn.dataset.id), i = Number(btn.dataset.i);
  try {
    switch (act) {
      case 'draw-and-gen': await doDraw({ generate: true }); break;
      case 'draw': await doDraw(); break;
      // --- 装配面板：场景 / 人物。人数 = 人物卡张数 ---
      case 'asm-tab': state.assembly.tab = btn.dataset.v; await renderDraw(); break;
      case 'asm-add': {
        const a = state.assembly;
        a.people.push(makePerson(a.nextUid++));
        a.tab = 'people';
        await renderDraw();
        break;
      }
      case 'asm-del': {
        const a = state.assembly;
        a.people = a.people.filter((p) => p.uid !== Number(btn.dataset.uid));
        a.picking = null;
        await renderDraw();
        break;
      }
      case 'asm-copy': {
        const a = state.assembly;
        const src = a.people.find((p) => p.uid === Number(btn.dataset.uid));
        if (src) {
          const clone = makePerson(a.nextUid++, src.gender);
          clone.slots = JSON.parse(JSON.stringify(src.slots));
          a.people.push(clone);
        }
        await renderDraw();
        break;
      }
      case 'asm-gender': {
        const p = state.assembly.people.find((x) => x.uid === Number(btn.dataset.uid));
        if (p) p.gender = btn.dataset.v;
        await renderDraw();
        break;
      }
      case 'asm-open':
        await asmOpenPicker(btn.dataset.scope, Number(btn.dataset.uid) || undefined,
          btn.dataset.key);
        break;
      case 'asm-pick-pool':
        await asmPickPool(btn.dataset.v);
        break;
      case 'asm-close': state.assembly.picking = null; await renderDraw(); break;
      case 'asm-portrait': {
        // 有历史图 → 进概念详情页看全部（对比「这次出的像不像」）；还没图 → 直接开角色格
        const keys = String(btn.dataset.portrait || '').split(',').filter(Boolean);
        const hit = keys.find((k) => state.portraits[k] && state.portraits[k].found);
        if (hit) { location.hash = '#/concept/' + encodeURIComponent(hit); break; }
        await asmOpenPicker('person', Number(btn.dataset.uid) || undefined, 'role');
        break;
      }
      case 'asm-mode': await asmSetMode(btn.dataset.v); break;
      case 'asm-pick': await asmPick(btn.dataset.label, btn.dataset.tags); break;
      // 手填值：同一套锁定逻辑，只是 tags 不来自池子
      case 'asm-free': await asmPick(btn.dataset.v, btn.dataset.v, true); break;
      case 'vocab-pick': {
        vocabAddWord(btn.dataset.scope, btn.dataset.uid, btn.dataset.en);
        done(`已加入「${btn.dataset.en}」`);
        break;
      }
      case 'vocab-del': {
        const g = vocabTarget(btn.dataset.scope, btn.dataset.uid);
        if (g) {
          const words = String(g.extra || '').split(',').map((x) => x.trim()).filter(Boolean);
          words.splice(Number(btn.dataset.i), 1);
          g.extra = words.join(', ');
          await renderDraw();
        }
        break;
      }
      // --- 过滤构造器：三种输入方式共用一条表达式，全程点选 ---
      case 'filter-mode': await setFilterMode(btn.dataset.v); break;
      case 'tune-open': await openTuning(); break;
      case 'tune-save': await saveTuning(); break;
      case 'filter-add': {
        // 搜索框里手打的优先于下拉选中项；加完清空并把候选恢复成热门。
        const tag = $('#dFilterTagQ')?.value.trim() || $('#dFilterTag')?.value;
        if (!tag) throw new Error('先选一个 tag，或点下方热门 tag');
        setFilterSpec(addFilter(state.form.filter, state.filterPool, tag));
        const q = $('#dFilterTagQ'); if (q) q.value = '';
        state.filterTagQ = '';
        loadTagOptions(state.filterPool, '');
        done(`已添加过滤：${state.filterPool ? state.filterPool + ':' : ''}${tag}`); break;
      }
      case 'filter-hot':
        setFilterSpec(addFilter(state.form.filter, state.filterPool, btn.dataset.v)); break;
      case 'filter-del':
        setFilterSpec(removeFilter(state.form.filter, i)); break;
      case 'filter-clear':
        setFilterSpec(''); syncConceptPanel(); break;
      case 'fix-recipe': await addFilterToRecipe(); break;
      // --- 通用概念缩略图：点图即选，沿用已有过滤构造器 ---
      case 'concept-pick':
        setFilterSpec(addFilter(state.form.filter, btn.dataset.pool || '', btn.dataset.v));
        syncConceptPanel();
        done(`已加入过滤：${(btn.dataset.pool ? btn.dataset.pool + ':' : '') + btn.dataset.v}`);
        break;
      case 'concept-kind':
        state.concepts.kind = btn.dataset.v || '';
        syncConceptPanel(); await loadConcepts(); break;
      case 'concept-refresh':
        await loadConcepts(); done('概念墙已刷新'); break;
      case 'concept-back':
        location.hash = '#draw'; break;
      case 'concept-more': {
        const p = state.conceptPage;
        const d = await api.get('/api/concepts/images?' + new URLSearchParams({
          key: p.key, limit: '50', offset: String(p.items.length),
        }).toString());
        p.items = p.items.concat(d.items || []);
        p.total = Number(d.total || p.total);
        view.innerHTML = conceptDetailHtml(p);
        break;
      }
      case 'img-rate':
      case 'img-fav': {
        const body = act === 'img-rate' ? { rating: Number(btn.dataset.v) }
          : { favorite: btn.dataset.v === '1' };
        await api.patch('/api/images/' + id, body);
        state.covers.cache = {};   // 评分 / 收藏会改变封面，缓存必须失效
        const rating = act === 'img-rate' ? Number(btn.dataset.v) : null;
        const fav = act === 'img-fav' ? btn.dataset.v === '1' : null;

        if (state.route === 'concept') {
          const item = state.conceptPage.items.find((x) => x.id === id);
          if (item) {
            if (rating !== null) item.rating = rating;
            if (fav !== null) item.favorite = fav;
          }
          view.innerHTML = conceptDetailHtml(state.conceptPage);
        } else {
          const lists = state.route === 'gallery'
            ? [state.images] : Object.values(state.drawImages);
          for (const list of lists) {
            const im = list.find((x) => x.id === id);
            if (!im) continue;
            if (rating !== null) im.rating = rating;
            if (fav !== null) im.favorite = fav;
          }
          // 局部更新，不重绘整页：画廊的滚动位置与已加载的图都不会丢
          if (rating !== null) paintStars(id, rating);
          if (fav !== null) {
            document.querySelectorAll(`[data-act="img-fav"][data-id="${id}"]`).forEach((b) => {
              b.dataset.v = fav ? 0 : 1;
              b.textContent = fav ? '★ 已收藏' : '☆ 收藏';
            });
          }
          const did = Number(btn.dataset.draw);
          if (state.route === 'draw' && did) updateDrawCard(did);
        }
        done(act === 'img-rate' ? '评分已保存' : '收藏已更新');
        break;
      }
      case 'feel-chip': {
        const el = $('#semanticQ'); if (el) el.value = btn.dataset.v;
        await loadSemantics(btn.dataset.v); break;
      }
      case 'semantic-go':
        await loadSemantics($('#semanticQ')?.value.trim() || ''); break;
      case 'semantic-clear': {
        const el = $('#semanticQ'); if (el) el.value = '';
        await loadSemantics(''); break;
      }
      case 'semantic-pick':
        setFilterSpec(addFilter(state.form.filter, '画师', btn.dataset.v));
        syncConceptPanel();
        done(`已按画师过滤：${btn.dataset.v}`); break;
      case 'draw-clear':
        state.draws = []; state.session = null; state.warnings = [];
        sessionStorage.setItem(LAST_SESSION_KEY, '0');
        await renderDraw(); break;
      case 'gen-all': await submitJobs(state.draws.map((d) => d.id)); break;
      case 'gen-one': await submitJobs([id]); break;
      case 'copy': {
        const el = $(`#prompt_${id}`);
        await navigator.clipboard.writeText(el.value);
        done('已复制 prompt'); break;
      }
      case 'pool-toggle':
        await api.put(`/api/pools/${id}`, { enabled: btn.dataset.on === '1' });
        state.pools = await api.get('/api/pools'); await renderPools(); break;
      case 'pool-items': state.openPool = id; await renderPools(); break;
      case 'pool-close': state.openPool = null; await renderPools(); break;
      case 'import': {
        const path = $('#importPath').value.trim();
        if (!path) throw new Error('请填写导入路径');
        const r = await api.post('/api/pools/import', { path });
        state.pools = await api.get('/api/pools');
        state.batches = await api.get('/api/pools/batches');
        done(`导入完成：${r.pools} 池 / ${r.items} 条`); await renderPools(); break;
      }
      case 'rollback':
        await api.del(`/api/pools/batches/${id}`);
        state.pools = await api.get('/api/pools');
        state.batches = await api.get('/api/pools/batches');
        done('批次已回滚'); await renderPools(); break;
      case 'recipe-new': state.editingRecipe = null; await renderRecipes(); break;
      case 'recipe-select':
        state.editingRecipe = state.recipes.find((r) => r.id === id) || null;
        await renderRecipes(); break;
      case 'recipe-save': {
        const body = readRecipeForm();
        if (!body.name) throw new Error('配方名不能为空');
        const url = state.editingRecipe ? `/api/recipes/${state.editingRecipe.id}` : '/api/recipes';
        await (state.editingRecipe ? api.put(url, body) : api.post(url, body));
        state.recipes = await api.get('/api/recipes');
        state.editingRecipe = null; done('配方已保存'); await renderRecipes(); break;
      }
      case 'recipe-del':
        await api.del(`/api/recipes/${id}`);
        state.recipes = await api.get('/api/recipes');
        state.editingRecipe = null; done('配方已删除'); await renderRecipes(); break;
      case 'recipe-preview': {
        const body = readRecipeForm();
        const res = await api.post('/api/recipes/preview?pulls=3', body.definition);
        $('#recipePreview').innerHTML = '<h3>预览</h3>' + res.map((r, i) =>
          `<div class="chip" style="display:block;margin-bottom:6px">[${i + 1}] ${esc(cut(r.prompt, 220))}</div>`).join('');
        break;
      }
      // --- 配方槽位：可视化表格，局部刷新避免清掉未保存的其它字段 ---
      case 'slot-add':
        state.slotsDraft.push({ pool: '', count: 1, weight: 1, filter: '' });
        refreshSlots(); break;
      case 'slot-del': state.slotsDraft.splice(i, 1); refreshSlots(); break;
      case 'slot-up': case 'slot-down': {
        const j = act === 'slot-up' ? i - 1 : i + 1;
        if (j < 0 || j >= state.slotsDraft.length) break;
        [state.slotsDraft[i], state.slotsDraft[j]] = [state.slotsDraft[j], state.slotsDraft[i]];
        refreshSlots(); break;
      }
      case 'slot-apply-json': {
        const parsed = JSON.parse($('#rSlots').value || '[]');
        if (!Array.isArray(parsed)) throw new Error('槽位必须是数组');
        state.slotsDraft = normalizeSlots(parsed);
        refreshSlots(); done(`已读取 ${state.slotsDraft.length} 个槽位`); break;
      }
      case 'tpl-insert': {
        const pool = $('#rTplPool')?.value;
        if (!pool) throw new Error('先选一个卡池');
        const ta = $('#rTpl');
        ta.value = (ta.value ? ta.value.trimEnd() + ', ' : '') + `__${pool}__`;
        done(`已插入 __${pool}__`); break;
      }
      // --- LoRA：下拉点选 + 权重行 ---
      case 'lora-add': {
        const name = $('#pLoraPick')?.value;
        if (!name) throw new Error('先选一个 LoRA 文件');
        const w = Number($('#pLoraWeight')?.value ?? 0.8);
        state.loraDraft = normalizeLoras([...state.loraDraft, { name, weight: w }]);
        refreshLoraRows(); done(`已添加 ${name}`); break;
      }
      case 'lora-del': state.loraDraft.splice(i, 1); refreshLoraRows(); break;
      case 'lora-up': case 'lora-down': {
        const j = act === 'lora-up' ? i - 1 : i + 1;
        if (j < 0 || j >= state.loraDraft.length) break;
        [state.loraDraft[i], state.loraDraft[j]] = [state.loraDraft[j], state.loraDraft[i]];
        refreshLoraRows(); break;
      }
      case 'view-retry': await onRoute(); break;
      case 'job-refresh': await renderJobs(); break;
      case 'job-cancel': await api.post(`/api/jobs/${id}/cancel`, {}); await renderJobs(); break;
      case 'job-retry': await api.post(`/api/jobs/${id}/retry`, {}); await renderJobs(); break;
      case 'goto-gallery': location.hash = '#gallery'; break;
      case 'img-open': openLightbox(id); break;
      case 'img-rerun': {
        const im = state.images.find((x) => x.id === id);
        await api.post('/api/jobs', { draw_ids: [im.meta.draw_id], force: true });
        done('已用同一抽卡结果重新提交任务'); location.hash = '#jobs'; break;
      }
      case 'gallery-scan': {
        const path = $('#galleryDir').value.trim();
        if (!path) throw new Error('请填写图片目录');
        const r = await api.post('/api/images/register-dir', { path });
        done(`注册完成：新增 ${r.added} 张`); await renderGallery(); break;
      }
      case 'gallery-export': {
        const ids = state.images.map((x) => x.id).join(',');
        const data = await api.get('/api/images/export?ids=' + encodeURIComponent(ids));
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = 'gacha_gallery_meta.json'; a.click();
        URL.revokeObjectURL(a.href); done('元数据已导出'); break;
      }
      case 'comfy-refresh':
        await refreshStatusOnly();
        // 「刷新状态」显式重拉模型列表：新装的 LoRA / checkpoint 要靠它出现
        try { state.models = await api.get('/api/comfy/models'); } catch (_) { /* 保留旧列表 */ }
        await renderSettings(); break;
      case 'token-save': {
        const t = $('#pToken').value.trim();
        if (t) localStorage.setItem('gacha_token', t);
        else localStorage.removeItem('gacha_token');
        done(t ? '令牌已保存到本机浏览器' : '已清除令牌'); break;
      }
      case 'profile-new':
        // 新建草稿：清空选择，表单按默认值摆好，填名字保存即新预设
        state.settingsPid = null;
        state.loraDraft = [];
        await renderSettings(); done('已切到新建：填好参数后点「保存预设」'); break;
      case 'profile-del': {
        const pid = state.settingsPid;
        if (!pid) break;
        const cur = state.profiles.find((x) => x.id === pid);
        if (!confirm(`确定删除预设「${cur?.name || pid}」？被配方引用时会删除失败。`)) break;
        await api.del(`/api/gen-profiles/${pid}`);
        state.profiles = await api.get('/api/gen-profiles');
        if (String(state.form.gen_profile_id) === String(pid)) state.form.gen_profile_id = '';
        state.settingsPid = null;
        sessionStorage.setItem(FORM_KEY,
          JSON.stringify({ ...state.form, filterPool: state.filterPool }));
        done('预设已删除'); await renderSettings(); break;
      }
      case 'profile-save': {
        const saved = await api.post('/api/gen-profiles', settingsBody(state));
        state.settingsPid = saved.id;
        state.profiles = await api.get('/api/gen-profiles');
        done(`预设已保存：${saved.name}`); await renderSettings(); break;
      }
      default: break;
    }
  } catch (err) { fail(err); }
}

async function onRoute() {
  const raw = (location.hash.slice(1) || 'draw').replace(/^\//, '');
  if (raw.startsWith('concept/')) {
    setNav('draw');
    state.route = 'concept';
    try {
      await renderConceptPage(decodeURIComponent(raw.slice(8)));
    } catch (err) {
      fail(err);
      view.innerHTML = `<div class="panel err-text">概念页加载失败：${esc(friendlyError(err))}
        <button class="btn small" data-act="concept-back">返回抽卡台</button></div>`;
    }
    return;
  }
  let v = raw;
  if (!['draw', 'pools', 'recipes', 'jobs', 'gallery', 'settings'].includes(v)) v = 'draw';
  setNav(v);
  state.route = v;
  try {
    if (v === 'draw') await renderDraw();
    else if (v === 'pools') await renderPools();
    else if (v === 'recipes') await renderRecipes();
    else if (v === 'jobs') await renderJobs();
    else if (v === 'gallery') await renderGallery();
    else await renderSettings();
  } catch (err) {
    // 不整页替换：保留已有内容，只在顶部插入错误条，避免一条脏数据把界面清空
    fail(err);
    const bar = `<div class="panel err-text">页面加载失败：${esc(friendlyError(err))}
      <button class="btn small" data-act="view-retry">重试</button></div>`;
    view.innerHTML = view.innerHTML.trim() ? bar + view.innerHTML : bar;
  }
}

function onInput(e) {
  const t = e.target;
  if (t.dataset && t.dataset.qf) { onQuickFilterInput(t); return; }
  if (t.dataset && t.dataset.asmPoolQ !== undefined) {
    // 池筛选要重排 chip 行本身（命中的池可能排在原前 8 之外），所以重渲染容器而不是隐藏子项；
    // 输入框在外层、不参与重绘，打字不会失焦。
    state.assembly.pickerPoolQ = t.value;
    refreshAsmPools();
    return;
  }
  if (t.dataset && t.dataset.act === 'asm-q') {
    // 装配选择器的搜索：防抖后只刷新条目列表，不动输入框本身
    state.assembly.pickerQ = t.value;
    clearTimeout(asmTimer);
    asmTimer = setTimeout(() => asmLoadEntries(), 280);
    return;
  }
  if (t.dataset && t.dataset.act === 'asm-extra') {
    // 查询框独立于 g.extra：打字只查词表、只刷候选容器，不重建 input（否则失焦）。
    // 中文查询词绝不写进 extra —— 写进 prompt 的只能是候选对应的英文 tag。
    state.vocab.scope = t.dataset.scope || '';
    state.vocab.uid = Number(t.dataset.uid) || 0;
    state.vocab.q = t.value;
    clearTimeout(vocabTimer);
    vocabTimer = setTimeout(() => loadVocabSuggest(), 220);
    return;
  }
  if (['dRecipe', 'dPulls', 'dCount', 'dSeed', 'dFilter', 'dProfile'].includes(t.id)) {
    readDrawForm();
  }
  if (t.id === 'dFilterTagQ') {
    state.filterTagQ = t.value;
    loadTagOptions(state.filterPool, t.value.trim(), true);
  }
  if (t.id === 'conceptQ') {
    state.concepts.q = t.value;
    clearTimeout(conceptTimer);
    conceptTimer = setTimeout(() => loadConcepts(), 250);
  }
  // 槽位表格：只更新草稿与高级 JSON，不重绘（避免输入框失焦）
  if (t.dataset.slot) {
    const idx = Number(t.dataset.i), key = t.dataset.slot;
    let v = t.value;
    if (key === 'count' || key === 'weight') v = Number(v);
    if (state.slotsDraft[idx]) {
      state.slotsDraft[idx] = { ...state.slotsDraft[idx], [key]: v };
      const ta = $('#rSlots');
      if (ta) ta.value = JSON.stringify(state.slotsDraft, null, 2);
    }
  }
  // LoRA 权重：同样不重绘，保留数字输入的光标
  if (t.dataset.loraW !== undefined) {
    const idx = Number(t.dataset.loraW), w = Number(t.value);
    if (state.loraDraft[idx] && Number.isFinite(w)) state.loraDraft[idx].weight = w;
  }
  if (t.id?.startsWith('prompt_')) {
    const d = state.draws.find((x) => x.id === Number(t.id.slice(7)));
    if (d) d.prompt = t.value;   // 切视图重绘时不丢编辑内容
  }
}

function onChange(e) {
  const t = e.target;
  if (t.dataset && t.dataset.act === 'asm-extra') {
    // 失焦收起候选；查询词不进 extra（回车选词由 onKeydown 处理）
    state.vocab.open = false;
    return;
  }
  if (t.id === 'pPick') {
    // 设置页：切换正在编辑的预设
    state.settingsPid = Number(t.value) || null;
    renderSettings().catch(fail);
    return;
  }
  if (t.dataset && t.dataset.act === 'asm-pool') {
    // 下拉选池和点 chip 必须同一语义：明确选了池就锁住（之后搜索只在这池里），
    // 选「全部」解锁恢复跨池；chip 高亮也要跟着变，不然两处显示互相矛盾。
    const a = state.assembly;
    a.pickerPool = t.value;
    a.pickerLocked = !!t.value;
    refreshAsmPools();
    asmLoadEntries();
    return;
  }
  if (t.id === 'gFav' || t.id === 'gOrigin' || t.id === 'gRating') {
    state.gallery = {
      favorite: $('#gFav').value, origin: $('#gOrigin').value,
      min_rating: Number($('#gRating').value),
    };
    renderGallery().catch(fail);
  }
  if (t.id === 'dFilterPool') {
    state.filterPool = t.value;
    readDrawForm();
    loadTagOptions(state.filterPool, state.filterTagQ.trim());
  }
  if (t.id === 'dFilterTag' && t.value) {
    // 选中即添加：用户不必再点一次按钮
    setFilterSpec(addFilter(state.form.filter, state.filterPool, t.value));
    t.value = '';
    const q = $('#dFilterTagQ');
    if (q) q.value = '';
    state.filterTagQ = '';
    loadTagOptions(state.filterPool, '');
  }
  if (t.dataset.slot && t.tagName === 'SELECT') {
    const idx = Number(t.dataset.i);
    if (state.slotsDraft[idx]) {
      state.slotsDraft[idx] = { ...state.slotsDraft[idx], pool: t.value };
      const ta = $('#rSlots');
      if (ta) ta.value = JSON.stringify(state.slotsDraft, null, 2);
    }
  }
  if (t.id === 'pCheckpoint') {
    const free = $('#pCheckpointFree');
    if (free) free.value = t.value;
  }
}

function startStream() {
  jobStream((ev) => {
    if (!ev || !ev.job_id) return;
    const j = state.jobs.find((x) => x.id === ev.job_id);
    if (j) Object.assign(j, ev);
    else state.jobs.unshift({ id: ev.job_id, draw_id: ev.draw_id ?? '-', created_at: '', ...ev });

    // 结果卡就地更新：进度、完成、失败都不离开抽卡台
    const did = Number(ev.draw_id ?? j?.draw_id);
    if (did > 0) {
      state.drawJobs[did] = { ...(state.drawJobs[did] || {}), ...ev };
      if (ev.status === 'succeeded') {
        state.covers.cache = {};   // 新图可能成为某个概念的新封面
        resetPortraits();          // 同一个角色刚出的图，可能就是它该显示的立绘
        const ids = Array.isArray(ev.image_ids) ? ev.image_ids : [];
        // 事件里已带 image_ids：先直接上图，再异步补齐宽高/评分等字段
        if (ids.length) state.drawImages[did] = ids.map((id) => ({ id, rating: 0, favorite: false }));
        if (state.route === 'draw') {
          updateDrawCard(did);
          refreshDrawStates([did]).then(() => updateDrawCard(did)).catch(() => {});
        }
      } else if (state.route === 'draw') {
        updateDrawCard(did);
      }
    }

    if (state.currentView === 'jobs') refreshJobsBody();
    if (ev.status === 'succeeded' && state.currentView === 'gallery') {
      renderGallery().catch(fail);
    }
  }, (ok) => {
    const el = $('#streamState');
    if (el) el.textContent = ok ? 'SSE 实时连接' : 'SSE 断开，重连中…';
  });
}

async function boot() {
  view.addEventListener('click', onClick);
  view.addEventListener('change', onChange);
  view.addEventListener('input', onInput);
  view.addEventListener('keydown', onKeydown);
  view.addEventListener('mouseover', onCoverOver);
  view.addEventListener('mouseout', onCoverOut);
  view.addEventListener('focusin', onCoverOver);
  view.addEventListener('focusout', onCoverOut);
  view.addEventListener('mouseover', onThumbOver);
  view.addEventListener('mouseout', onThumbOut);
  view.addEventListener('focusin', onThumbOver);
  view.addEventListener('focusout', onThumbOut);
  // 列表一滚，fixed 浮层就与行错位了：直接收起，等下一次悬停
  window.addEventListener('scroll', hideThumbPop, true);
  document.querySelectorAll('#nav button').forEach((b) =>
    b.addEventListener('click', () => { location.hash = '#' + b.dataset.view; }));
  window.addEventListener('hashchange', onRoute);
  $('#lightboxClose').addEventListener('click', () => { $('#lightbox').hidden = true; });
  $('#lightbox').addEventListener('click', (e) => {
    if (e.target.id === 'lightbox') $('#lightbox').hidden = true;
  });
  try {
    restoreForm();
    restoreAssembly();
    await refreshBase();
    // 首次进入默认给最常用的「角色」类别，避免点热门 tag 时生成裸关键字触发全局过滤；
    // 用户明确选过「全部卡池」后存的是 ''，不会被这里覆盖。
    if (state.filterPool === null) {
      state.filterPool = state.pools.some((p) => p.kind === '角色') ? '角色' : '';
    }
    await loadTagOptions();
    await restoreLastDraw();
    // 刷新页面后把上一批的任务状态与已出图补回卡片，否则会全部显示「待生成」
    if (state.draws.length) {
      await refreshDrawStates(state.draws.map((d) => d.id)).catch(() => {});
    }
    startStream();
    await onRoute();
    // 概念墙不依赖任何 AI 服务，始终加载；语义索引未构建时只显示一行降级提示
    loadConcepts();
    loadSemanticsStatus().then(async (ready) => {
      if (ready) await loadSemantics('');
      else syncConceptPanel();
    });
  } catch (err) {
    view.innerHTML = `<div class="panel err-text">初始化失败：${esc(friendlyError(err))}<br>
      请确认 start.bat 正在运行，并刷新页面重试。</div>`;
  }
}

boot();

// 诊断句柄：控制台 / 探针脚本可以直接读 state，省掉「问题只在线上、本地复现不了」的猜测。
// 只挂引用不改行为，不影响正常功能。
window.__gacha = { state, api };
