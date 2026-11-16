// 设置视图：运行环境、生成参数预设（checkpoint/LoRA/workflow）。

import { api } from '../api.js';
import { esc } from '../detail.js';
import { loraOptionsHtml, loraRowsHtml, normalizeLoras, quickFilterHtml } from '../widgets.js';
import { loraPickerHtml, modelExtraFields, settingsWorkflowHtml } from '../features/generation.js';
import { state } from '../store.js';
import { $, view } from '../core/ui.js';
import { refresh } from '../core/router.js';

// ---------------- 设置 ----------------
export function refreshLoraRows() {
  const box = $('#loraRows');
  if (box) box.innerHTML = loraRowsHtml(state.loraDraft);
  const pick = $('#pLoraPick');
  if (pick) {
    const keep = pick.value;
    pick.innerHTML = loraOptionsHtml(state.models.loras || [], state.loraDraft);
    pick.value = keep;
  }
}

export async function renderSettings() {
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

