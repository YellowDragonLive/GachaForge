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

/**
 * 找出「已点选、但当前配方没有对应槽位」的过滤条件。
 * 后端会自动补一个槽位把 tag 写进 prompt；前端提前说明，不用等抽完才发现。
 * recipe 形状：{definition:{slots:[{pool}]}}；pools：[{name, kind}]。
 * 类别名（如「画师」）与具体池名（如「zh_TW」）统一折算成 kind 再比较。
 */
export function missingFilterSlots(spec, recipe, pools) {
  const rows = parseFilterSpec(spec).filter((r) => r.pool);
  const def = recipe && recipe.definition;
  if (!rows.length || !def) return [];
  const kindOf = (key) => {
    const k = String(key || '').trim();
    if (!k) return '';
    const hit = (pools || []).find((p) => p.name === k);
    return (hit && hit.kind) ? hit.kind : k;
  };
  const covered = new Set(
    (Array.isArray(def.slots) ? def.slots : [])
      .map((s) => kindOf(s.pool).toLowerCase()).filter(Boolean));
  return rows.filter((r) => !covered.has(kindOf(r.pool).toLowerCase()));
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

// ---------------- 通用概念缩略图卡片 ----------------
// 抽象概念一律先用图判断：画师 / tag / 动作 / 角色 / 底模 / LoRA / 配方都走同一套卡片。
// 缩略图主要来自抽卡数据库已有的真实出图，风格锚点作为补充；点选即写入过滤条件。
const safeUrl = (u) => {
  const s = String(u || '');
  return s.startsWith('/api/') ? s : '';   // 只接受本服务只读图片端点
};

export function normalizeConcepts(raw) {
  const rows = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const out = [];
  for (const c of rows) {
    if (!c || typeof c !== 'object') continue;
    const key = String(c.key ?? c.label ?? '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const thumbs = (Array.isArray(c.thumbs) ? c.thumbs : [])
      .map((t) => ({ id: (t && t.id) || '', url: safeUrl(t && t.url) }))
      .filter((t) => t.url);
    const fallback = safeUrl(c.thumb_url);
    out.push({
      key, label: String(c.label ?? key), kind: String(c.kind ?? '概念'),
      pool: String(c.pool ?? ''), filterable: c.filterable !== false,
      image_count: Number(c.image_count ?? 0) || 0,
      draw_count: Number(c.draw_count ?? 0) || 0,
      thumbs: thumbs.length ? thumbs : (fallback ? [{ id: '', url: fallback }] : []),
      thumb_url: fallback,
    });
  }
  return out;
}

/** 单张概念卡：默认只有文字，图片由 hover / focus 按需拉一张封面浮出。
 *  点卡片 = 加入过滤；点概念名 = 进详情页看最多 50 张历史图。 */
export function conceptCardHtml(c, selected = false) {
  const row = normalizeConcepts([c])[0] || { key: '', label: '', kind: '概念', pool: '', filterable: true, image_count: 0, thumbs: [] };
  const act = row.filterable
    ? `data-act="concept-pick" data-v="${esc(row.key)}" data-pool="${esc(row.pool)}"`
    : `data-act="concept-open" data-key="${esc(row.key)}"`;
  const scope = row.filterable ? (row.pool ? `按 ${row.pool} 池` : '全局') : '仅展示';
  return `<div class="concept-card${selected ? ' picked' : ''}" data-key="${esc(row.key)}"
    data-cover-key="${esc(row.key)}" tabindex="0">
    <button type="button" class="concept-hit" ${act}
      title="${esc(row.label)} · ${esc(row.kind)} · ${row.image_count} 张真实出图 · 点卡片加入过滤">
      <span class="concept-fig" aria-hidden="true">${esc(String(row.label || '?').slice(0, 1).toUpperCase())}</span>
      <span class="concept-meta">
        <span class="concept-kind">${esc(row.kind)} · ${esc(scope)}</span>
        <span class="concept-count">${row.image_count} 张出图 / ${row.draw_count} 次抽到</span>
      </span>
    </button>
    <a class="concept-open" href="#/concept/${encodeURIComponent(row.key)}"
      title="看这个概念的 ${row.image_count} 张历史出图">${esc(cut(row.label, 26))} →</a>
  </div>`;
}

export function conceptCardsHtml(cards, opts = {}) {
  const rows = normalizeConcepts(cards);
  if (!rows.length) {
    return '<div class="hint concept-empty">数据库里还没有已出图的概念 · 先抽几次卡，这里会自动长出样图</div>';
  }
  const sel = new Set((opts.selectedKeys || []).map((x) => String(x).toLowerCase()));
  return `<div class="concept-wall">${rows.map((c) =>
    conceptCardHtml(c, sel.has(c.key.toLowerCase()))).join('')}</div>`;
}

export function conceptKindChipsHtml(kinds, selected) {
  const rows = (Array.isArray(kinds) ? kinds : []).filter((k) => k && k.kind);
  const cur = String(selected ?? '');
  const chip = (v, label, count) => `<button type="button" class="chip hot${String(v) === cur ? ' on' : ''}"
    data-act="concept-kind" data-v="${esc(v)}">${esc(label)}${count ? ' · ' + Number(count) : ''}</button>`;
  return chip('', '全部') + rows.map((k) => chip(k.kind, k.kind, k.count)).join('');
}

/** 语义检索结果：只留一个外部风格锚点 URL，hover 时才加载那一张图。
 *  「我的出图」不再叠在卡片上，收进概念详情页。 */
export function semanticCardsHtml(items) {
  const rows = (Array.isArray(items) ? items : []).filter((x) => x && x.name);
  if (!rows.length) {
    return '<div class="hint">输入一句想要的感觉来找画师，或直接看下方数据库概念墙</div>';
  }
  return `<div class="concept-wall semantic-wall">${rows.map((x) => {
    const anchor = safeUrl(x.thumb_url);
    const reasons = (Array.isArray(x.reason) ? x.reason : [])
      .map((r) => String((r && r.tag) || '')).filter(Boolean).slice(0, 3);
    const badges = [x.core && '核心', x.selected && '精选', x.favorite && '收藏'].filter(Boolean);
    const count = (x.history && x.history.image_count) || 0;
    return `<div class="concept-card semantic-card" tabindex="0"
      data-cover-key="${esc(x.name)}" data-cover-url="${esc(anchor)}"
      data-cover-count="${Number(count) || 0}">
      <button type="button" class="concept-hit" data-act="semantic-pick" data-v="${esc(x.name)}"
        title="点一下按画师过滤：画师:${esc(x.name)}">
        <span class="concept-fig" aria-hidden="true">${esc(String(x.name || '?').slice(0, 1).toUpperCase())}</span>
        <span class="concept-meta">
          <span class="concept-kind">${esc(badges.join(' · ') || '画师')}</span>
          <span class="concept-count">${esc(reasons.join(' / ') || (count ? `我用它出过 ${count} 张` : '风格参考'))}</span>
        </span>
      </button>
      <a class="concept-open" href="#/concept/${encodeURIComponent(x.name)}"
        title="看这个画师的历史出图">${esc(cut(x.name, 24))} →</a>
    </div>`;
  }).join('')}</div>`;
}

/** 抽卡结果卡：只给概念 chip，悬浮时按需拉一张代表图，不再一次铺多张 <img>。 */
export function conceptStripHtml(detail, thumbMap) {
  const rows = Array.isArray(detail) ? detail : [];
  const out = [];
  const seen = new Set();
  for (const s of rows) {
    if (!s || typeof s !== 'object' || s.empty || s.skipped) continue;
    const tags = Array.isArray(s.tags) ? s.tags
      : (typeof s.tags === 'string' ? [s.tags] : []);
    const cand = [...tags];
    if (s.label) cand.push(s.label);
    for (const raw of cand) {
      for (const part of String(raw).split(/[,，]/)) {
        const k = String(part).replace(/\\/g, '').trim().toLowerCase();
        if (k.length >= 3 && !seen.has(k)) { seen.add(k); out.push(k); }
        if (out.length >= 8) break;
      }
      if (out.length >= 8) break;
    }
    if (out.length >= 8) break;
  }
  if (!out.length) return '';
  return `<div class="concept-strip">${out.map((k) =>
    `<span class="strip-chip" data-cover-key="${esc(k)}" tabindex="0"
      title="悬浮看一张代表图 · 点进概念页看全部">${esc(cut(k, 24))}</span>`).join('')}</div>`;
}

/** hover 浮层：整个页面任何时刻只浮出一张代表图。 */
export function coverPopoverHtml(cover) {
  const c = cover && typeof cover === 'object' ? cover : {};
  const img = c.image && typeof c.image === 'object' ? c.image : null;
  const url = safeUrl(img && img.url);
  const inner = url
    ? `<img src="${esc(url)}" alt="${esc(c.key || '概念')} 的代表图">`
    : '<span class="concept-nopic">还没有出过图</span>';
  const meta = c.found
    ? `${Number(c.image_count || 0)} 张出图 · 点概念名看全部`
    : '数据库里还没有这个概念';
  return `<span class="cover-pop">${inner}<span class="cover-pop-meta">${esc(meta)}</span></span>`;
}

/** 五星评分：点第 n 颗 = n 分，点当前分 = 清零。
 *  比「点一次 +1」少 3 次点击，画廊与概念页也用同一套语义。 */
export function ratingStarsHtml(id, rating, opts = {}) {
  const cur = Math.max(0, Math.min(5, Number(rating) || 0));
  const draw = opts.draw ? ` data-draw="${opts.draw}"` : '';
  const stars = [1, 2, 3, 4, 5].map((n) =>
    `<button type="button" class="star${n <= cur ? ' on' : ''}" data-act="img-rate"
      data-id="${id}" data-v="${n === cur ? 0 : n}"${draw}
      title="${n === cur ? '点一下清除评分' : `评 ${n} 分`}">★</button>`).join('');
  return `<span class="stars" data-stars-for="${id}" aria-label="评分 ${cur} / 5">${stars}</span>`;
}

/** 概念详情页：首屏最多 50 张历史出图，可评分 / 收藏 / 加载更多。 */
export function conceptDetailHtml(d) {
  const page = d && typeof d === 'object' ? d : {};
  const items = Array.isArray(page.items) ? page.items : [];
  const key = String(page.key || '');
  const total = Number(page.total || 0);
  const tiles = items.map((x) => {
    const url = safeUrl(x && x.url);
    const id = Number(x && x.id) || 0;
    const rating = Number(x && x.rating) || 0;
    const fav = !!(x && x.favorite);
    return `<div class="concept-tile">
      <button type="button" class="tile-img" data-act="img-open" data-id="${id}" title="点开原图">
        ${url ? `<img src="${esc(url)}" alt="${esc(key)} 的历史出图" loading="lazy">`
              : '<span class="concept-nopic">无缩略图</span>'}
      </button>
      <div class="tile-bar">
        ${ratingStarsHtml(id, rating)}
        <button type="button" class="chip small${fav ? ' on' : ''}"
          data-act="img-fav" data-id="${id}" data-v="${fav ? 0 : 1}">${fav ? '♥ 收藏' : '♡ 收藏'}</button>
      </div>
    </div>`;
  }).join('');
  const more = items.length < total
    ? `<button type="button" class="btn small" data-act="concept-more">再加载最多 50 张</button>` : '';
  return `<div class="panel concept-detail">
    <div class="panel-head"><h2>${esc(page.label || key)}</h2>
      <span class="sub">${esc(page.kind || '概念')}${page.pool ? ' · ' + esc(page.pool) : ''} · 共 ${total} 张历史出图 · 首屏上限 50 张</span></div>
    <div class="row"><button type="button" class="btn small" data-act="concept-back">← 返回抽卡台</button>${more}</div>
    <div class="concept-grid">${tiles || '<div class="hint">这个概念还没有出过图</div>'}</div>
  </div>`;
}
