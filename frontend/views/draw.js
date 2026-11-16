import { api } from '../api.js';
import { cut, esc, slotChips } from '../detail.js';
import { LAST_SESSION_KEY, persistForm, restoreForm as restoreFormState } from '../state.js';
import { state } from '../store.js';
import { assemblyIsEmpty, assemblyToDefinition, conceptStripHtml, filterChipsHtml, quickFilterHtml } from '../widgets.js';
import { refresh } from '../core/router.js';
import { $, done, fail, num, view } from '../core/ui.js';
import { asmSummaryText, assemblyPanelHtml, saveAssembly } from '../features/assembly.js';
import { loadPortraits } from '../features/covers.js';
import { filterHintBoxHtml, filterPaneHtml, updateFilterHint } from '../features/filter.js';
import { SAMPLERS, SCHEDULERS, modelExtraFields, profileDraft, tuningBody, tuningWorkflowHtml } from '../features/generation.js';

// 抽卡台视图：装配结果 → 一抽 → 任务提交 → 结果卡就地更新。
// 意群装配面板在 features/assembly.js，这里只负责「抽」与「看结果」。

// ---------------- 抽卡台 ----------------
export function drawForm() {
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
            <input type="text" id="dFilter" value="${esc(f.filter)}" placeholder="留空 = 全部卡池"
              data-suggest="filter" data-suggest-append autocomplete="off" spellcheck="false">
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

// ---------------- 参数预设就地调参 ----------------
/** 展开前先把当前选中的预设读进草稿，避免打开就看到空表单。 */
export async function openTuning() {
  if (state.tuning) { state.tuning = false; await renderDraw(); return; }
  if (!Array.isArray(state.models.checkpoints) || !state.models.checkpoints.length) {
    try { state.models = await api.get('/api/comfy/models'); } catch (_) { /* 离线时退回手填值 */ }
  }
  state.tuneDraft = profileDraft(state);
  state.tuning = true;
  await renderDraw();
}

export function tuningHtml() {
  const t = state.tuneDraft || {};
  const cks = state.models.checkpoints || [];
  const ckOpts = (cks.length ? cks : (t.checkpoint ? [t.checkpoint] : []))
    .map((m) => `<option value="${esc(m)}" ${m === t.checkpoint ? 'selected' : ''}>${esc(m)}</option>`)
    .join('');
  const opt = (list, cur) => list.map((v) =>
    `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(v)}</option>`).join('');
  return `<div class="tune-box">
    <div class="field"><span>保存为预设名</span>
      <input type="text" id="tName" value="${esc(t.name || '默认参数')}"
        data-suggest="profile" autocomplete="off"></div>
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
export async function saveTuning() {
  const t = state.tuneDraft || {};
  const body = tuningBody(state);
  const name = body.name;
  const saved = await api.post('/api/gen-profiles', body);
  state.profiles = await api.get('/api/gen-profiles');
  state.form.gen_profile_id = String(saved.id);
  state.tuning = false;
  persistForm(state);
  await renderDraw();
  done(`参数已保存并应用：${saved.name} · ${saved.steps} 步 / CFG ${saved.cfg}`);
}

/** 把抽卡台表单当前值同步进 state，任何重绘都不再丢失选择。 */
export function readDrawForm() {
  const get = (id) => $(id)?.value;
  if (get('#dRecipe') === undefined) return;
  state.form = {
    recipe_id: get('#dRecipe'), pulls: num(get('#dPulls'), 3),
    count: num(get('#dCount'), 1), seed: get('#dSeed'),
    filter: get('#dFilter'), gen_profile_id: get('#dProfile'),
  };
  const poolEl = $('#dFilterPool');
  if (poolEl) state.filterPool = poolEl.value;
  persistForm(state);
  updateFilterHint();
  const chips = $('#filterChips');
  if (chips) chips.innerHTML = filterChipsHtml(state.form.filter);
}

/** 刷新页面后连表单选择一起恢复，避免「刚填的过滤条件又没了」。 */
export function restoreForm() {
  restoreFormState(state);
  // 过滤模式 IV：filterMode 必须是合法值，否则回落按池
  if (!['pool', 'concept', 'feel'].includes(state.form.filterMode)) {
    state.form.filterMode = 'pool';
  }
}

export function questState(d) {
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

export function drawCard(d) {
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
export function drawStateHtml(d) {
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
export function updateDrawCard(id) {
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
export function paintStars(id, rating) {
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
export async function refreshDrawStates(ids) {
  const list = (ids || []).map(Number).filter((x) => x > 0);
  if (!list.length) return;
  const rows = await api.get('/api/draws/status?draw_ids=' + list.join(','));
  for (const row of rows || []) {
    if (row.job) state.drawJobs[row.draw_id] = row.job;
    if (Array.isArray(row.images) && row.images.length) {
      state.drawImages[row.draw_id] = row.images;
    }
  }
  if (state.view === 'draw') list.forEach(updateDrawCard);
}

export async function renderDraw() {
  saveAssembly();
  view.innerHTML = drawForm();
  // 立绘异步补，不阻塞面板渲染；同一个 key 只请求一次（state.portraits 缓存）
  loadPortraits().catch(() => {});
}

/** 刷新页面后恢复上一批抽卡结果（只读回显，不产生新数据）。
 *  优先用上次记录的会话；旧版前端没记录过，就回退到库里最近一批。
 *  「清空结果」写入 '0' 作为持久屏蔽标记。 */
export async function restoreLastDraw() {
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

export async function doDraw({ generate = false } = {}) {
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
export async function submitJobs(ids, opts = {}) {
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
  if (state.view === 'draw') list.forEach(updateDrawCard);
  if (!opts.silent) {
    done(`已提交 ${data.created.length} 个任务` +
      `${data.reused.length ? `，复用 ${data.reused.length} 个` : ''}`);
  }
  if (opts.gotoJobs) location.hash = '#jobs';
  return data;
}

// ---- 动作注册表：data-act → 处理器（app.js 事件委派调用）----
export const actions = {
  'draw-and-gen': async () => {
    await doDraw({ generate: true });
  },
  'draw': async () => {
    await doDraw();
  },
  'tune-open': async () => {
    await openTuning();
  },
  'tune-save': async () => {
    await saveTuning();
  },
  'draw-clear': async () => {
    state.draws = []; state.session = null; state.warnings = [];
    sessionStorage.setItem(LAST_SESSION_KEY, '0');
    await refresh('draw');
  },
  'gen-all': async () => {
    await submitJobs(state.draws.map((d) => d.id));
  },
  'gen-one': async (btn) => {
    const id = Number(btn.dataset.id);
    await submitJobs([id]);
  },
  'copy': async (btn) => {
    const id = Number(btn.dataset.id);
    const el = $(`#prompt_${id}`);
    await navigator.clipboard.writeText(el.value);
    done('已复制 prompt');
  },
};
