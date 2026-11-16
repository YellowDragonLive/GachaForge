// 设置视图（Vue）：运行环境 + 生成参数预设。
//
// 这一页过去有几个反复出现的毛病，都是「表单值住在 DOM 里」造成的：
//   ① 切换预设整页 innerHTML 重建，正在输入的名称/权重被打断；
//   ② `settingsBody` 从 document 逐个 getElementById，Vue 渲染的 DOM 与草稿一旦不同步，
//      保存下去的就是旧值（筛选框自动落选就是这种场景）；
//   ③ LoRA 权重靠 data-lora-w 回写 state，删一行就要手动重排所有 index。
// 现在表单住在一个 reactive 草稿里，body 从草稿构造：改数据即改表单，DOM 只是投影。
//
// 约定：需要打接口的动作留 data-act（由 app.js 委派），纯本地编辑走 v-model / @click。
import { api } from '../api.js';
import { cut } from '../detail.js';
import { persistForm } from '../state.js';
import { state } from '../store.js';
import { loraOptionList, normalizeLoras } from '../widgets.js';
import {
  DEFAULT_WORKFLOW, SAMPLERS, SCHEDULERS, hasModelExtras, optionsWithCurrent,
  profileToDraft, settingsBody, workflowChoices,
} from '../features/generation.js';
import { refresh, updateStatus } from '../core/router.js';
import { done } from '../core/ui.js';
import { computed, defineComponent, mountVue, reactive, ref } from '../vue/index.js';

// ---- 视图状态（模块级：动作注册表要能读到，不经过 DOM）----
const draft = reactive({
  id: null, name: '', checkpoint: '', checkpointFree: '',
  clip: '', vae: '', steps: 20, cfg: 6, width: 1024, height: 1360,
  sampler: 'euler_ancestral', scheduler: 'normal', negative: '',
  workflow: DEFAULT_WORKFLOW,
});
const loras = reactive([]);        // LoRA 草稿：v-model 直接改权重
const loraPick = ref('');          // 待添加的文件
const loraWeight = ref(0.8);
const token = ref('');
const profiles = ref([]);
const loraFiles = ref([]);

/** 把一条预设摊进草稿。切换预设走这里，不重新挂载组件（也就不丢未保存的输入焦点）。 */
function fillDraft(p, pid) {
  Object.assign(draft, profileToDraft(p, pid));
  loras.splice(0, loras.length, ...normalizeLoras(p?.loras || []));
  loraPick.value = '';
  loraWeight.value = 0.8;
  state.settingsPid = draft.id;
}

const SettingsView = defineComponent({
  name: 'SettingsView',
  setup() {
    const sys = state.config || {};
    const comfyState = state.comfy || {};
    const wfChoices = computed(() => workflowChoices(state, draft.workflow));
    const wfHint = computed(() => {
      const spec = (state.config?.workflow_specs || []).find((w) => w.name === draft.workflow);
      if (!spec) return '无 spec 的旧模板按 SDXL 兼容模式运行';
      return `${spec.label || spec.name} · 能力：${(spec.capabilities || []).join('、') || '基础'}`;
    });
    const anima = computed(() => hasModelExtras(state, draft.workflow));
    const samplerOptions = computed(() => optionsWithCurrent(SAMPLERS, draft.sampler));
    const schedulerOptions = computed(() => optionsWithCurrent(SCHEDULERS, draft.scheduler));
    // checkpoint 枚举来自 ComfyUI /object_info；当前值不在枚举里时补进去，换机器后不被清空
    const checkpointOptions = computed(() =>
      optionsWithCurrent(state.models?.checkpoints || [], draft.checkpoint));
    const loraOptions = computed(() => loraOptionList(loraFiles.value, loras));
    const comfyText = computed(() => {
      if (!comfyState.online) return '离线';
      return comfyState.mock ? 'mock 模式' : '在线';
    });

    return {
      draft, loras, loraPick, loraWeight, token, profiles, loraFiles,
      sys, comfyState, comfyText, wfChoices, wfHint, anima,
      samplerOptions, schedulerOptions, checkpointOptions, loraOptions, cut,
      pickValue: computed(() => (draft.id == null ? '' : String(draft.id))),
      switchProfile(v) {
        const id = Number(v) || null;
        state.settingsPid = id;
        fillDraft(state.profiles.find((x) => x.id === id) || null, id);
      },
      moveLora(i, step) {
        const j = i + step;
        if (j < 0 || j >= loras.length) return;
        [loras[i], loras[j]] = [loras[j], loras[i]];
      },
      addLora() {
        const name = loraPick.value;
        if (!name) throw new Error('先选一个 LoRA 文件');
        loras.push({ name, weight: Number(loraWeight.value) || 0.8 });
        loraPick.value = '';
      },
      removeLora(i) { loras.splice(i, 1); },
      saveToken() {
        const t = token.value.trim();
        if (t) localStorage.setItem('gacha_token', t);
        else localStorage.removeItem('gacha_token');
        done(t ? '令牌已保存到本机浏览器' : '已清除令牌');
      },
    };
  },
  template: `
    <div class="grid-2">
      <div class="panel">
        <div class="panel-head"><h2>运行环境</h2>
          <button class="btn small" data-act="comfy-refresh">刷新状态</button></div>
        <div class="kv">
          <span>服务地址</span><span>{{ sys.host }}:{{ sys.port }}</span>
          <span>ComfyUI</span><span>{{ sys.comfy_url }} · {{ comfyText }}</span>
          <span>数据库</span><span>{{ sys.db_path }}</span>
          <span>输出目录</span><span>{{ sys.outputs_dir }}</span>
          <span>词卡目录</span><span>{{ sys.wildcards_dir }} {{ sys.wildcards_ready ? '✓' : '（缺失）' }}</span>
          <span>workflow 模板</span><span>{{ (sys.workflows || []).join(', ') }}</span>
          <span>认证</span><span>{{ sys.auth_required ? '需令牌' : '免登录（仅本机）' }}</span>
        </div>
        <p class="hint" v-if="comfyState.mock">
          当前为 mock 模式：生图返回占位图，用于离线验证链路。把 .env 里 GACHA_COMFY_MOCK 改为 0 并重启即可真实出图。</p>
        <p class="hint" v-else>
          真实出图需要本机 ComfyUI 运行在 8188，且所选 checkpoint 在 /object_info 列表中。</p>
        <div class="field" style="margin-top:8px"><span>访问令牌（仅当 .env 设置 GACHA_TOKEN 时才需要）</span>
          <div class="row"><input type="text" v-model="token" data-secret placeholder="留空 = 免登录" style="max-width:320px">
            <button class="btn small" @click="saveToken">保存令牌</button></div></div>
      </div>

      <div class="panel">
        <div class="panel-head"><h2>生成参数预设</h2>
          <span class="sub">保存后新抽卡会话生效</span></div>
        <div class="row" style="margin-bottom:10px">
          <select id="pPick" :value="pickValue" @change="switchProfile($event.target.value)"
            style="flex:1;min-width:150px">
            <option v-if="draft.id == null" value="">（新建中 · 填好点保存）</option>
            <option v-for="x in profiles" :key="x.id" :value="x.id">{{ x.name }} · #{{ x.id }}</option>
          </select>
          <button class="btn small" data-act="profile-new">＋ 新建</button>
          <button class="btn small danger" data-act="profile-del" :disabled="draft.id == null"
            :title="draft.name || ''">删除</button>
        </div>
        <div class="field"><span>预设名</span><input type="text" v-model="draft.name"
          data-suggest="profile" autocomplete="off"></div>

        <div class="field" style="margin-top:8px"><span>Workflow · 不同模型走不同节点图</span>
          <select id="pWorkflow" v-model="draft.workflow" style="min-width:220px">
            <option v-for="w in wfChoices" :key="w.name" :value="w.name">{{ w.label }}</option>
          </select>
          <div class="hint">{{ wfHint }}</div></div>

        <div class="row" style="margin-top:8px" v-if="anima">
          <div class="field"><span>CLIP 模型（Anima/Qwen）</span>
            <input type="text" v-model="draft.clip" placeholder="qwen_3_06b_base.safetensors"
              data-suggest="clip" autocomplete="off" spellcheck="false"></div>
          <div class="field"><span>VAE 模型</span>
            <input type="text" v-model="draft.vae" placeholder="qwen_image_vae.safetensors"
              data-suggest="vae" autocomplete="off" spellcheck="false"></div>
        </div>

        <div class="field" style="margin-top:8px"><span>Checkpoint · 点选，来自 ComfyUI /object_info</span>
          <div class="row">
            <input type="text" class="qf" data-qf="pCheckpoint" autocomplete="off" spellcheck="false"
              style="max-width:200px" placeholder="筛选 checkpoint：如 sdxl / wai">
            <select id="pCheckpoint" v-model="draft.checkpoint" style="flex:1;min-width:210px">
              <option value="">（留空 = ComfyUI 默认）</option>
              <option v-for="m in checkpointOptions" :key="m" :value="m">{{ m }}</option>
            </select>
            <span class="hint" data-qf-count="pCheckpoint"></span>
          </div>
          <details class="advanced"><summary>手动填写 ckpt 文件名（一般不需要）</summary>
            <input type="text" v-model="draft.checkpointFree" placeholder="或手动填写 ckpt 文件名"
              data-suggest="checkpoint" autocomplete="off" spellcheck="false"></details></div>

        <div class="row" style="margin-top:8px">
          <div class="field"><span>步数</span><input type="number" v-model.number="draft.steps"></div>
          <div class="field"><span>CFG</span><input type="number" v-model.number="draft.cfg" step="0.5"></div>
          <div class="field"><span>宽</span><input type="number" v-model.number="draft.width"></div>
          <div class="field"><span>高</span><input type="number" v-model.number="draft.height"></div>
        </div>
        <div class="row" style="margin-top:8px">
          <div class="field"><span>采样器</span>
            <select v-model="draft.sampler">
              <option v-for="s in samplerOptions" :key="s" :value="s">{{ s }}</option>
            </select></div>
          <div class="field"><span>调度器</span>
            <select v-model="draft.scheduler">
              <option v-for="s in schedulerOptions" :key="s" :value="s">{{ s }}</option>
            </select></div>
        </div>
        <div class="field" style="margin-top:8px"><span>负向提示词</span>
          <input type="text" v-model="draft.negative" data-suggest="neg"
            data-suggest-append autocomplete="off" spellcheck="false"></div>

        <div class="field picker" style="margin-top:12px"><span>LoRA · 点选文件 + 调权重，无需写 JSON</span>
          <div class="row">
            <input type="text" class="qf" data-qf="pLoraPick" autocomplete="off" spellcheck="false"
              style="max-width:220px" placeholder="筛选 LoRA：neg / style / 画风">
            <span class="hint" data-qf-count="pLoraPick"></span>
            <span class="hint">共 {{ loraFiles.length }} 个文件</span>
          </div>
          <div class="row" style="margin-top:6px">
            <select id="pLoraPick" v-model="loraPick" style="flex:1;min-width:190px">
              <option value="">（选择 LoRA 文件）</option>
              <option v-for="o in loraOptions" :key="o.value" :value="o.value" :disabled="o.disabled">
                {{ o.text }}{{ o.disabled ? ' · 已添加' : '' }}</option>
            </select>
            <label class="mini">权重
              <input type="number" v-model.number="loraWeight" step="0.05" min="-4" max="4" style="width:86px"></label>
            <button class="btn small primary" @click="addLora">＋ 添加</button>
          </div>
          <div style="margin-top:8px">
            <div class="hint" v-if="!loras.length">尚未添加 LoRA · 留空即只用 checkpoint</div>
            <div v-for="(x, i) in loras" :key="i" class="lora-row">
              <span class="lora-name" :title="x.name">{{ cut(x.name, 46) }}</span>
              <label class="mini">权重
                <input type="number" v-model.number="x.weight" step="0.05" min="-4" max="4"></label>
              <button type="button" class="btn small" @click="moveLora(i, -1)" :disabled="i === 0">↑</button>
              <button type="button" class="btn small" @click="moveLora(i, 1)"
                :disabled="i === loras.length - 1">↓</button>
              <button type="button" class="btn small danger" @click="removeLora(i)">移除</button>
            </div>
          </div>
          <div class="hint" v-if="loraFiles.length">
            先筛（如 neg → neg4all…safetensors），回车直接选中；顺序即加载顺序。负向 LoRA 权重填负数，例如 -1。</div>
          <div class="hint" v-else>当前无 LoRA 文件（mock 模式或 ComfyUI 未加载），可只用 checkpoint。</div>
        </div>

        <div class="row" style="margin-top:12px">
          <button class="btn primary" data-act="profile-save">保存预设</button></div>
      </div>
    </div>`,
});

export async function renderSettings() {
  profiles.value = state.profiles.slice();
  // 模型列表只在为空时才拉：ComfyUI /object_info 可能要几十秒，
  // 每次切预设 / 保存都重拉会让表单冻结在那儿，看起来像「点了没反应」。
  // 想手动刷新模型列表（新装了 LoRA / 换了 checkpoint）用左栏「刷新状态」。
  if (!Array.isArray(state.models?.checkpoints) || !state.models.checkpoints.length) {
    try { state.models = await api.get('/api/comfy/models'); } catch (_) { state.models = {}; }
  }
  loraFiles.value = state.models?.loras || [];
  // 只编辑选中的那条；删掉/新建后指向有效条目（过去写死 profiles[0]）
  state.settingsPid = state.profiles.some((x) => x.id === state.settingsPid)
    ? state.settingsPid : (state.profiles[0]?.id ?? null);
  fillDraft(state.profiles.find((x) => x.id === state.settingsPid) || null, state.settingsPid);
  token.value = localStorage.getItem('gacha_token') || '';
  mountVue(SettingsView);
}

// 「刷新状态」用的轻量刷新：只重拉 ComfyUI 状态与配置，不动池子/配方这些重活。
async function refreshStatusOnly() {
  try {
    state.comfy = await api.get('/api/comfy/status');
    state.config = await api.get('/api/config');
    updateStatus();
  } catch (_) { /* 状态灯静默 */ }
}

// ---- 动作注册表：data-act → 处理器（app.js 事件委派调用）----
export const actions = {
  'comfy-refresh': async () => {
    await refreshStatusOnly();
    // 「刷新状态」显式重拉模型列表：新装的 LoRA / checkpoint 要靠它出现
    try { state.models = await api.get('/api/comfy/models'); } catch (_) { /* 保留旧列表 */ }
    await refresh('settings');
  },
  'profile-new': async () => {
    // 切到空白草稿：过去这里 refresh('settings') 会被 renderSettings 的
    // 「pid 无效就回落到 profiles[0]」再拽回第一条预设，表现是「点新建没反应」
    fillDraft(null, null);
    done('已切到新建：填好参数后点「保存预设」');
  },
  'profile-del': async () => {
    const pid = draft.id;
    if (!pid) return;
    if (!confirm(`确定删除预设「${draft.name || pid}」？被配方引用时会删除失败。`)) return;
    await api.del(`/api/gen-profiles/${pid}`);
    state.profiles = await api.get('/api/gen-profiles');
    if (String(state.form.gen_profile_id) === String(pid)) state.form.gen_profile_id = '';
    state.settingsPid = null;
    persistForm(state);
    done('预设已删除');
    await refresh('settings');
  },
  'profile-save': async () => {
    const saved = await api.post('/api/gen-profiles', settingsBody(state, draft, loras));
    state.profiles = await api.get('/api/gen-profiles');
    state.settingsPid = saved.id;
    done(`预设已保存：${saved.name}`);
    await refresh('settings');
  },
};
