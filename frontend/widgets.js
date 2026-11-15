// 可选控件的纯函数层：零框架、零 DOM 依赖、零 import。
// 浏览器由 app.js 直接 import；Node 单测用 data URL 加载，无需 package.json。
// 这里自带一份极简转义（与 detail.js 相同的规则），是为了保持本模块可独立加载。
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const cut = (s, n = 60) => {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n) + '…' : t;
};

const clean = (s) => String(s ?? '').replace(/[,，]/g, ' ').replace(/\s+/g, ' ').trim();

// ---------------- 过滤条件：点选生成，不再手打 `角色:fate` ----------------
/** `角色:asuna, fate` → [{pool, tag, raw}]；裸关键字的 pool 为空。 */
export function parseFilterSpec(spec) {
  // 注意：这里不能走 clean()——它会对单个值去掉逗号，用在整条表达式上会把条件粘连。
  return String(spec ?? '').split(/[,，]/).map((s) => s.trim()).filter(Boolean).map((raw) => {
    const m = raw.match(/^(.*?)\s*[:：]\s*(.+)$/);
    return m ? { pool: m[1].trim(), tag: m[2].trim(), raw }
             : { pool: '', tag: raw, raw };
  });
}

/** 追加一条过滤条件（同池同 tag 去重），返回可提交给后端的表达式。 */
export function addFilter(spec, pool, tagArg) {
  const tag = clean(tagArg);
  const p = clean(pool);
  if (!tag) return String(spec ?? '');
  const rows = parseFilterSpec(spec);
  // 已有同条件（大小写不敏感）就不重复添加，也不改写用户原值的大小写
  if (rows.some((r) => r.pool.toLowerCase() === p.toLowerCase() &&
                       r.tag.toLowerCase() === tag.toLowerCase())) {
    return rows.map((r) => r.raw).join(', ');
  }
  rows.push({ pool: p, tag, raw: p ? `${p}:${tag}` : tag });
  return rows.map((r) => r.raw).join(', ');
}

export function removeFilter(spec, index) {
  const rows = parseFilterSpec(spec);
  rows.splice(Number(index), 1);
  return rows.map((r) => r.raw).join(', ');
}

/** 已选条件，每条带一个删除按钮。裸关键字单独标黄提示是全局过滤。 */
export function filterChipsHtml(spec) {
  const rows = parseFilterSpec(spec);
  if (!rows.length) return '<span class="hint">未设置过滤 · 抽全部卡池</span>';
  return rows.map((r, i) => {
    const label = r.pool ? `${r.pool} : ${r.tag}` : `${r.tag}（全局）`;
    return `<span class="chip ${r.pool ? 'hl' : 'warn'} removable">${esc(cut(label, 42))}
      <button type="button" class="chip-x" data-act="filter-del" data-i="${i}"
        title="移除此条件" aria-label="移除 ${esc(label)}">×</button></span>`;
  }).join('');
}

/** 热门 tag：点一下直接加为条件，用户完全不用打字。 */
export function hotTagChipsHtml(items) {
  const rows = (items || []).filter((x) => x && x.value && x.source !== 'label');
  if (!rows.length) return '<span class="hint">暂无候选</span>';
  return rows.map((x) => `<button type="button" class="chip hot" data-act="filter-hot"
    data-v="${esc(x.value)}" title="出现 ${x.count} 次">${esc(cut(x.value, 24))}</button>`).join('');
}

/** 作用池下拉：类别（推荐）+ 具体池两层，全部池 = 裸关键字。
 *  value 用 name / kind —— 与后端 apply_filter_spec 的 `pk in slug` / `pk == kind` 对应；
 *  含冒号的池名不能作为值，否则会被过滤表达式的 `:` 截断。 */
export function poolOptionsHtml(pools, selected) {
  const list = Array.isArray(pools) ? pools : [];
  const kinds = new Map();
  for (const p of list) {
    const k = String(p.kind || '其他');
    const v = kinds.get(k) || { pools: 0, items: 0 };
    v.pools += 1; v.items += Number(p.item_count || 0);
    kinds.set(k, v);
  }
  const sel = (v) => String(v) === String(selected ?? '') ? 'selected' : '';
  const byKind = new Map();
  for (const p of list) {
    const name = String(p.name || '');
    if (!name || /[:：]/.test(name)) continue;
    if (!byKind.has(p.kind || '其他')) byKind.set(p.kind || '其他', []);
    byKind.get(p.kind || '其他').push(p);
  }
  return `<option value="" ${sel('')}>全部卡池 · 裸关键字（会作用于所有池）</option>
    <optgroup label="按类别（推荐）">${[...kinds.entries()]
      .sort((a, b) => b[1].items - a[1].items)
      .map(([k, v]) => `<option value="${esc(k)}" ${sel(k)}>${esc(k)} · ${v.pools} 池 / ${v.items} 条</option>`)
      .join('')}</optgroup>
    ${[...byKind.entries()].map(([k, ps]) => `<optgroup label="指定卡池 · ${esc(k)}">${ps
      .map((p) => `<option value="${esc(p.name)}" ${sel(p.name)}>${esc(cut(p.name, 52))} · ${p.item_count || 0} 条</option>`)
      .join('')}</optgroup>`).join('')}`;
}

export function tagOptionsHtml(items, selected) {
  const rows = (items || []).filter((x) => x && x.value);
  const sel = (v) => String(v) === String(selected ?? '') ? 'selected' : '';
  const extra = selected && !rows.some((x) => String(x.value) === String(selected))
    ? `<option value="${esc(selected)}" selected>${esc(selected)}</option>` : '';
  return `<option value="">（选一个 tag）</option>${extra}${rows.map((x) =>
    `<option value="${esc(x.value)}" ${sel(x.value)}>${esc(cut(x.value, 48))} · ${x.count} 条${x.source === 'label' ? ' · 条目名' : ''}</option>`
  ).join('')}`;
}

// ---------------- LoRA：下拉 + 权重行，自动组装 JSON ----------------
export function normalizeLoras(raw) {
  let rows = raw;
  if (typeof rows === 'string') {
    try { rows = JSON.parse(rows); } catch (_) { rows = []; }
  }
  if (!Array.isArray(rows)) rows = [];
  const seen = new Set();
  const out = [];
  for (const x of rows) {
    const name = String((x && x.name) || '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const w = Number((x && x.weight) ?? 1);
    out.push({ name, weight: Number.isFinite(w) ? Math.max(-4, Math.min(4, w)) : 1 });
  }
  return out;
}

export function loraOptionsHtml(available, chosen) {
  const used = new Set(normalizeLoras(chosen).map((x) => x.name));
  const list = Array.isArray(available) ? available : [];
  return `<option value="">（选择 LoRA 文件）</option>${list.map((name) =>
    `<option value="${esc(name)}" ${used.has(String(name)) ? 'disabled' : ''}>${esc(cut(String(name), 64))}${used.has(String(name)) ? ' · 已添加' : ''}</option>`
  ).join('')}`;
}

export function loraRowsHtml(loras) {
  const rows = normalizeLoras(loras);
  if (!rows.length) return '<div class="hint">尚未添加 LoRA · 留空即只用 checkpoint</div>';
  return rows.map((x, i) => `<div class="lora-row" data-i="${i}">
    <span class="lora-name" title="${esc(x.name)}">${esc(cut(x.name, 46))}</span>
    <label class="mini">权重<input type="number" data-lora-w="${i}" step="0.05" min="-4" max="4"
      value="${x.weight}"></label>
    <button type="button" class="btn small" data-act="lora-up" data-i="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
    <button type="button" class="btn small" data-act="lora-down" data-i="${i}" ${i === rows.length - 1 ? 'disabled' : ''}>↓</button>
    <button type="button" class="btn small danger" data-act="lora-del" data-i="${i}">移除</button>
  </div>`).join('');
}

// ---------------- 配方槽位：可视化表格替代手写 JSON ----------------
export function normalizeSlots(raw) {
  let rows = raw;
  if (typeof rows === 'string') {
    try { rows = JSON.parse(rows); } catch (_) { rows = []; }
  }
  if (!Array.isArray(rows)) rows = [];
  return rows.map((x) => ({
    pool: String((x && x.pool) || ''),
    count: Math.max(1, Math.min(20, Number((x && x.count) ?? 1) || 1)),
    weight: Math.max(0, Math.min(1, Number((x && x.weight) ?? 1))),
    filter: String((x && x.filter) || ''),
  }));
}

/** 槽位的池下拉：类别优先，其次具体池；当前值不在列表里也保留，避免编辑时丢失。 */
export function slotPoolOptionsHtml(pools, selected) {
  const list = Array.isArray(pools) ? pools : [];
  const kinds = [...new Set(list.map((p) => String(p.kind || '其他')))];
  const sel = (v) => String(v) === String(selected ?? '') ? 'selected' : '';
  const extra = selected && !kinds.includes(String(selected)) &&
    !list.some((p) => String(p.name) === String(selected))
    ? `<option value="${esc(selected)}" selected>${esc(selected)}（自定义）</option>` : '';
  return `<option value="" ${sel('')}>（不选池）</option>${extra}
    <optgroup label="按类别">${kinds.map((k) =>
      `<option value="${esc(k)}" ${sel(k)}>${esc(k)}</option>`).join('')}</optgroup>
    <optgroup label="指定卡池">${list.filter((p) => !/[:：]/.test(String(p.name || '')))
      .map((p) => `<option value="${esc(p.name)}" ${sel(p.name)}>${esc(cut(p.name, 46))}</option>`)
      .join('')}</optgroup>`;
}

export function slotRowsHtml(slots, pools, hotTags) {
  const rows = normalizeSlots(slots);
  if (!rows.length) return '<div class="hint">还没有槽位 · 点下方「＋ 添加槽位」，或展开高级模式粘贴 JSON</div>';
  // datalist 由 recipeForm 统一输出一份（重复 id 在 HTML 里非法，浏览器只认第一个）
  void hotTags;
  return rows.map((s, i) => `<div class="slot-row" data-slot-row="${i}">
    <span class="slot-idx">${i + 1}</span>
    <label class="mini">卡池<select data-slot="pool" data-i="${i}">${slotPoolOptionsHtml(pools, s.pool)}</select></label>
    <label class="mini">条数<input type="number" data-slot="count" data-i="${i}" min="1" max="20" value="${s.count}"></label>
    <label class="mini">权重<input type="number" data-slot="weight" data-i="${i}" min="0" max="1" step="0.1" value="${s.weight}"></label>
    <label class="mini">tag 过滤<input type="text" data-slot="filter" data-i="${i}" list="slotTagList"
      value="${esc(s.filter)}" placeholder="留空 = 不过滤，点开可选热门 tag"></label>
    <button type="button" class="btn small" data-act="slot-up" data-i="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
    <button type="button" class="btn small" data-act="slot-down" data-i="${i}" ${i === rows.length - 1 ? 'disabled' : ''}>↓</button>
    <button type="button" class="btn small danger" data-act="slot-del" data-i="${i}">移除</button>
  </div>`).join('');
}
