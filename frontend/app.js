// 抽卡工作台前端：原生 ES Modules，零框架、零构建。
import { api, jobStream, friendlyError } from './api.js';
import { esc, cut, slotChips } from './detail.js';
import {
  parseFilterSpec, addFilter, removeFilter, missingFilterSlots,
  filterChipsHtml, hotTagChipsHtml,
  poolOptionsHtml, tagOptionsHtml, normalizeLoras, loraOptionsHtml, loraRowsHtml,
  normalizeSlots, slotRowsHtml, slotPoolOptionsHtml,
  conceptCardsHtml, conceptKindChipsHtml, semanticCardsHtml, conceptStripHtml,
  coverPopoverHtml, conceptDetailHtml,
} from './widgets.js';

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
const num = (v, d) => (v === '' || v === undefined || v === null ? d : Number(v));
const LAST_SESSION_KEY = 'gacha_last_session';
const FORM_KEY = 'gacha_draw_form';

const state = {
  recipes: [], profiles: [], pools: [], batches: [], jobs: [], images: [],
  config: {}, comfy: {}, models: {}, session: null, draws: [], warnings: [],
  currentView: 'draw', route: 'draw', editingRecipe: null, openPool: null,
  // 结果卡片内联状态：draw_id → 最新任务 / 已出图片（抽完即看，不必跳任务队列或画廊）
  drawJobs: {}, drawImages: {},
  // 参数预设就地编辑：高频调参不再占一个一级页面
  tuning: false, tuneDraft: null,
  gallery: { favorite: '', origin: '', min_rating: 0 },
  // 抽卡台表单值集中保存：重绘 / 切视图 / 刷新都不再丢失用户的选择
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
  // 左右排布：设置栏 sticky 常驻，结果在右栏首屏；概念探索是可选增强，
  // 放到结果下方并做成可折叠，避免全宽面板把「设置 + 结果」挤出首屏。
  return `<div class="draw-shell">
    <aside class="draw-side">
    <div class="panel">
      <div class="panel-head"><h2>抽卡设置</h2><span class="sub">${state.pools.length} 个卡池</span></div>
      <div class="field"><span>配方</span><select id="dRecipe"><option value="" ${sel('', f.recipe_id)}>（不用配方 · 全池随机）</option>${recipeOpts}</select></div>
      <div class="row" style="margin-top:10px">
        <div class="field"><span>连抽数</span><input type="number" id="dPulls" value="${esc(f.pulls)}" min="1" max="50"></div>
        <div class="field"><span>每池条数</span><input type="number" id="dCount" value="${esc(f.count)}" min="1" max="20"></div>
        <div class="field"><span>种子</span><input type="number" id="dSeed" value="${esc(f.seed)}" placeholder="留空随机"></div>
      </div>
      <div class="field picker" style="margin-top:14px">
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
      <div class="row" style="margin-top:8px">
        <button class="btn small" data-act="gen-all" ${state.draws.length ? '' : 'disabled'}>本批全部生图</button>
        ${state.draws.length ? '<button class="btn small" data-act="draw-clear">清空结果</button>' : ''}
      </div>
      <p class="hint" style="margin-bottom:0">同种子可复现；生图进度直接显示在结果卡片上，不用切页面去看队列。</p>
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
  return `<div class="row">
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
const SAMPLERS = ['euler_ancestral', 'euler', 'dpmpp_2m', 'dpmpp_2m_sde',
  'dpmpp_sde', 'ddim', 'uni_pc'];
const SCHEDULERS = ['normal', 'karras', 'exponential', 'sgm_uniform',
  'simple', 'ddim_uniform'];

/** 展开前先把当前选中的预设读进草稿，避免打开就看到空表单。 */
async function openTuning() {
  if (state.tuning) { state.tuning = false; await renderDraw(); return; }
  if (!Array.isArray(state.models.checkpoints) || !state.models.checkpoints.length) {
    try { state.models = await api.get('/api/comfy/models'); } catch (_) { /* 离线时退回手填值 */ }
  }
  const pid = Number(state.form.gen_profile_id) || null;
  const p = state.profiles.find((x) => Number(x.id) === pid) || state.profiles[0] || {};
  state.tuneDraft = {
    name: p.name || '默认参数',
    checkpoint: p.checkpoint || '',
    steps: p.steps ?? 20, cfg: p.cfg ?? 6,
    width: p.width ?? 1024, height: p.height ?? 1360,
    sampler: p.sampler || 'euler_ancestral',
    scheduler: p.scheduler || 'normal',
    negative: p.negative || 'worst quality, low quality',
    loras: Array.isArray(p.loras) ? p.loras : [],
    workflow: p.workflow || 'sdxl_minimal.json',
  };
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
    <div class="field" style="margin-top:8px"><span>checkpoint</span>
      <select id="tCheckpoint">${ckOpts || '<option value="">（未读到模型列表，可先去设置页刷新）</option>'}</select></div>
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
  const body = {
    name: $('#tName').value.trim() || t.name,
    checkpoint: $('#tCheckpoint').value || t.checkpoint,
    // loras / workflow 必须带回：后端 upsert 会整体覆盖，漏传等于清空
    loras: t.loras || [],
    steps: num($('#tSteps').value, 20),
    cfg: num($('#tCfg').value, 6),
    width: num($('#tWidth').value, 1024),
    height: num($('#tHeight').value, 1360),
    sampler: $('#tSampler').value,
    scheduler: $('#tScheduler').value,
    negative: $('#tNegative').value,
    workflow: t.workflow || 'sdxl_minimal.json',
  };
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
function drawCard(d) {
  const chips = slotChips(d.detail);
  return `<div class="card draw-card" data-card="${d.id}">
    <div class="card-head"><b>第 ${d.idx} 抽</b><span>seed ${esc(d.seed ?? '随机')} · #${d.id}</span></div>
    <div class="card-state" data-state-for="${d.id}">${drawStateHtml(d)}</div>
    <details class="card-prompt">
      <summary>prompt 快照 · ${esc(cut(d.prompt, 52))}</summary>
      <textarea data-prompt="${d.id}" id="prompt_${d.id}">${esc(d.prompt)}</textarea>
      <div class="hint">编辑只影响复制，生图始终按抽卡时的快照执行（同 seed 可复现）。</div>
    </details>
    <div class="tags">${chips || '<span class="hint">无槽位明细</span>'}</div>
    ${conceptStripHtml(d.detail, state.conceptThumbMap)}
    <div class="row">
      <button class="btn small" data-act="copy" data-id="${d.id}">复制 prompt</button>
    </div>
  </div>`;
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

async function renderDraw() { view.innerHTML = drawForm(); }

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
  const body = {
    recipe_id: num(f.recipe_id, null),
    pulls: num(f.pulls, 3),
    count: num(f.count, 1),
    seed: num(f.seed, null),
    filter: String(f.filter || '').trim(),
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
  const rows = state.pools.map((p) => `<tr>
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
      <div class="scroll">${items.items.map((i) => `<div class="chip" style="display:block;margin-bottom:4px">
        ${esc(cut(i.label, 60))} <span class="sub">→ ${esc(cut(i.tags, 80))}</span></div>`).join('')}</div></div>` : ''}
  <div class="panel"><div class="panel-head"><h2>导入与批次</h2></div>
    <div class="row"><input type="text" id="importPath" placeholder="项目内相对路径，如 vendor/.../wildcards 或 my_pool.json" style="max-width:460px">
      <button class="btn" data-act="import">导入</button></div>
    <p class="hint">支持 .json（任意结构）、.csv（中文名,英文 tag）、目录（每个 .txt 一个词卡池）。重复导入会自动跳过同名池。</p>
    <div class="scroll" style="margin-top:10px"><table><thead><tr><th>批次</th><th>类型</th><th>条数</th><th>来源</th><th>操作</th></tr></thead>
      <tbody>${batches}</tbody></table></div>
  </div>`;
  $('#poolSearch').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    document.querySelectorAll('#poolTable tbody tr').forEach((tr) =>
      tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none');
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
      <button class="btn small" data-act="img-fav" data-id="${im.id}">${im.favorite ? '★' : '☆'}</button>
      <button class="btn small" data-act="img-rate" data-id="${im.id}" data-v="${(im.rating % 5) + 1}">评分 ${im.rating}</button>
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
  try { state.models = await api.get('/api/comfy/models'); } catch (_) { state.models = {}; }
  const p = state.profiles[0] || {};
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
      <div class="field"><span>预设名</span><input type="text" id="pName" value="${esc(p.name || '默认 SDXL')}"></div>
      <div class="field" style="margin-top:8px"><span>Checkpoint · 点选，来自 ComfyUI /object_info</span>
        <select id="pCheckpoint"><option value="">（留空 = ComfyUI 默认）</option>${models}</select>
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
      <div class="field picker" style="margin-top:12px"><span>LoRA · 点选文件 + 调权重，无需写 JSON</span>
        <div class="row">
          <select id="pLoraPick" style="flex:1;min-width:190px">${loraOptionsHtml(state.models.loras || [], state.loraDraft)}</select>
          <label class="mini">权重<input type="number" id="pLoraWeight" value="0.8"
            step="0.05" min="-4" max="4" style="width:86px"></label>
          <button class="btn small primary" data-act="lora-add">＋ 添加</button>
        </div>
        <div id="loraRows" style="margin-top:8px">${loraRowsHtml(state.loraDraft)}</div>
        <div class="hint">${(state.models.loras || []).length
          ? '顺序即加载顺序，可用 ↑ ↓ 调整；权重同时作用于 model / clip。'
          : '当前没有可用的 LoRA 文件（mock 模式或 ComfyUI 未加载 LoRA），可留空只用 checkpoint。'}</div>
      </div>
      <div class="row" style="margin-top:12px"><button class="btn primary" data-act="profile-save">保存预设</button></div>
    </div></div>`;
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
        if (state.route === 'concept') {
          const item = state.conceptPage.items.find((x) => x.id === id);
          if (item) {
            if (act === 'img-rate') item.rating = Number(btn.dataset.v);
            else item.favorite = btn.dataset.v === '1';
          }
          view.innerHTML = conceptDetailHtml(state.conceptPage);
        } else if (state.route === 'gallery') {
          const im = state.images.find((x) => x.id === id);
          if (im) {
            if (act === 'img-rate') im.rating = Number(btn.dataset.v);
            else im.favorite = btn.dataset.v === '1';
          }
          await renderGallery();
        } else {
          // 抽卡结果卡：只换状态区，不重绘整页
          for (const list of Object.values(state.drawImages)) {
            const im = list.find((x) => x.id === id);
            if (!im) continue;
            if (act === 'img-rate') im.rating = Number(btn.dataset.v);
            else im.favorite = btn.dataset.v === '1';
          }
          const did = Number(btn.dataset.draw);
          if (did) updateDrawCard(did);
          else await refreshDrawStates(state.draws.map((d) => d.id));
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
      case 'comfy-refresh': await refreshStatusOnly(); await renderSettings(); break;
      case 'token-save': {
        const t = $('#pToken').value.trim();
        if (t) localStorage.setItem('gacha_token', t);
        else localStorage.removeItem('gacha_token');
        done(t ? '令牌已保存到本机浏览器' : '已清除令牌'); break;
      }
      case 'profile-save': {
        const loras = normalizeLoras(state.loraDraft);
        const cp = $('#pCheckpointFree')?.value.trim() || $('#pCheckpoint').value;
        await api.post('/api/gen-profiles', {
          name: $('#pName').value.trim(), checkpoint: cp, loras,
          steps: num($('#pSteps').value, 20), cfg: num($('#pCfg').value, 6),
          width: num($('#pWidth').value, 1024), height: num($('#pHeight').value, 1360),
          sampler: $('#pSampler').value, scheduler: $('#pScheduler').value,
          negative: $('#pNegative').value, workflow: 'sdxl_minimal.json',
        });
        state.profiles = await api.get('/api/gen-profiles');
        done('预设已保存'); await renderSettings(); break;
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
  view.addEventListener('mouseover', onCoverOver);
  view.addEventListener('mouseout', onCoverOut);
  view.addEventListener('focusin', onCoverOver);
  view.addEventListener('focusout', onCoverOut);
  document.querySelectorAll('#nav button').forEach((b) =>
    b.addEventListener('click', () => { location.hash = '#' + b.dataset.view; }));
  window.addEventListener('hashchange', onRoute);
  $('#lightboxClose').addEventListener('click', () => { $('#lightbox').hidden = true; });
  $('#lightbox').addEventListener('click', (e) => {
    if (e.target.id === 'lightbox') $('#lightbox').hidden = true;
  });
  try {
    restoreForm();
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
