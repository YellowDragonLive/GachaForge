// 抽卡工作台前端：原生 ES Modules，零框架、零构建。
import { api, jobStream, friendlyError } from './api.js';
import { esc, cut } from './detail.js';
import { settingsWorkflowHtml, modelExtraFields, settingsBody, loraPickerHtml } from './features/generation.js';
import { persistForm } from './state.js';
import { state } from './store.js';
import { asmOpenPicker, asmPickPool, asmSetMode, asmPick, restoreAssembly, asmSearchNow, asmQueryInput, asmPoolQInput, asmPoolChange } from './features/assembly.js';
import { vocabAddWord, vocabTarget, vocabInput, vocabKeydown, vocabBlur } from './features/vocab.js';
import { onQuickFilterInput, onQuickFilterKey } from './features/quickfilter.js';
import { setFilterMode, loadTagOptions, setFilterSpec, addFilterToRecipe, filterTagQInput } from './features/filter.js';
import { renderDraw, updateDrawCard, refreshDrawStates, paintStars, doDraw,
  submitJobs, readDrawForm, restoreForm, restoreLastDraw, openTuning,
  saveTuning } from './views/draw.js';
import { syncConceptPanel, loadConcepts, loadSemantics, loadSemanticsStatus,
  conceptQueryInput, conceptMore, renderConceptPage } from './views/concepts.js';
import { onCoverOver, onCoverOut, onThumbOver, onThumbOut, hideThumbPop, resetPortraits } from './features/covers.js';
import { $, view, fail, done } from './core/ui.js';
import { updateStatus, onRoute, registerView } from './core/router.js';
import { addFilter, removeFilter, normalizeLoras, loraOptionsHtml, loraRowsHtml, normalizeSlots, slotRowsHtml, slotPoolOptionsHtml, conceptDetailHtml, ratingStarsHtml, makePerson, poolSearchText, matchQuery, quickFilterHtml } from './widgets.js';

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

function onKeydown(e) {
  const t = e.target;
  if (!t.dataset) return;
  if (t.dataset.qf) { onQuickFilterKey(t, e); return; }
  if (t.dataset.act === 'asm-q' && e.key === 'Enter') asmSearchNow(t);
  if (t.dataset.act === 'asm-extra') vocabKeydown(t, e);
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
      case 'concept-open':
        // 不可过滤的概念卡：点整卡进详情页（概念名本就有 #/concept/<key> 链接，
        // 之前这里缺 case，点了整卡没反应——靠链接侥幸掩盖了）。
        location.hash = '#/concept/' + encodeURIComponent(btn.dataset.key || '');
        break;
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
      case 'concept-more': await conceptMore(); break;
      case 'img-rate':
      case 'img-fav': {
        const body = act === 'img-rate' ? { rating: Number(btn.dataset.v) }
          : { favorite: btn.dataset.v === '1' };
        await api.patch('/api/images/' + id, body);
        state.covers.cache = {};   // 评分 / 收藏会改变封面，缓存必须失效
        const rating = act === 'img-rate' ? Number(btn.dataset.v) : null;
        const fav = act === 'img-fav' ? btn.dataset.v === '1' : null;

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
          // 局部更新，不重绘整页：画廊的滚动位置与已加载的图都不会丢
          if (rating !== null) paintStars(id, rating);
          if (fav !== null) {
            document.querySelectorAll(`[data-act="img-fav"][data-id="${id}"]`).forEach((b) => {
              b.dataset.v = fav ? 0 : 1;
              b.textContent = fav ? '★ 已收藏' : '☆ 收藏';
            });
          }
          const did = Number(btn.dataset.draw);
          if (state.view === 'draw' && did) updateDrawCard(did);
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
        persistForm(state);
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

function onInput(e) {
  const t = e.target;
  if (t.dataset && t.dataset.qf) { onQuickFilterInput(t); return; }
  if (t.dataset && t.dataset.asmPoolQ !== undefined) { asmPoolQInput(t); return; }
  if (t.dataset && t.dataset.act === 'asm-q') { asmQueryInput(t); return; }
  if (t.dataset && t.dataset.act === 'asm-extra') { vocabInput(t); return; }
  if (['dRecipe', 'dPulls', 'dCount', 'dSeed', 'dFilter', 'dProfile'].includes(t.id)) {
    readDrawForm();
  }
  if (t.id === 'dFilterTagQ') filterTagQInput(t);
  if (t.id === 'conceptQ') conceptQueryInput(t);
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
  if (t.dataset && t.dataset.act === 'asm-extra') { vocabBlur(); return; }
  if (t.id === 'pPick') {
    // 设置页：切换正在编辑的预设
    state.settingsPid = Number(t.value) || null;
    renderSettings().catch(fail);
    return;
  }
  if (t.dataset && t.dataset.act === 'asm-pool') { asmPoolChange(t); return; }
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
