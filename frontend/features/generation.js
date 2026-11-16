import { $ } from '../core/ui.js';
import { state } from '../store.js';
// 生成参数域：workflow / checkpoint / LoRA / 采样参数的唯一真相。
//
// 抽卡台的调参抽屉与设置页的预设表单，过去各自拼一份 POST body，导致 workflow
// 硬编码三处（其中设置页永远写死 sdxl_minimal.json）。多模型改造后把公共部分
// 收敛到这里：表单模板、草稿构造、body 构造各只有一份。
//
// 依赖方向：本模块只依赖 api.js / detail.js / widgets.js，不 import app.js。

import { esc } from '../detail.js';
import { quickFilterHtml, normalizeLoras, loraOptionsHtml, loraRowsHtml } from '../widgets.js';

export const SAMPLERS = ['euler_ancestral', 'euler', 'dpmpp_2m', 'dpmpp_2m_sde',
  'dpmpp_sde', 'ddim', 'uni_pc'];
export const SCHEDULERS = ['normal', 'karras', 'exponential', 'sgm_uniform',
  'simple', 'ddim_uniform'];

export const DEFAULT_WORKFLOW = 'sdxl_minimal.json';

/** 从 config.workflow_specs 取 workflow 选项；老后端只有 workflows 字符串列表也能用。 */
export function workflowOptions(state, current) {
  const specs = Array.isArray(state?.config?.workflow_specs) ? state.config.workflow_specs : [];
  const names = specs.length
    ? specs.map((w) => ({ name: w.name, label: w.label || w.name, capabilities: w.capabilities || [] }))
    : (state?.config?.workflows || []).map((name) => ({ name, label: name, capabilities: [] }));
  const cur = String(current || DEFAULT_WORKFLOW);
  return names.map((w) => `<option value="${esc(w.name)}" ${w.name === cur ? 'selected' : ''}>${esc(w.label)}</option>`).join('')
    || `<option value="${esc(cur)}">${esc(cur)}</option>`;
}

/** 按 spec 能力显示模型专有字段（Anima 的 clip / vae）。无 spec 时按文件名推断。 */
export function modelExtraFields(state, workflow, values = {}) {
  const spec = (state?.config?.workflow_specs || []).find((w) => w.name === workflow);
  const caps = spec?.capabilities || [];
  const anima = caps.includes('clip') || String(workflow).toLowerCase().includes('anima');
  if (!anima) return '';
  return `<div class="row" style="margin-top:8px">
    <div class="field"><span>CLIP 模型（Anima/Qwen）</span>
      <input type="text" id="tClip" value="${esc(values.clip || 'qwen_3_06b_base.safetensors')}"></div>
    <div class="field"><span>VAE 模型</span>
      <input type="text" id="tVae" value="${esc(values.vae || 'qwen_image_vae.safetensors')}"></div>
  </div>`;
}

/** 调参抽屉的 workflow 选择行（紧凑版）。 */
export function tuningWorkflowHtml(state, current) {
  return `<div class="field" style="margin-top:8px"><span>生图 workflow · 决定用哪个模型</span>
    <select id="tWorkflow">${workflowOptions(state, current)}</select>
    <div class="hint">SDXL / Anima 共用本机 ComfyUI，切换后 checkpoint 与 LoRA 需匹配该模型。</div>
  </div>`;
}

/** 设置页的 workflow 选择行（宽版，带能力说明）。 */
export function settingsWorkflowHtml(state, current) {
  const specs = state?.config?.workflow_specs || [];
  const cur = String(current || DEFAULT_WORKFLOW);
  const spec = specs.find((w) => w.name === cur);
  return `<div class="field" style="margin-top:8px"><span>Workflow · 不同模型走不同节点图</span>
    <select id="pWorkflow" style="min-width:220px">${workflowOptions(state, cur)}</select>
    <div class="hint">${spec
      ? esc(`${spec.label} · 能力：${(spec.capabilities || []).join('、') || '基础'}`)
      : '无 spec 的旧模板按 SDXL 兼容模式运行'}</div>
  </div>`;
}

/** 从调参抽屉的表单读 body。loras/workflow/clip/vae 都要带回——后端整体覆盖。 */
export function tuningBody(state, prefix = 't') {
  const $ = (id) => document.getElementById(prefix + id);
  const t = state.tuneDraft || {};
  const body = {
    name: ($('Name')?.value || '').trim() || t.name,
    checkpoint: ($('Checkpoint')?.value || '').trim() || t.checkpoint,
    loras: t.loras || [],
    steps: Number($('Steps')?.value) || 20,
    cfg: Number($('Cfg')?.value) || 6,
    width: Number($('Width')?.value) || 1024,
    height: Number($('Height')?.value) || 1360,
    sampler: $('Sampler')?.value || 'euler_ancestral',
    scheduler: $('Scheduler')?.value || 'normal',
    negative: $('Negative')?.value ?? t.negative,
    workflow: $('Workflow')?.value || t.workflow || DEFAULT_WORKFLOW,
  };
  if ($('Clip')) body.clip = $('Clip').value.trim();
  if ($('Vae')) body.vae = $('Vae').value.trim();
  if (t.id != null && body.name === t.srcName) body.id = t.id;
  return body;
}

/** 从设置页表单读 body。与调参抽屉共用同一份字段口径。 */
export function settingsBody(state) {
  const $ = (id) => document.getElementById(id);
  const p = state.profiles.find((x) => x.id === state.settingsPid) || {};
  const body = {
    id: state.settingsPid || undefined,
    name: ($('pName')?.value || '').trim(),
    checkpoint: ($('pCheckpointFree')?.value || '').trim() || $('pCheckpoint')?.value || '',
    loras: normalizeLoras(state.loraDraft || p.loras || []),
    steps: Number($('pSteps')?.value) || 20,
    cfg: Number($('pCfg')?.value) || 6,
    width: Number($('pWidth')?.value) || 1024,
    height: Number($('pHeight')?.value) || 1360,
    sampler: $('pSampler')?.value || 'euler_ancestral',
    scheduler: $('pScheduler')?.value || 'normal',
    negative: $('pNegative')?.value ?? p.negative,
    workflow: $('pWorkflow')?.value || p.workflow || DEFAULT_WORKFLOW,
  };
  if ($('pClip')) body.clip = $('pClip').value.trim();
  if ($('pVae')) body.vae = $('pVae').value.trim();
  return body;
}

/** 草稿构造：两个入口共用，避免「一个改了另一个没改」。 */
export function profileDraft(state) {
  const pid = Number(state.form.gen_profile_id) || null;
  const p = state.profiles.find((x) => Number(x.id) === pid) || state.profiles[0] || {};
  return {
    id: p.id ?? null, srcName: p.name || '', name: p.name || '默认参数',
    checkpoint: p.checkpoint || '',
    steps: p.steps ?? 20, cfg: p.cfg ?? 6,
    width: p.width ?? 1024, height: p.height ?? 1360,
    sampler: p.sampler || 'euler_ancestral',
    scheduler: p.scheduler || 'normal',
    negative: p.negative || 'worst quality, low quality',
    loras: Array.isArray(p.loras) ? p.loras : [],
    workflow: p.workflow || DEFAULT_WORKFLOW,
    clip: p.clip || '', vae: p.vae || '',
  };
}

/** 设置页 LoRA 区块（从 renderSettings 抽出，避免重复 loraOptionsHtml 调用）。 */
export function loraPickerHtml(state) {
  const loras = state.models.loras || [];
  return `<div class="field picker" style="margin-top:12px"><span>LoRA · 点选文件 + 调权重，无需写 JSON</span>
    <div class="row">
      ${quickFilterHtml('pLoraPick', '筛选 LoRA：neg / style / 画风', { width: 220 })}
      <span class="hint" data-qf-count="pLoraPick"></span>
      <span class="hint">共 ${loras.length} 个文件</span>
    </div>
    <div class="row" style="margin-top:6px">
      <select id="pLoraPick" style="flex:1;min-width:190px">${loraOptionsHtml(loras, state.loraDraft)}</select>
      <label class="mini">权重<input type="number" id="pLoraWeight" value="0.8"
        step="0.05" min="-4" max="4" style="width:86px"></label>
      <button class="btn small primary" data-act="lora-add">＋ 添加</button>
    </div>
    <div id="loraRows" style="margin-top:8px">${loraRowsHtml(state.loraDraft)}</div>
    <div class="hint">${loras.length
      ? '先筛（如 neg → neg4all…safetensors），回车直接选中；顺序即加载顺序。负向 LoRA 权重填负数，例如 -1。'
      : '当前无 LoRA 文件（mock 模式或 ComfyUI 未加载），可只用 checkpoint。'}</div>
  </div>`;
}
