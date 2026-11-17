// 生成参数域：workflow / checkpoint / LoRA / 采样参数的唯一真相。
//
// 抽卡台的调参抽屉与设置页的预设表单，过去各自拼一份 POST body，导致 workflow
// 硬编码三处（其中设置页永远写死 sdxl_minimal.json）。多模型改造后把公共部分
// 收敛到这里：表单模板、草稿构造、body 构造各只有一份。
//
// 依赖方向：本模块只依赖 widgets.js / detail.js，不 import 视图，也不碰 DOM。
// 设置页换成 Vue 之后，body 从组件里的草稿对象读，不再从 document 里逐个 getElementById。

import { esc } from '../detail.js';
import { normalizeLoras } from '../widgets.js';

export const SAMPLERS = ['euler_ancestral', 'euler', 'dpmpp_2m', 'dpmpp_2m_sde',
  'dpmpp_sde', 'ddim', 'uni_pc'];
export const SCHEDULERS = ['normal', 'karras', 'exponential', 'sgm_uniform',
  'simple', 'ddim_uniform'];

export const DEFAULT_WORKFLOW = 'sdxl_minimal.json';

/** workflow 候选（数据）：Vue 模板 v-for 用，tuningWorkflowHtml 也用它拼 option。 */
export function workflowChoices(state, current) {
  const specs = Array.isArray(state?.config?.workflow_specs) ? state.config.workflow_specs : [];
  const names = specs.length
    ? specs.map((w) => ({ name: w.name, label: w.label || w.name, capabilities: w.capabilities || [] }))
    : (state?.config?.workflows || []).map((name) => ({ name, label: name, capabilities: [] }));
  const cur = String(current || DEFAULT_WORKFLOW);
  return names.length ? names : [{ name: cur, label: cur, capabilities: [] }];
}

/** workflow 选项拼成 option 字符串（只剩调参抽屉这个原生视图在用）。 */
function workflowOptions(state, current) {
  const cur = String(current || DEFAULT_WORKFLOW);
  return workflowChoices(state, cur).map((w) =>
    `<option value="${esc(w.name)}" ${w.name === cur ? 'selected' : ''}>${esc(w.label)}</option>`).join('');
}

/** 当前 workflow 是否要额外填 CLIP / VAE（Anima 系列走 UNET+CLIP+VAE 三段加载）。 */
export function hasModelExtras(state, workflow) {
  const spec = (state?.config?.workflow_specs || []).find((w) => w.name === workflow);
  const caps = spec?.capabilities || [];
  return caps.includes('clip') || String(workflow).toLowerCase().includes('anima');
}

/**
 * 该 workflow 的权重要从哪个模型池里选。
 *
 * 纯 UNet（Anima / MOSS）走 UNETLoader，只看得到 models/unet；
 * SDXL 走 CheckpointLoaderSimple，只看得到 models/checkpoints。
 * 这两个目录在 ComfyUI 里互不相通，列错了就会出现「模型装着但下拉里搜不到」——
 * 用户装完 MOSS 在前端找不到，就是这个原因。
 */
export function ckptPoolKey(state, workflow) {
  const spec = (state?.config?.workflow_specs || []).find((w) => w.name === workflow);
  return spec?.ckpt_kind === 'unet' ? 'unet' : 'checkpoints';
}

/** 按 spec 能力显示模型专有字段（Anima 的 clip / vae）。无 spec 时按文件名推断。 */
export function modelExtraFields(state, workflow, values = {}) {
  if (!hasModelExtras(state, workflow)) return '';
  return `<div class="row" style="margin-top:8px">
    <div class="field"><span>CLIP 模型（Anima/Qwen）</span>
      <input type="text" id="tClip" value="${esc(values.clip || 'qwen_3_06b_base.safetensors')}"
        data-suggest="clip" autocomplete="off" spellcheck="false"></div>
    <div class="field"><span>VAE 模型</span>
      <input type="text" id="tVae" value="${esc(values.vae || 'qwen_image_vae.safetensors')}"
        data-suggest="vae" autocomplete="off" spellcheck="false"></div>
  </div>`;
}

/** 调参抽屉的 workflow 选择行（紧凑版）。 */
export function tuningWorkflowHtml(state, current) {
  return `<div class="field" style="margin-top:8px"><span>生图 workflow · 决定用哪个模型</span>
    <select id="tWorkflow">${workflowOptions(state, current)}</select>
    <div class="hint">换 workflow 会换掉 checkpoint / CLIP / VAE / 步数 / CFG 并清空 LoRA
      （不同模型族的权重互不通用）。</div>
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

/**
 * 从设置页的表单草稿读 body。
 *
 * 参数是草稿对象而不是 document：设置页是 Vue 组件，表单值住在一个 reactive 里，
 * 从 DOM 读会和「Vue 认为的值」分裂（筛选框自动落选时 DOM 变了、草稿没变）。
 * 显式传入 draft 也让这个函数可以在测试里直接调，不用先造 DOM。
 */
export function settingsBody(state, draft = {}, loras = []) {
  const body = {
    id: draft.id || undefined,
    name: String(draft.name || '').trim(),
    // 手动填写优先：枚举里没有的 checkpoint（换机器 / 自定义文件名）不许被下拉吞掉
    checkpoint: String(draft.checkpointFree || '').trim() || String(draft.checkpoint || ''),
    loras: normalizeLoras(loras),
    steps: Number(draft.steps) || 20,
    cfg: Number(draft.cfg) || 6,
    width: Number(draft.width) || 1024,
    height: Number(draft.height) || 1360,
    sampler: draft.sampler || 'euler_ancestral',
    scheduler: draft.scheduler || 'normal',
    negative: draft.negative ?? '',
    workflow: draft.workflow || DEFAULT_WORKFLOW,
  };
  // clip / vae 只在当前 workflow 需要时才发：发给 SDXL 会被后端当成无关字段
  if (hasModelExtras(state, body.workflow)) {
    body.clip = String(draft.clip || '').trim();
    body.vae = String(draft.vae || '').trim();
  }
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

/** 把一条预设摊成设置页的表单草稿（切换预设时直接改草稿，不重新挂载组件）。 */
export function profileToDraft(p, pid) {
  const src = p || {};
  return {
    id: src.id ?? pid ?? null,
    name: src.name || (src.id ? '默认参数' : '新预设'),
    checkpoint: src.checkpoint || '',
    checkpointFree: '',
    steps: src.steps ?? 20, cfg: src.cfg ?? 6,
    width: src.width ?? 1024, height: src.height ?? 1360,
    sampler: src.sampler || 'euler_ancestral',
    scheduler: src.scheduler || 'normal',
    negative: src.negative ?? '',
    workflow: src.workflow || DEFAULT_WORKFLOW,
    clip: src.clip || '', vae: src.vae || '',
  };
}

/** 枚举里没有当前值时把它补进列表，避免换机器后预设显示成「空」。 */
export function optionsWithCurrent(list, current) {
  const arr = (Array.isArray(list) ? list : []).map(String);
  const cur = String(current ?? '');
  if (cur && !arr.includes(cur)) arr.unshift(cur);
  return arr;
}
