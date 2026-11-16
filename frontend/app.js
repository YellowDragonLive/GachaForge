// 抽卡工作台前端：原生 ES Modules，零框架、零构建。
import { api, jobStream, friendlyError } from './api.js';
import { esc, cut } from './detail.js';
import { settingsBody } from './features/generation.js';
import { persistForm } from './state.js';
import { state } from './store.js';
import { asmOpenPicker, asmPickPool, asmSetMode, asmPick, restoreAssembly, asmSearchNow, asmQueryInput, asmPoolQInput, asmPoolChange } from './features/assembly.js';
import { vocabAddWord, vocabTarget, vocabInput, vocabKeydown, vocabBlur } from './features/vocab.js';
import { onQuickFilterInput, onQuickFilterKey } from './features/quickfilter.js';
import { setFilterMode, loadTagOptions, setFilterSpec, addFilterToRecipe, filterTagQInput } from './features/filter.js';
import { renderPools } from './views/pools.js';
import { renderRecipes } from './views/recipes.js';
import { renderJobs, refreshJobsBody } from './views/jobs.js';
import { renderGallery, openLightbox } from './views/gallery.js';
import { renderSettings, refreshLoraRows } from './views/settings.js';
import { renderDraw, updateDrawCard, refreshDrawStates, paintStars, doDraw,
  submitJobs, readDrawForm, restoreForm, restoreLastDraw, openTuning,
  saveTuning } from './views/draw.js';
import { syncConceptPanel, loadConcepts, loadSemantics, loadSemanticsStatus,
  conceptQueryInput, conceptMore, renderConceptPage } from './views/concepts.js';
import { onCoverOver, onCoverOut, onThumbOver, onThumbOut, hideThumbPop, resetPortraits } from './features/covers.js';
import { $, view, fail, done } from './core/ui.js';
import { updateStatus, onRoute, registerView } from './core/router.js';
import { addFilter, removeFilter, normalizeLoras, normalizeSlots, conceptDetailHtml, makePerson } from './widgets.js';

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
