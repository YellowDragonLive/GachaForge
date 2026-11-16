// 卡池管理视图（Vue）。
//
// 这一页最能看出 Vue 值在哪：568 行表格的搜索原来是「逐行 style.display = 'none'」，
// 现在是一个 computed —— 数据不动、DOM 只增删命中的行，不碰样式，也不用给每行塞 data-qtext。
//
// 约定不变：按钮继续写 data-act，动作仍在下面的 actions 注册表里，由 app.js 委派。
import { api } from '../api.js';
import { cut } from '../detail.js';
import { state } from '../store.js';
import { matchQuery, poolSearchText } from '../widgets.js';
import { refresh } from '../core/router.js';
import { $, done } from '../core/ui.js';
import { computed, defineComponent, mountVue, ref } from '../vue/index.js';

const pools = ref([]);
const batches = ref([]);
const q = ref('');            // 池名 / 类别 / 来源筛选
const openPool = ref(null);   // 正在预览条目的池 id
const items = ref(null);      // { pool, items: [], total }
const itemQ = ref('');
const importPath = ref('');

// 池名 + 类别 + 别名一起搜：搜「艺术家」也要能搜到「画师图鉴」
const filteredPools = computed(() => {
  const kw = q.value;
  return pools.value.filter((p) => matchQuery(poolSearchText(p) + ' ' + (p.source || ''), kw));
});
const totalItems = computed(() => pools.value.reduce((a, p) => a + (p.item_count || 0), 0));
const filteredItems = computed(() => {
  const list = items.value?.items || [];
  return list.filter((i) => matchQuery(`${i.label} ${i.tags}`, itemQ.value));
});

const PoolsView = defineComponent({
  name: 'PoolsView',
  setup() {
    return { pools, batches, q, openPool, items, itemQ, importPath,
      filteredPools, filteredItems, totalItems, cut };
  },
  template: `
    <div>
      <div class="panel">
        <div class="panel-head"><h2>卡池</h2>
          <span class="sub">共 {{ pools.length }} 池 / {{ totalItems }} 条</span></div>
        <div class="row" style="margin-bottom:10px">
          <input type="text" v-model="q" placeholder="搜索池名 / 类别" style="max-width:280px">
          <span class="hint">冷存池不参与抽卡，可手动启用</span>
          <span class="hint" v-if="q">命中 {{ filteredPools.length }} 池</span>
        </div>
        <div class="scroll"><table>
          <thead><tr><th>名称</th><th>类别</th><th>条数</th><th>来源</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="p in filteredPools" :key="p.id">
              <td><span v-if="!p.enabled" class="chip">冷存</span>{{ p.name }}</td>
              <td><span class="chip hl">{{ p.kind }}</span></td>
              <td>{{ p.item_count }}</td>
              <td>{{ p.source }}</td>
              <td>
                <button class="btn small" data-act="pool-toggle" :data-id="p.id"
                  :data-on="p.enabled ? 0 : 1">{{ p.enabled ? '停用' : '启用' }}</button>
                <button class="btn small" data-act="pool-items" :data-id="p.id">条目</button>
              </td>
            </tr>
          </tbody>
        </table></div>
      </div>

      <div class="panel" v-if="items">
        <div class="panel-head"><h3>条目预览（前 {{ filteredItems.length }} / {{ items.total }}）</h3>
          <button class="btn small" data-act="pool-close">关闭</button></div>
        <div class="row" style="margin-bottom:8px">
          <input type="text" v-model="itemQ" placeholder="筛选条目：label / tags" style="max-width:999px">
          <span class="hint">{{ filteredItems.length }} / {{ items.items.length }} 条</span></div>
        <div class="scroll">
          <div v-for="(i, idx) in filteredItems" :key="idx" class="chip"
            style="display:block;margin-bottom:4px">
            {{ cut(i.label, 60) }} <span class="sub">→ {{ cut(i.tags, 80) }}</span></div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head"><h2>导入与批次</h2></div>
        <div class="row">
          <input type="text" v-model="importPath" id="importPath"
            placeholder="项目内相对路径，如 vendor/.../wildcards 或 my_pool.json" style="max-width:460px">
          <button class="btn" data-act="import">导入</button></div>
        <p class="hint">支持 .json（任意结构）、.csv（中文名,英文 tag）、目录（每个 .txt 一个词卡池）。重复导入会自动跳过同名池。</p>
        <div class="scroll" style="margin-top:10px"><table>
          <thead><tr><th>批次</th><th>类型</th><th>条数</th><th>来源</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="b in batches" :key="b.id">
              <td>#{{ b.id }}</td><td>{{ b.kind }}</td><td>{{ b.item_count }}</td>
              <td class="sub">{{ cut(b.source_path, 46) }}</td>
              <td><button class="btn small danger" data-act="rollback" :data-id="b.id">回滚</button></td>
            </tr>
          </tbody>
        </table></div>
      </div>
    </div>`,
});

export async function renderPools() {
  pools.value = state.pools.slice();
  batches.value = state.batches.slice();
  openPool.value = state.openPool || null;
  if (state.openPool) {
    items.value = await api.get(`/api/pools/${state.openPool}/items?q=`);
  } else {
    items.value = null;
  }
  mountVue(PoolsView);
}

// ---- 动作注册表：data-act → 处理器（app.js 事件委派调用）----
export const actions = {
  'pool-toggle': async (btn) => {
    const id = Number(btn.dataset.id);
    await api.put(`/api/pools/${id}`, { enabled: btn.dataset.on === '1' });
    state.pools = await api.get('/api/pools'); await refresh('pools');
  },
  'pool-items': async (btn) => {
    state.openPool = Number(btn.dataset.id); await refresh('pools');
  },
  'pool-close': async () => {
    state.openPool = null; await refresh('pools');
  },
  'import': async () => {
    // 输入框留着 id：action 直接读 DOM 值，组件里的 v-model 只是让重绘不吞掉已输入的文字
    const path = $('#importPath').value.trim();
    if (!path) throw new Error('请填写导入路径');
    const r = await api.post('/api/pools/import', { path });
    state.pools = await api.get('/api/pools');
    state.batches = await api.get('/api/pools/batches');
    done(`导入完成：${r.pools} 池 / ${r.items} 条`); await refresh('pools');
  },
  'rollback': async (btn) => {
    await api.del(`/api/pools/batches/${Number(btn.dataset.id)}`);
    state.pools = await api.get('/api/pools');
    state.batches = await api.get('/api/pools/batches');
    done('批次已回滚'); await refresh('pools');
  },
};
