// 抽卡工作台前端：原生 ES Modules，零框架、零构建。
import { api, jobStream, friendlyError } from './api.js';
import { esc } from './detail.js';
import { state } from './store.js';
import { restoreFacets } from './state.js';
import { restoreAssembly, asmSearchNow, asmQueryInput, asmPoolQInput, asmPoolChange } from './features/assembly.js';
import { vocabInput, vocabKeydown, vocabBlur } from './features/vocab.js';
import { onQuickFilterInput, onQuickFilterKey } from './features/quickfilter.js';
import { suggestInput, suggestKey, suggestBlur, initSuggest } from './features/suggest.js';
import { loadTagOptions, setFilterSpec, filterTagQInput } from './features/filter.js';
import { renderPools } from './views/pools.js';
import { renderRecipes } from './views/recipes.js';
import { renderJobs, refreshJobsBody, setStreamState } from './views/jobs.js';
import { renderGallery, refreshGallery } from './views/gallery.js';
import { renderSettings } from './views/settings.js';
import { renderDraw, updateDrawCard, refreshDrawStates, paintStars,
  readDrawForm, restoreForm, restoreLastDraw, switchTuneWorkflow } from './views/draw.js';
import { syncConceptPanel, loadConcepts, loadSemantics, loadSemanticsStatus,
  conceptQueryInput, renderConceptPage } from './views/concepts.js';
import { onCoverOver, onCoverOut, onThumbOver, onThumbOut, hideThumbPop, resetPortraits } from './features/covers.js';
import { $, view, fail, done } from './core/ui.js';
import { actions as drawActions } from './views/draw.js';
import { actions as assemblyActions } from './features/assembly.js';
import { actions as vocabActions } from './features/vocab.js';
import { actions as filterActions } from './features/filter.js';
import { actions as conceptActions } from './views/concepts.js';
import { actions as poolActions } from './views/pools.js';
import { actions as recipeActions } from './views/recipes.js';
import { actions as jobActions } from './views/jobs.js';
import { actions as galleryActions } from './views/gallery.js';
import { actions as settingsActions } from './views/settings.js';
import { updateStatus, onRoute, registerView } from './core/router.js';
import { addFilter, conceptDetailHtml } from './widgets.js';

async function refreshBase() {
  const [recipes, profiles, pools, batches, config, comfy, jobs] = await Promise.all([
    api.get('/api/recipes'), api.get('/api/gen-profiles'), api.get('/api/pools'),
    api.get('/api/pools/batches'), api.get('/api/config'),
    api.get('/api/comfy/status'), api.get('/api/jobs'),
  ]);
  Object.assign(state, { recipes, profiles, pools, batches, config, comfy, jobs });
  updateStatus();
}

function onKeydown(e) {
  const t = e.target;
  if (!t.dataset) return;
  if (t.dataset.qf) { onQuickFilterKey(t, e); return; }
  // 补全浮层打开时先让它吃掉 ↑↓ / Enter / Esc，免得 Enter 同时触发抽卡之类的快捷键
  if (t.dataset.suggest && suggestKey(t, e)) return;
  if (t.dataset.act === 'asm-q' && e.key === 'Enter') asmSearchNow(t);
  if (t.dataset.act === 'asm-extra') vocabKeydown(t, e);
}

// ---------------- 事件 ----------------
// ---- 动作注册表（跨域动作留在 app.js：路由重试、图片评分要同时更新三个视图）----
const coreActions = {
  'view-retry': async () => { await onRoute(); },
  'img-rate': async (btn) => { await rateImage(btn, { rating: Number(btn.dataset.v) }); },
  'img-fav': async (btn) => { await rateImage(btn, { favorite: btn.dataset.v === '1' }); },
};

// 同一张图可能同时出现在概念详情页、画廊、抽卡台，改动后各自就地更新，
// 不整页重绘——画廊的滚动位置与已加载的图都不会丢。
async function rateImage(btn, body) {
  const id = Number(btn.dataset.id);
  const rating = body.rating ?? null;
  const fav = body.favorite ?? null;
  await api.patch('/api/images/' + id, body);
  state.covers.cache = {};   // 评分 / 收藏会改变封面，缓存必须失效

  if (state.view === 'concept') {
    const item = state.conceptPage.items.find((x) => x.id === id);
    if (item) {
      if (rating !== null) item.rating = rating;
      if (fav !== null) item.favorite = fav;
    }
    view.innerHTML = conceptDetailHtml(state.conceptPage);
  } else {
    const lists = state.view === 'gallery'
      ? [state.images] : Object.values(state.drawImages);
    for (const list of lists) {
      const im = list.find((x) => x.id === id);
      if (!im) continue;
      if (rating !== null) im.rating = rating;
      if (fav !== null) im.favorite = fav;
    }
    if (state.view === 'gallery') {
      // 画廊是 Vue 视图：改了 state.images 就够，DOM 由它重绘
      refreshGallery();
    } else {
      // 抽卡台 / 概念页还是原生视图：局部打补丁，别整页重绘
      if (rating !== null) paintStars(id, rating);
      if (fav !== null) {
        document.querySelectorAll(`[data-act="img-fav"][data-id="${id}"]`).forEach((b) => {
          b.dataset.v = fav ? 0 : 1;
          b.textContent = fav ? '★ 已收藏' : '☆ 收藏';
        });
      }
    }
    const did = Number(btn.dataset.draw);
    if (state.view === 'draw' && did) updateDrawCard(did);
  }
  done(rating !== null ? '评分已保存' : '收藏已更新');
}


const handlers = {
  ...coreActions,
  ...drawActions,
  ...assemblyActions,
  ...vocabActions,
  ...filterActions,
  ...conceptActions,
  ...poolActions,
  ...recipeActions,
  ...jobActions,
  ...galleryActions,
  ...settingsActions,
};

async function onClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  try {
    const handler = handlers[btn.dataset.act];
    if (handler) await handler(btn);   // 无 handler = 未注册动作，静默（与原 default 一致）
  } catch (err) { fail(err); }
}

function onInput(e) {
  const t = e.target;
  if (t.dataset && t.dataset.qf) { onQuickFilterInput(t); return; }
  // 不 return：dFilter 这类输入框既要补全，也要同步回表单草稿
  if (t.dataset && t.dataset.suggest) suggestInput(t);
  if (t.dataset && t.dataset.asmPoolQ !== undefined) { asmPoolQInput(t); return; }
  if (t.dataset && t.dataset.act === 'asm-q') { asmQueryInput(t); return; }
  if (t.dataset && t.dataset.act === 'asm-extra') { vocabInput(t); return; }
  if (['dRecipe', 'dPulls', 'dCount', 'dSeed', 'dFilter', 'dProfile'].includes(t.id)) {
    readDrawForm();
  }
  if (t.id === 'dFilterTagQ') filterTagQInput(t);
  if (t.id === 'conceptQ') conceptQueryInput(t);
  if (t.id?.startsWith('prompt_')) {
    const d = state.draws.find((x) => x.id === Number(t.id.slice(7)));
    if (d) d.prompt = t.value;   // 切视图重绘时不丢编辑内容
  }
}

function onChange(e) {
  const t = e.target;
  if (t.dataset && t.dataset.suggest) suggestBlur();
  if (t.dataset && t.dataset.act === 'asm-extra') { vocabBlur(); return; }
  if (t.dataset && t.dataset.act === 'asm-pool') { asmPoolChange(t); return; }
  if (t.id === 'tWorkflow') { switchTuneWorkflow(t.value); return; }
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
        if (state.view === 'draw') {
          updateDrawCard(did);
          refreshDrawStates([did]).then(() => updateDrawCard(did)).catch(() => {});
        }
      } else if (state.view === 'draw') {
        updateDrawCard(did);
      }
    }

    if (state.view === 'jobs') refreshJobsBody();
    if (ev.status === 'succeeded' && state.view === 'gallery') {
      renderGallery().catch(fail);
    }
  }, (ok) => {
    // 任务页是 Vue 视图，状态走 ref（直接改 DOM 会被下一次重绘盖掉）；
    // 抽卡台还是原生视图，保留原地写 textContent 的老路子。
    setStreamState(ok);
    if (state.view !== 'jobs') {
      const el = $('#streamState');
      if (el) el.textContent = ok ? 'SSE 实时连接' : 'SSE 断开，重连中…';
    }
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
  initSuggest();
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
    restoreFacets(state);
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

// 视图注册：路由只认名字，不认函数定义在哪个文件。
// 拆域的每一步只是把这里的某一行搬到对应模块里，路由层不用改。
registerView('draw', renderDraw);
registerView('pools', renderPools);
registerView('recipes', renderRecipes);
registerView('jobs', renderJobs);
registerView('gallery', renderGallery);
registerView('settings', renderSettings);
registerView('concept', renderConceptPage);

boot();

// 诊断句柄：控制台 / 探针脚本可以直接读 state，省掉「问题只在线上、本地复现不了」的猜测。
// 只挂引用不改行为，不影响正常功能。
window.__gacha = { state, api };
