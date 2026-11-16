// 配方编辑器视图（Vue）。
//
// 这一页的病根是槽位表：过去改一行就重绘整块 #slotRows，用户填「tag 过滤」打到一半
// 光标就跳走，只能重来。现在槽位是 reactive 数组 + v-model：改数据不碰 DOM，
// 光标原地不动，也不再需要「按 data-slot 找 index 再写回 state」那套 DOM 同步。
//
// 约定不变：按钮继续写 data-act，动作仍在下面的 actions 注册表里，由 app.js 委派。
import { api } from '../api.js';
import { cut } from '../detail.js';
import { state } from '../store.js';
import { normalizeSlots, poolOptionGroups } from '../widgets.js';
import { refresh } from '../core/router.js';
import { done } from '../core/ui.js';
import { defineComponent, mountVue, reactive, ref, toRaw, watch } from '../vue/index.js';

// ---- 视图状态（模块级：动作注册表要能读到，不经过 DOM）----
const editing = ref(null);          // 正在编辑的配方（null = 新建）
const recipes = ref([]);            // 左栏列表的快照
const form = reactive({ name: '', head: '', tail: '', template: '' });
const slots = reactive([]);         // 槽位草稿：v-model 直接改这里
const slotsJson = ref('');          // 高级 JSON 文本，随槽位变化同步
const preview = ref([]);            // [{ prompt }]
const tplPool = ref('');            // 模板插入用的池
let poolGroups = { custom: '', kinds: [], pools: [] };

// 槽位一改就把高级 JSON 重写一遍：两块视图必须是同一份数据，
// 否则用户会看到「表格改了、JSON 还是旧的」，保存时以哪个为准就成了谜。
watch(slots, () => {
  slotsJson.value = JSON.stringify(normalizeSlots(toRaw(slots)), null, 2);
}, { deep: true });

const RecipesView = defineComponent({
  name: 'RecipesView',
  setup() {
    return {
      editing, recipes, form, slots, slotsJson, preview, tplPool, poolGroups, state, cut,
      // 模板里判断当前槽位值是否「不在枚举里」：是的话补一条「（自定义）」，否则下拉会显示空
      poolKnown: (v) => !v || poolGroups.kinds.includes(v) || poolGroups.pools.some((p) => p.value === v),
      move(i, step) {
        const j = i + step;
        if (j < 0 || j >= slots.length) return;
        [slots[i], slots[j]] = [slots[j], slots[i]];
      },
      remove(i) { slots.splice(i, 1); },
      add() { slots.push({ pool: '', count: 1, weight: 1, filter: '' }); },
      addTag(tag) { form.template = (form.template ? form.template.trimEnd() + ', ' : '') + `__${tag}__`; },
    };
  },
  template: `
    <div class="grid-2">
      <div class="panel">
        <div class="panel-head"><h2>配方</h2>
          <button class="btn small" data-act="recipe-new">＋ 新建</button></div>
        <div v-for="r in recipes" :key="r.id" class="row"
          style="justify-content:space-between;border-bottom:1px solid var(--line);padding:7px 0">
          <button class="btn small" data-act="recipe-select" :data-id="r.id">{{ r.name }}</button>
          <span class="sub">v{{ r.version }}</span>
        </div>
        <p class="hint" v-if="!recipes.length">暂无配方</p>
      </div>

      <div class="panel">
        <div class="panel-head"><h2>{{ editing ? '编辑' : '新建' }}配方</h2>
          <div class="row">
            <button class="btn small" data-act="recipe-preview">预览 3 条</button>
            <button class="btn small primary" data-act="recipe-save">保存</button>
            <button v-if="editing" class="btn small danger" data-act="recipe-del">删除</button>
          </div></div>

        <div class="field"><span>配方名</span>
          <input type="text" v-model="form.name" placeholder="如 角色 × 风格"></div>

        <div class="field" style="margin-top:8px"><span>固定头部（质量词 / 主体）</span>
          <textarea v-model="form.head" style="min-height:56px"></textarea></div>

        <div class="field picker" style="margin-top:12px"><span>槽位 · 点选配置，无需手写 JSON</span>
          <div v-for="(s, i) in slots" :key="i" class="slot-row">
            <span class="slot-idx">{{ i + 1 }}</span>
            <label class="mini">卡池
              <select v-model="s.pool">
                <option value="">（不选池）</option>
                <option v-if="s.pool && !poolKnown(s.pool)" :value="s.pool">{{ s.pool }}（自定义）</option>
                <optgroup label="按类别">
                  <option v-for="k in poolGroups.kinds" :key="k" :value="k">{{ k }}</option>
                </optgroup>
                <optgroup label="指定卡池">
                  <option v-for="p in poolGroups.pools" :key="p.value" :value="p.value">{{ p.text }}</option>
                </optgroup>
              </select></label>
            <label class="mini">条数
              <input type="number" v-model.number="s.count" min="1" max="20"></label>
            <label class="mini">权重
              <input type="number" v-model.number="s.weight" min="0" max="1" step="0.1"></label>
            <label class="mini">tag 过滤
              <input type="text" v-model="s.filter" list="slotTagList"
                placeholder="留空 = 不过滤，点开可选热门 tag"></label>
            <button type="button" class="btn small" @click="move(i, -1)" :disabled="i === 0">↑</button>
            <button type="button" class="btn small" @click="move(i, +1)" :disabled="i === slots.length - 1">↓</button>
            <button type="button" class="btn small danger" @click="remove(i)">移除</button>
          </div>
          <div class="hint" v-if="!slots.length">还没有槽位 · 点下方「＋ 添加槽位」，或展开高级模式粘贴 JSON</div>
          <datalist id="slotTagList">
            <option v-for="t in state.hotTags" :key="t.value" :value="t.value"></option>
          </datalist>
          <div class="row" style="margin-top:8px">
            <button class="btn small" @click="add">＋ 添加槽位</button>
            <button class="btn small" data-act="slot-apply-json">读取下方 JSON</button></div>
          <div class="hint">槽位里的 tag 过滤只在抽卡台「按池过滤」<b>留空</b>时生效；表单填了过滤会以表单为准。</div>
          <details class="advanced"><summary>高级：直接编辑 / 粘贴槽位 JSON</summary>
            <textarea v-model="slotsJson" style="min-height:110px"></textarea>
            <div class="hint">改完点上方「读取下方 JSON」，保存时也会以这里的内容为准。</div></details>
        </div>

        <div class="field" style="margin-top:8px"><span>模板（__池名__ / __池名#3__ / __池名~__）</span>
          <div class="row" style="margin-bottom:6px">
            <input type="text" class="qf" data-qf="rTplPool" autocomplete="off" spellcheck="false"
              style="max-width:280px" placeholder="筛选池：输入片段" title="筛选池：输入片段">
            <span class="hint" data-qf-count="rTplPool"></span></div>
          <div class="row" style="margin-bottom:6px">
            <select id="rTplPool" v-model="tplPool" style="max-width:280px">
              <option value="">（不选池）</option>
              <optgroup label="按类别">
                <option v-for="k in poolGroups.kinds" :key="k" :value="k">{{ k }}</option>
              </optgroup>
              <optgroup label="指定卡池">
                <option v-for="p in poolGroups.pools" :key="p.value" :value="p.value">{{ p.text }}</option>
              </optgroup>
            </select>
            <button class="btn small" @click="addTag(tplPool)" :disabled="!tplPool">插入 __池名__</button></div>
          <textarea v-model="form.template" style="min-height:56px"></textarea></div>

        <div class="field" style="margin-top:8px"><span>固定尾部</span>
          <input type="text" v-model="form.tail"></div>

        <div v-if="preview.length" style="margin-top:12px">
          <h3>预览</h3>
          <div v-for="(t, i) in preview" :key="i" class="chip"
            style="display:block;margin-bottom:6px">[{{ i + 1 }}] {{ cut(t, 220) }}</div>
        </div>
      </div>
    </div>`,
});

/** 把一条配方的 definition 摊进表单草稿。切换配方时复用，不重新挂载组件。 */
function fillForm(r) {
  editing.value = r;
  const def = r?.definition || { fixed_head: 'masterpiece, best quality, 1girl', slots: [], template: '', fixed_tail: '' };
  form.name = r?.name || '';
  form.head = def.fixed_head || '';
  form.tail = def.fixed_tail || '';
  form.template = def.template || '';
  // 新建时给一条空槽位；已有配方哪怕槽位为空也照实显示（空 = 真的没配槽位）
  const rows = normalizeSlots(r?.definition?.slots ?? [{ pool: '', count: 1, weight: 1, filter: '' }]);
  slots.splice(0, slots.length, ...rows);
  slotsJson.value = JSON.stringify(normalizeSlots(toRaw(slots)), null, 2);
  preview.value = [];
}

/**
 * 读表单 → 配方 body。
 *
 * 槽位以高级 JSON 为准：用户可能直接粘贴旧配方，那张表格没动过也不该覆盖他粘的内容。
 * 反过来，改表格会同步 JSON（见上面的 watch），所以两边永远一致。
 */
function readBody() {
  let rows = normalizeSlots(toRaw(slots));
  let parsed;
  try { parsed = JSON.parse(slotsJson.value || '[]'); }
  catch (e) { throw new Error('槽位 JSON 格式不对：' + e.message); }
  if (!Array.isArray(parsed)) throw new Error('槽位必须是数组');
  rows = normalizeSlots(parsed);
  return {
    name: form.name.trim(),
    definition: {
      fixed_head: form.head, fixed_tail: form.tail,
      template: form.template, slots: rows,
    },
  };
}

export async function renderRecipes() {
  recipes.value = state.recipes.slice();
  poolGroups = poolOptionGroups(state.pools, '');
  fillForm(state.editingRecipe || null);
  tplPool.value = '';
  mountVue(RecipesView);
}

// ---- 动作注册表：data-act → 处理器（app.js 事件委派调用）----
export const actions = {
  'recipe-new': async () => {
    state.editingRecipe = null;
    fillForm(null);
  },
  'recipe-select': async (btn) => {
    const id = Number(btn.dataset.id);
    state.editingRecipe = state.recipes.find((r) => r.id === id) || null;
    fillForm(state.editingRecipe);
  },
  'recipe-save': async () => {
    const body = readBody();
    if (!body.name) throw new Error('配方名不能为空');
    const url = state.editingRecipe ? `/api/recipes/${state.editingRecipe.id}` : '/api/recipes';
    await (state.editingRecipe ? api.put(url, body) : api.post(url, body));
    state.recipes = await api.get('/api/recipes');
    state.editingRecipe = null;
    done('配方已保存');
    await refresh('recipes');
  },
  'recipe-del': async () => {
    // 删除的是「当前编辑的那条」：按钮上不挂 data-id，靠状态比靠 DOM 可靠
    const id = state.editingRecipe?.id;
    if (!id) throw new Error('没有正在编辑的配方');
    await api.del(`/api/recipes/${id}`);
    state.recipes = await api.get('/api/recipes');
    state.editingRecipe = null;
    done('配方已删除');
    await refresh('recipes');
  },
  'recipe-preview': async () => {
    const body = readBody();
    const res = await api.post('/api/recipes/preview?pulls=3', body.definition);
    preview.value = res.map((r) => r.prompt);
  },
  'slot-apply-json': async () => {
    let parsed;
    try { parsed = JSON.parse(slotsJson.value || '[]'); }
    catch (e) { throw new Error('槽位 JSON 格式不对：' + e.message); }
    if (!Array.isArray(parsed)) throw new Error('槽位必须是数组');
    slots.splice(0, slots.length, ...normalizeSlots(parsed));
    done(`已读取 ${slots.length} 个槽位`);
  },
};
