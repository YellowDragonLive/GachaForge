import { api } from '../api.js';
import { cut, esc } from '../detail.js';
import { state } from '../store.js';
import { matchQuery, poolSearchText, quickFilterHtml } from '../widgets.js';
import { refresh } from '../core/router.js';
import { $, done, view } from '../core/ui.js';

// 卡池管理视图：池开关、条目浏览、导入与回滚。

// ---------------- 卡池管理 ----------------
export async function renderPools() {
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

// ---- 动作注册表：data-act → 处理器（app.js 事件委派调用）----
export const actions = {
  'pool-toggle': async (btn) => {
    const id = Number(btn.dataset.id);
    await api.put(`/api/pools/${id}`, { enabled: btn.dataset.on === '1' });
    state.pools = await api.get('/api/pools'); await refresh('pools');
  },
  'pool-items': async (btn) => {
    const id = Number(btn.dataset.id);
    state.openPool = id; await refresh('pools');
  },
  'pool-close': async () => {
    state.openPool = null; await refresh('pools');
  },
  'import': async () => {
    const path = $('#importPath').value.trim();
    if (!path) throw new Error('请填写导入路径');
    const r = await api.post('/api/pools/import', { path });
    state.pools = await api.get('/api/pools');
    state.batches = await api.get('/api/pools/batches');
    done(`导入完成：${r.pools} 池 / ${r.items} 条`); await refresh('pools');
  },
  'rollback': async (btn) => {
    const id = Number(btn.dataset.id);
    await api.del(`/api/pools/batches/${id}`);
    state.pools = await api.get('/api/pools');
    state.batches = await api.get('/api/pools/batches');
    done('批次已回滚'); await refresh('pools');
  },
};
