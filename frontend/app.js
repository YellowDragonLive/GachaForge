// 抽卡工作台前端：原生 ES Modules，零框架、零构建。
import { api, jobStream, friendlyError } from './api.js';

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cut = (s, n = 120) => (s.length > n ? s.slice(0, n) + '…' : s);
const num = (v, d) => (v === '' || v === undefined || v === null ? d : Number(v));

const state = {
  recipes: [], profiles: [], pools: [], batches: [], jobs: [], images: [],
  config: {}, comfy: {}, models: {}, session: null, draws: [],
  currentView: 'draw', editingRecipe: null, openPool: null,
  gallery: { favorite: '', origin: '', min_rating: 0 },
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
  const recipeOpts = state.recipes.map((r) =>
    `<option value="${r.id}">${esc(r.name)}</option>`).join('');
  const profileOpts = state.profiles.map((p) =>
    `<option value="${p.id}">${esc(p.name)} · ${esc(p.checkpoint || '未设模型')}</option>`).join('');
  return `<div class="grid-2">
    <div class="panel">
      <div class="panel-head"><h2>抽卡设置</h2><span class="sub">${state.pools.length} 个卡池</span></div>
      <div class="field"><span>配方</span><select id="dRecipe"><option value="">（不用配方 · 全池随机）</option>${recipeOpts}</select></div>
      <div class="row" style="margin-top:10px">
        <div class="field"><span>连抽数</span><input type="number" id="dPulls" value="3" min="1" max="50"></div>
        <div class="field"><span>每池条数</span><input type="number" id="dCount" value="1" min="1" max="20"></div>
        <div class="field"><span>种子</span><input type="number" id="dSeed" placeholder="留空随机"></div>
      </div>
      <div class="field" style="margin-top:10px"><span>按池过滤（可选，如 角色:Fate）</span>
        <input type="text" id="dFilter" placeholder="留空 = 全部"></div>
      <div class="field" style="margin-top:10px"><span>生成参数预设</span>
        <select id="dProfile"><option value="">（跟随配方 / 默认）</option>${profileOpts}</select></div>
      <div class="row" style="margin-top:14px">
        <button class="btn primary" data-act="draw">抽 卡</button>
        <button class="btn" data-act="gen-all" ${state.draws.length ? '' : 'disabled'}>本批全部生图</button>
      </div>
      <p class="hint" style="margin-bottom:0">同种子可复现；生图是后台任务，提交后可去「任务队列」看进度。</p>
    </div>
    <div>
      ${state.draws.length ? `<div class="panel-head"><h2>本批结果 · ${state.draws.length} 抽</h2>
        <span class="sub">会话 #${state.session?.session_id ?? '-'} · seed ${esc(state.session?.seed ?? '随机')}</span></div>
        <div class="cards">${state.draws.map(drawCard).join('')}</div>` :
        `<div class="panel"><div class="loading">选好配方后点「抽 卡」，结果会显示在这里。</div></div>`}
    </div>
  </div>`;
}

function drawCard(d) {
  const chips = (d.detail || []).filter((x) => x.tags?.length).map((x) =>
    `<span class="chip">${esc(x.slot)}: ${esc(cut(x.tags.join(' / '), 48))}</span>`).join('');
  return `<div class="card">
    <div class="card-head"><b>第 ${d.idx} 抽</b><span>seed ${esc(d.seed ?? '随机')} · #${d.id}</span></div>
    <textarea data-prompt="${d.id}" id="prompt_${d.id}">${esc(d.prompt)}</textarea>
    <div class="tags">${chips || '<span class="hint">无槽位明细</span>'}</div>
    <div class="row" style="margin-top:10px">
      <button class="btn small" data-act="copy" data-id="${d.id}">复制</button>
      <button class="btn small primary" data-act="gen-one" data-id="${d.id}">生成此图</button>
    </div>
  </div>`;
}

async function renderDraw() { view.innerHTML = drawForm(); }

async function doDraw() {
  const body = {
    recipe_id: num($('#dRecipe').value, null),
    pulls: num($('#dPulls').value, 3),
    count: num($('#dCount').value, 1),
    seed: num($('#dSeed').value, null),
    filter: $('#dFilter').value.trim(),
    gen_profile_id: num($('#dProfile').value, null),
  };
  const data = await api.post('/api/draw-sessions', body);
  state.session = data; state.draws = data.draws;
  done(`抽卡完成：${data.draws.length} 抽 / ${data.pool_count} 个池`);
  renderDraw();
}

async function submitJobs(ids) {
  const profileId = num($('#dProfile')?.value, null);
  const data = await api.post('/api/jobs', { draw_ids: ids, gen_profile_id: profileId });
  done(`已提交 ${data.created.length} 个任务${data.reused.length ? `，复用 ${data.reused.length} 个` : ''}`);
  location.hash = '#jobs';
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
    <div class="field" style="margin-top:8px"><span>槽位 JSON（pool / count / weight / filter）</span>
      <textarea id="rSlots" style="min-height:130px">${esc(JSON.stringify(def.slots || [], null, 2))}</textarea></div>
    <div class="field" style="margin-top:8px"><span>模板（__池名__ / __池名#3__ / __池名~__）</span>
      <textarea id="rTpl" style="min-height:56px">${esc(def.template || '')}</textarea></div>
    <div class="field" style="margin-top:8px"><span>固定尾部</span>
      <input type="text" id="rTail" value="${esc(def.fixed_tail || '')}"></div>`;
}

async function renderRecipes() {
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
  let slots;
  try { slots = JSON.parse($('#rSlots').value || '[]'); }
  catch (e) { throw new Error('槽位 JSON 格式不对：' + e.message); }
  if (!Array.isArray(slots)) throw new Error('槽位必须是数组');
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
  const im = state.images.find((x) => x.id === id);
  if (!im) return;
  $('#lightboxImg').src = `/api/images/${id}/file`;
  $('#lightboxInfo').textContent = `#${id} · ${im.width}×${im.height} · ` +
    (im.meta?.prompt || im.meta?.name || '') + ` · seed ${im.meta?.seed ?? '-'}`;
  $('#lightbox').hidden = false;
}

// ---------------- 设置 ----------------
async function renderSettings() {
  try { state.models = await api.get('/api/comfy/models'); } catch (_) { state.models = {}; }
  const p = state.profiles[0] || {};
  const c = state.config;
  const models = (state.models.checkpoints || []).map((m) =>
    `<option value="${esc(m)}" ${m === p.checkpoint ? 'selected' : ''}>${esc(m)}</option>`).join('');
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
      <div class="field" style="margin-top:8px"><span>Checkpoint（来自 ComfyUI /object_info）</span>
        <select id="pCheckpoint"><option value="">（留空 = ComfyUI 默认）</option>${models}</select>
        <input type="text" id="pCheckpointFree" placeholder="或手动填写 ckpt 文件名" value="${esc(p.checkpoint || '')}" style="margin-top:5px"></div>
      <div class="row" style="margin-top:8px">
        <div class="field"><span>步数</span><input type="number" id="pSteps" value="${p.steps || 20}"></div>
        <div class="field"><span>CFG</span><input type="number" id="pCfg" step="0.5" value="${p.cfg || 6}"></div>
        <div class="field"><span>宽</span><input type="number" id="pWidth" value="${p.width || 1024}"></div>
        <div class="field"><span>高</span><input type="number" id="pHeight" value="${p.height || 1360}"></div>
      </div>
      <div class="row" style="margin-top:8px">
        <div class="field"><span>采样器</span><input type="text" id="pSampler" value="${esc(p.sampler || 'euler_ancestral')}"></div>
        <div class="field"><span>调度器</span><input type="text" id="pScheduler" value="${esc(p.scheduler || 'normal')}"></div>
      </div>
      <div class="field" style="margin-top:8px"><span>负向提示词</span>
        <input type="text" id="pNegative" value="${esc(p.negative || '')}"></div>
      <div class="field" style="margin-top:8px"><span>LoRA（JSON 数组，如 [{"name":"x.safetensors","weight":0.8}]）</span>
        <textarea id="pLoras" style="min-height:56px">${esc(JSON.stringify(p.loras || []))}</textarea></div>
      <div class="row" style="margin-top:12px"><button class="btn primary" data-act="profile-save">保存预设</button></div>
    </div></div>`;
}

// ---------------- 事件 ----------------
async function onClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act, id = Number(btn.dataset.id);
  try {
    switch (act) {
      case 'draw': await doDraw(); break;
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
      case 'job-refresh': await renderJobs(); break;
      case 'job-cancel': await api.post(`/api/jobs/${id}/cancel`, {}); await renderJobs(); break;
      case 'job-retry': await api.post(`/api/jobs/${id}/retry`, {}); await renderJobs(); break;
      case 'goto-gallery': location.hash = '#gallery'; break;
      case 'img-open': openLightbox(id); break;
      case 'img-fav': {
        const im = state.images.find((x) => x.id === id);
        await api.patch(`/api/images/${id}`, { favorite: !im.favorite });
        await renderGallery(); break;
      }
      case 'img-rate':
        await api.patch(`/api/images/${id}`, { rating: Number(btn.dataset.v) });
        await renderGallery(); break;
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
        let loras;
        try { loras = JSON.parse($('#pLoras').value || '[]'); }
        catch (err) { throw new Error('LoRA JSON 格式不对：' + err.message); }
        const cp = $('#pCheckpointFree').value.trim() || $('#pCheckpoint').value;
        await api.post('/api/gen-profiles', {
          name: $('#pName').value.trim(), checkpoint: cp, loras,
          steps: num($('#pSteps').value, 20), cfg: num($('#pCfg').value, 6),
          width: num($('#pWidth').value, 1024), height: num($('#pHeight').value, 1360),
          sampler: $('#pSampler').value.trim(), scheduler: $('#pScheduler').value.trim(),
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
  const v = (location.hash.slice(1) || 'draw');
  if (!['draw', 'pools', 'recipes', 'jobs', 'gallery', 'settings'].includes(v)) v = 'draw';
  setNav(v);
  try {
    if (v === 'draw') await renderDraw();
    else if (v === 'pools') await renderPools();
    else if (v === 'recipes') await renderRecipes();
    else if (v === 'jobs') await renderJobs();
    else if (v === 'gallery') await renderGallery();
    else await renderSettings();
  } catch (err) { view.innerHTML = `<div class="panel err-text">页面加载失败：${esc(friendlyError(err))}</div>`; }
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
  if (t.id === 'pCheckpoint') $('#pCheckpointFree').value = t.value;
}

function startStream() {
  jobStream((ev) => {
    if (!ev || !ev.job_id) return;
    const j = state.jobs.find((x) => x.id === ev.job_id);
    if (j) Object.assign(j, ev);
    else state.jobs.unshift({ id: ev.job_id, draw_id: '-', created_at: '', ...ev });
    if (state.currentView === 'jobs') refreshJobsBody();
    if (ev.status === 'succeeded' && state.currentView === 'gallery') renderGallery().catch(fail);
  }, (ok) => {
    const el = $('#streamState');
    if (el) el.textContent = ok ? 'SSE 实时连接' : 'SSE 断开，重连中…';
  });
}

async function boot() {
  view.addEventListener('click', onClick);
  view.addEventListener('change', onChange);
  document.querySelectorAll('#nav button').forEach((b) =>
    b.addEventListener('click', () => { location.hash = '#' + b.dataset.view; }));
  window.addEventListener('hashchange', onRoute);
  $('#lightboxClose').addEventListener('click', () => { $('#lightbox').hidden = true; });
  $('#lightbox').addEventListener('click', (e) => {
    if (e.target.id === 'lightbox') $('#lightbox').hidden = true;
  });
  try {
    await refreshBase();
    startStream();
    await onRoute();
  } catch (err) {
    view.innerHTML = `<div class="panel err-text">初始化失败：${esc(friendlyError(err))}<br>
      请确认 start.bat 正在运行，并刷新页面重试。</div>`;
  }
}

boot();
