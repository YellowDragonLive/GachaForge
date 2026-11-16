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

// ---------------- 装配面板：场景 / 人物 → 配方定义 ----------------
// 人数不再是一个开关，而是「人物卡的张数」：0 张无人、1 张单人、N 张多人。
// 每张卡是一份独立的单人配置，所以「多人」永远不会出现两人共用一套衣服的错乱。

/** 人物的六个格子。off = 这格不参与；random = 每抽重摇；locked = 固定到 pick。 */
export const PERSON_SLOTS = [
  { key: 'role', label: '角色', kind: '角色', fallback: 'random' },
  { key: 'hair', label: '发型', kind: '发型', fallback: 'random' },
  { key: 'face', label: '表情', kind: '表情', fallback: 'off' },
  { key: 'outfit', label: '衣着', kind: '服装', fallback: 'random' },
  // 物品类下 69 个池混着食物/厨具（sausage、oven mitts），默认随机只会拉低出图质量，
  // 所以默认关闭：想要装备就点开，搜 sword / hat / glasses 这类具体词。
  { key: 'gear', label: '装备', kind: '物品', fallback: 'off' },
  { key: 'action', label: '动作', kind: '动作', fallback: 'off' },
];

/** 场景的三格：全局生效，不属于任何一个角色。 */
export const SCENE_SLOTS = [
  { key: 'background', label: '背景', kind: '背景', fallback: 'random' },
  { key: 'style', label: '画风', kind: '风格', fallback: 'random' },
  { key: 'composition', label: '构图', kind: '构图', fallback: 'off' },
];

export const SLOT_MODES = ['random', 'locked', 'off'];

/**
 * 一张新的人物卡：默认全是「随机」，只有表情/动作默认关掉，避免 prompt 膨胀。
 * tags 只在锁定后填（条目自带的英文 tag 串），用于状态栏立绘——label 是中文，
 * 概念 key 却是英文 tag，两者不能互相替代。
 */
export function makePerson(uid, gender = 'female') {
  const slots = {};
  for (const d of PERSON_SLOTS) {
    slots[d.key] = { kind: d.kind, mode: d.fallback, pick: '', tags: '' };
  }
  return { uid, gender, slots };
}

/** 场景默认值。 */
export function makeScene() {
  const scene = {};
  for (const d of SCENE_SLOTS) {
    scene[d.key] = { kind: d.kind, mode: d.fallback, pick: '', tags: '' };
  }
  return scene;
}

/**
 * 人数标签：由人物卡张数与各自的性别推导，不再依赖角色条目自带的 1girl。
 * 0 人 → no humans；2 人同性别 → 2girls；混合 → 1girl, 1boy。
 */
export function countTagsFor(people) {
  const list = Array.isArray(people) ? people.filter(Boolean) : [];
  if (!list.length) return 'no humans';
  const girls = list.filter((p) => p.gender === 'female').length;
  const boys = list.filter((p) => p.gender === 'male').length;
  const others = list.length - girls - boys;
  const parts = [];
  if (girls) parts.push(girls === 1 ? '1girl' : `${girls}girls`);
  if (boys) parts.push(boys === 1 ? '1boy' : `${boys}boys`);
  if (others) parts.push(others === 1 ? '1other' : `${others}others`);
  if (list.length >= 3) {
    if (girls >= boys && girls >= others) parts.push('multiple girls');
    else if (boys >= others) parts.push('multiple boys');
    else parts.push('multiple others');
  }
  return parts.join(', ') || '1girl';
}

/**
 * 装配状态 → 后端可执行的配方定义。
 * 顺序：场景（背景/画风/构图）→ 人物 1 的六格 → 人物 2 的六格 …
 * 这样 prompt 里同一角色的装扮挨在一起，不会和别人的混着。
 */
export function assemblyToDefinition(assembly) {
  const a = assembly && typeof assembly === 'object' ? assembly : {};
  const scene = a.scene && typeof a.scene === 'object' ? a.scene : {};
  const people = Array.isArray(a.people) ? a.people.filter(Boolean) : [];
  const slots = [];
  const push = (cfg) => {
    if (!cfg || cfg.mode === 'off') return;
    const slot = { pool: cfg.kind || '', count: 1, weight: 1 };
    if (cfg.mode === 'locked' && cfg.pick) slot.pick = cfg.pick;
    slots.push(slot);
  };
  SCENE_SLOTS.forEach((d) => push(scene[d.key]));
  people.forEach((p) => PERSON_SLOTS.forEach((d) => push(p.slots && p.slots[d.key])));
  return {
    fixed_head: 'masterpiece, best quality',
    count_tags: countTagsFor(people),
    slots,
  };
}

/** 装配是否真的有内容：全关 = 不算，避免把空定义发给后端。 */
export function assemblyIsEmpty(assembly) {
  return assemblyToDefinition(assembly).slots.length === 0;
}

// ---------------- 线稿小人：物品(prompt) → 人物部位 ----------------
// 一行字的「发型 随机」看不出它管的是哪儿，所以把槽位直接画到身体上：
// 点头发 = 换发型，点脸 = 换表情，点身体 = 换衣着，点手臂 = 换装备，点腿 = 换动作。
// 三态用线型表达：随机 = 虚线，锁定 = 实线加底色，关闭 = 淡到几乎看不见。

const modeOf = (cfg) => {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  return SLOT_MODES.includes(c.mode) ? c.mode : 'random';
};

/**
 * 每个图元都补上 vector-effect 属性。Chrome 只认 SVG 属性上的这个值，
 * CSS 里的同名属性会被解析、能读到 computed style，但**画的时候不生效**：
 * 实测场景画框放大 2.2 倍后，1.1px 描边被画成 2.4px、虚线节距也一起变长。
 * 补在 markup 上之后，同一个 SVG 塞进多宽的容器线宽都稳定。
 */
const crisped = (svg) => svg.replace(/<(path|circle|rect)(?=[\s>])/g,
  '<$1 vector-effect="non-scaling-stroke"');

/** 身体部位 → 槽位 key。顺序即渲染顺序（头 → 身体 → 四肢），重叠时后者盖前者。 */
export const DOLL_PARTS = [
  { key: 'face', label: '表情', part: '脸' },
  { key: 'hair', label: '发型', part: '头发' },
  { key: 'outfit', label: '衣着', part: '身体' },
  { key: 'gear', label: '装备', part: '手臂' },
  { key: 'action', label: '动作', part: '腿' },
];

/**
 * 人物线稿（SVG 字符串）：每个部位带 data-act="asm-open" + data-key，
 * 点身体部位和点那一格是同一个动作。ghost=true 时不挂事件，只当空状态占位。
 * 注意 stroke/fill 由 CSS 的 .doll-zone 统一控制，这里只出结构。
 */
export function dollFigureHtml(slots, opts = {}) {
  const s = slots && typeof slots === 'object' ? slots : {};
  const o = opts && typeof opts === 'object' ? opts : {};
  const uid = Number(o.uid) || 0;
  const ghost = !!o.ghost || !uid;
  const male = o.gender === 'male';
  const zone = (key, body) => {
    const d = DOLL_PARTS.find((z) => z.key === key) || { key, label: key, part: '' };
    const hook = ghost ? ''
      : ` data-act="asm-open" data-scope="person" data-uid="${uid}" data-key="${key}"`;
    return `<g class="doll-zone m-${modeOf(s[key])}"${hook}>`
      + `<title>${esc(d.label)} · 点${esc(d.part)}也能换</title>${body}</g>`;
  };
  // 男/女两套轮廓：腰线一收一放，只为一眼看出「这是个人」而不是图标。
  const torso = male ? 'M35 38 H57 L60 82 H32 Z' : 'M34 38 H58 L66 82 H26 Z';
  const legs = male ? 'M41 82 L38 110 M51 82 L54 110' : 'M40 82 L36 110 M52 82 L56 110';
  // 底稿：始终画一具完整的身体，槽位关掉时也不至于变成「一坨虚线」。
  const body = `<path d="M30 20 a16 16 0 0 1 32 0"/>`
    + `<circle class="area" cx="46" cy="20" r="12"/>`
    + `<path class="area" d="${torso}"/>`
    + '<path d="M34 40 L24 68 M58 40 L68 68"/>'
    + '<circle cx="24" cy="71" r="2.8"/><circle cx="68" cy="71" r="2.8"/>'
    + `<path d="${legs}"/>`;
  return crisped(`<svg class="doll-svg${ghost ? ' is-ghost' : ''}" viewBox="0 0 92 118" aria-hidden="true">
    <path class="doll-deco" d="M25 114 H67"/>
    <path class="doll-deco" d="M46 33 V38"/>
    <g class="doll-body">${body}</g>
    ${zone('face', '<circle class="area" cx="46" cy="20" r="12"/>')}
    ${zone('hair', '<path class="hit" d="M30 20 a16 16 0 0 1 32 0"/>'
      + '<path d="M30 20 a16 16 0 0 1 32 0"/>')}
    ${zone('outfit', `<path class="area" d="${torso}"/>`)}
    ${zone('gear', '<path class="hit" d="M34 40 L24 68 M58 40 L68 68"/>'
      + '<path d="M34 40 L24 68 M58 40 L68 68"/>'
      + '<circle cx="24" cy="71" r="2.8"/><circle cx="68" cy="71" r="2.8"/>')}
    ${zone('action', `<path class="hit" d="${legs}"/><path d="${legs}"/>`)}
  </svg>`);
}

/**
 * 场景线稿：一块虚线画框。背景 = 整块画面（地平线/山/太阳是装饰），
 * 画风 = 右下三枚色点，构图 = 画框本身（含三分线）。同样点哪儿改哪儿。
 */
export function sceneStageHtml(scene) {
  const s = scene && typeof scene === 'object' ? scene : {};
  const zone = (key, label, body, extra = '') =>
    `<g class="doll-zone${extra ? ' ' + extra : ''} m-${modeOf(s[key])}"`
    + ` data-act="asm-open" data-scope="scene" data-key="${key}">`
    + `<title>${esc(label)}</title>${body}</g>`;
  return crisped(`<svg class="doll-svg stage-svg" viewBox="0 0 160 96" aria-hidden="true">
    ${zone('background', '背景 · 点画面也能换', '<rect class="area" x="3" y="3" width="154" height="90" rx="6"/>')}
    <rect class="doll-base" x="3" y="3" width="154" height="90" rx="6"/>
    <g class="doll-deco">
      <path d="M3 64 H157"/>
      <path d="M3 64 L44 32 L74 64"/><path d="M68 64 L98 40 L126 64"/>
      <circle cx="130" cy="22" r="8"/>
    </g>
    <g class="doll-deco thirds">
      <path d="M54.3 3 V93 M105.7 3 V93 M3 33 H157"/>
    </g>
    ${zone('style', '画风 · 点色点也能换',
      '<path class="hit" d="M108 80 H152"/>'
      + '<circle cx="116" cy="80" r="5"/><circle cx="132" cy="80" r="5"/>'
      + '<circle cx="148" cy="80" r="5"/>')}
    ${zone('composition', '构图 · 点画框也能换',
      '<rect class="frame-rect" x="3" y="3" width="154" height="90" rx="6"/>', 'frame')}
  </svg>`);
}

// ---------------- 状态栏立绘：从锁定的条目反查概念封面 ----------------
// 概念的 key 是英文 tag 的小写形式（`signora (genshin impact)`），而条目的 label
// 是中文（`希格诺拉 (原神)`）。所以立绘必须走 tags，不能用 label。

/** 条目 tags（逗号分隔文本，也可能已是数组）→ 去空的 tag 列表。 */
export function splitTags(text) {
  const list = Array.isArray(text) ? text : String(text || '').split(/[,，;；|\n]+/);
  return list.map((s) => String(s || '').trim()).filter(Boolean);
}

// 与后端 strip_count_tags 同一套语义：人数由装配面板统一写，条目自带的必须剥掉。
const COUNT_TAG_RE = /^(?:\d+\+?|multiple|no)\s*(?:girl|boy|other|human)s?$|^solo(?:\s+focus)?$/i;

/** 剥掉人数类 tag（1girl / 2boys / multiple girls / no humans / solo …）。 */
export function stripCountTags(tags) {
  return splitTags(tags).filter((t) => !COUNT_TAG_RE.test(t.replace(/\s+/g, ' ').trim()));
}

/** 一个 tag → 概念 key：去转义反斜杠、压空白、转小写。 */
export function conceptKeyOf(tag) {
  return String(tag || '').replace(/\\/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * 某个格子锁定后，可以用来查立绘的概念 key 候选（按可信度排序）。
 * 角色条目常是 `1girl, artoria pendragon \(fate\), fate \(series\)`：
 * 剥掉人数后第一个通常是角色本体，后面的作品名命中率也还行，所以给多候选。
 */
export function portraitKeys(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const out = [];
  for (const t of stripCountTags(c.tags)) {
    const k = conceptKeyOf(t);
    if (k && k.length <= 80 && !out.includes(k)) out.push(k);
    if (out.length >= 3) break;
  }
  // 旧会话（tags 字段是后加的）没有 tags：退回用 pick 试一次，命中就当赚到。
  if (!out.length && c.pick) {
    const k = conceptKeyOf(c.pick);
    if (k) out.push(k);
  }
  return out;
}

/** 状态栏标题：锁定了就显示条目名（中文可读），否则说明这格交给骰子。 */
export function personTitle(person) {
  const p = person && typeof person === 'object' ? person : {};
  const role = p.slots && p.slots.role ? p.slots.role : {};
  const locked = role.mode === 'locked' && role.pick;
  return locked ? String(role.pick) : '';
}

// ---------------- 部位 → 池的匹配 ----------------
// 「全部 106 池」摊平给用户等于没给选择：同一个 kind 里混得很杂——「风格」19 池里
// 12 个是乐器，「物品」69 池几乎全是食物和花。所以每个部位配两级关键词（strong 是这
// 一格的正主，weak 是沾边的），命中抬分、明显跑偏压分，再按条目数补热度。
// 效果：点背景，建筑/场景在前而不是「花卉」；点角色，wai_characters 在前而不是「人物-类型」。

const POOL_HINTS = {
  role: {
    strong: [/wai_characters|characterfull|character|zh[_\s-]?tw/i],
    weak: [/人物-类型/],
  },
  hair: {
    strong: [/头发|发型|hair/i],
    weak: [],
  },
  face: {
    strong: [/面|表情|face_emotions|face_emotes|expression/i],
    weak: [/face|唇|emote/i],
  },
  outfit: {
    strong: [/outfit|attire|cloth|costume|wear|dress|uniform/i, /服装|衣服|穿搭|穿戴/],
    weak: [/shirt|skirt|裙|鞋袜|装饰|比基尼|maid|lolita/i],
  },
  gear: {
    strong: [/物品$|装备|道具|weapon|equipment|equpment|accessor/i],
    weak: [/technology|sports|personal[_\s]?communication/i],
  },
  action: {
    strong: [/动作|摆位|action|pose|posture/i],
    weak: [/gesture|姿态/i],
  },
  background: {
    strong: [/背景|场景|建筑|室内|室外|都市|奇幻|background|location/i],
    weak: [/景观|花卉|天象|自然/i],
  },
  style: {
    strong: [/style|movement|画风|风格|film|材质|纹理|camera/i],
    weak: [],
  },
  composition: {
    strong: [/构图|镜头|视角|composition|framing|angle/i],
    weak: [],
  },
};

/** 与「人穿在身上 / 拍出来」无关的池：命中关键词也降一档，别让 sex_/audio_/food_ 抢前排。 */
const POOL_OFF_TOPIC = /(?:^|\s)(?:sex|nudity|bondage|cum|injury|audio|food|flower|plant|bread|meat|fruit|vegetable|drink|dairy|sweets|utensil|meta|provenance|verbs?|gerund)/i;

/** 人工整理过的母语池（人物-衣服 / 组合预设 / 构图-视角…）质量比裸 tag 池稳，微加分。 */
const POOL_CURATED = /^(?:人物-|组合预设\/|动作$|构图-|镜头-|自然景观-|人文景观-|色彩|材质纹理|物品$)/;

/** 池名里的 `_` `/` 是分词符，正则前先摊成空格，否则 `\b` 在 `food_sweets` 上不成立。 */
const poolText = (p) => String((p && p.name) || '').replace(/[_/]+/g, ' ').trim();

export function poolScore(pool, key) {
  const name = String((pool && pool.name) || '');
  const text = poolText(pool);
  const hints = POOL_HINTS[key] || { strong: [], weak: [] };
  const has = (re) => re.test(name) || re.test(text);
  let score = 0;
  if ((hints.strong || []).some(has)) score += 100;
  else if ((hints.weak || []).some(has)) score += 55;
  // 跑偏池即使命中关键词也压到后面：`sex_acts_fetishes_facial_expressions` 确实含
  // expression，但它不是「换表情」该先看到的东西。
  if (POOL_OFF_TOPIC.test(text)) score -= score > 0 ? 45 : 40;
  if (POOL_CURATED.test(name)) score += 8;
  // 条目数是「这个池够不够抽」的直接信号，但只做微调：log 一下，最多 28 分。
  score += Math.min(28, Math.log10(1 + Number((pool && pool.item_count) || 0)) * 11);
  return Math.round(score * 10) / 10;
}

/** 该部位下按匹配度排序的池。空 kind 返回空数组（没法定类别就不猜）。 */
export function rankPools(pools, kind, key) {
  const list = (Array.isArray(pools) ? pools : [])
    // 自己关掉的池不该被推荐：chip 上给个条数、点进去却抽不到东西最费解。
    .filter((p) => p && p.name && p.enabled !== false
      && String(p.kind || '') === String(kind || ''));
  return list
    .map((p) => ({ ...p, score: poolScore(p, key) }))
    .sort((a, b) => b.score - a.score
      || Number(b.item_count || 0) - Number(a.item_count || 0)
      || String(a.name).localeCompare(String(b.name)));
}

/**
 * 匹配到的池摆成一行可点的 chip：「全部 1234」在最前，后面按匹配度排。
 * 一行横向滚动而不是折成三行——左栏只有 392px，折行会把条目列表挤出屏幕。
 */
export function poolChipsHtml(pools, kind, key, selected, limit = 8) {
  const ranked = rankPools(pools, kind, key);
  const total = ranked.reduce((s, p) => s + Number(p.item_count || 0), 0);
  const chip = (v, label, count, on) => `<button type="button"
    class="pool-chip${on ? ' on' : ''}" data-act="asm-pick-pool" data-v="${esc(v)}"
    title="${esc(label)} · ${count} 条">${esc(cut(label, 13))}<i>${count}</i></button>`;
  const n = Math.max(1, limit);
  let shown = ranked.slice(0, n);
  // 选中的池如果排在前 n 个之外（从下拉里选的），也要把它提到行首，
  // 否则用户看不到自己当前在哪一池 —— 高亮必须永远可见。
  const sel = ranked.find((p) => p.name === selected);
  if (sel && !shown.includes(sel)) shown = [sel, ...shown.slice(0, n - 1)];
  // 不放「还有 N 池」的提示：左栏只有 392px，一截文字就挤掉一个可点的池。
  // 池总数写在选择器标题上（「106 池匹配」），剩下的池去下面那个下拉里找。
  return [
    chip('', '全部', total, !selected),
    ...shown.map((p) => chip(p.name, p.name, Number(p.item_count || 0), p.name === selected)),
  ].join('');
}
