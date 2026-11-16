// 配方编辑器视图：槽位表格、模板插入、LoRA 与预览。

import { esc } from '../detail.js';
import { normalizeSlots, quickFilterHtml, slotPoolOptionsHtml, slotRowsHtml } from '../widgets.js';
import { state } from '../store.js';
import { $, view } from '../core/ui.js';

// ---------------- 配方编辑器 ----------------
export function recipeForm() {
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
export function refreshSlots() {
  const box = $('#slotRows');
  if (box) box.innerHTML = slotRowsHtml(state.slotsDraft, state.pools, state.hotTags);
  const ta = $('#rSlots');
  if (ta) ta.value = JSON.stringify(state.slotsDraft, null, 2);
  const dl = $('#slotTagList');
  if (dl) dl.innerHTML = state.hotTags.map((x) =>
    `<option value="${esc(x.value)}"></option>`).join('');
}

export async function renderRecipes() {
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

export function readRecipeForm() {
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

