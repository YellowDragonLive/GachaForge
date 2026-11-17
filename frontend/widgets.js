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

// ---------------- 快速筛选：一个 input 过滤任意长列表 ----------------
// 口径来自用户：「各个地方提供一个 input 能快速筛选」——抽卡里 `black h` → `black hair`，
// LoRA 里 `neg` → `neg4all…safetensors`。所以这里只回答「这段文本算不算命中」，
// 真正的显隐交给 app.js（本模块零 DOM 依赖，Node 单测可直接跑）。
//
// 规则故意宽松：
//   · 空格分词、AND（每个词都要命中，顺序不限）
//   · `_` / `\` 归一成空格：`black_hair`、`eyewear_glasses` 两种写法都能搜到
//   · 子串匹配，所以只打半个词也能出结果（`black h` 命中 `black hair`）
export function queryWords(q) {
  return String(q ?? '').toLowerCase().replace(/[_\\]/g, ' ')
    .split(/\s+/)
    .map((s) => s.replace(/^[,，]+|[,，]+$/g, ''))
    .filter(Boolean);
}

export function matchQuery(text, q) {
  const words = queryWords(q);
  if (!words.length) return true;
  const hay = String(text ?? '').toLowerCase().replace(/[_\\]/g, ' ');
  return words.every((w) => hay.includes(w));
}

/** 筛选框本体。target = 受控元素的 id（select 或带 data-qtext 子项的容器）。 */
export function quickFilterHtml(target, placeholder = '筛选：输入片段', opts = {}) {
  const width = Number(opts.width || 172);
  return `<input type="text" class="qf" data-qf="${esc(target)}" autocomplete="off"
    spellcheck="false" style="max-width:${width}px"
    placeholder="${esc(placeholder)}" title="${esc(opts.title || placeholder)}">`;
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

/**
 * LoRA 下拉的候选列表（数据，不是 HTML）。
 *
 * 改这个形状是为了给 Vue 用：模板 v-for 渲染 option，纯函数只负责「哪些可选、哪个已添加」
 * ——已添加的置灰，用户不会重复添加同一条。返回 HTML 的老写法没法 v-for，也没法单测细节。
 */
export function loraOptionList(available, chosen) {
  const used = new Set(normalizeLoras(chosen).map((x) => x.name));
  const list = Array.isArray(available) ? available : [];
  return list.map((name) => ({
    value: String(name),
    text: cut(String(name), 64),
    disabled: used.has(String(name)),
  }));
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
/**
 * 槽位「卡池」下拉的分组数据（数据，不是 HTML）。
 *
 * 三段：不限池 / 按类别（角色、服装…）/ 指定卡池。指定卡池里剔掉名字带冒号的那种
 * 「类别:子类」伪池（不是可抽的真实池）。当前值不在任何一段里时给 custom，
 * 否则旧配方换个机器打开会变成「不选池」，看上去像配置丢了。
 */
export function poolOptionGroups(pools, selected) {
  const list = Array.isArray(pools) ? pools : [];
  const kinds = [...new Set(list.map((p) => String(p.kind || '其他')))];
  const cur = String(selected ?? '');
  const named = list.filter((p) => !/[:：]/.test(String(p.name || '')));
  const custom = cur && !kinds.includes(cur) && !list.some((p) => String(p.name) === cur) ? cur : '';
  return {
    custom,
    kinds,
    pools: named.map((p) => ({ value: String(p.name), text: cut(p.name, 46) })),
  };
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

/**
 * 人物的六个格子。off = 这格不参与；random = 每抽重摇；locked = 固定到 pick。
 * 默认全关：一进来是一张白纸，用户主动打开的格子才进 prompt。
 * 以前默认「角色/发型/衣着 随机」，等于用户什么都没选就先替他做了三个决定，
 * 摇错了还得先关掉再重开，比从零开始更费事。
 */
export const PERSON_SLOTS = [
  { key: 'role', label: '角色', kind: '角色', fallback: 'off' },
  { key: 'hair', label: '发型', kind: '发型', fallback: 'off' },
  { key: 'face', label: '表情', kind: '表情', fallback: 'off' },
  { key: 'outfit', label: '衣着', kind: '服装', fallback: 'off' },
  // 物品类下 69 个池混着食物/厨具（sausage、oven mitts），随机只会拉低出图质量：
  // 想要装备就点开，搜 sword / hat / glasses 这类具体词。
  { key: 'gear', label: '装备', kind: '物品', fallback: 'off' },
  { key: 'action', label: '动作', kind: '动作', fallback: 'off' },
];

/** 场景的四格：全局生效，不属于任何一个角色。同样默认全关。 */
export const SCENE_SLOTS = [
  { key: 'background', label: '背景', kind: '背景', fallback: 'off' },
  { key: 'style', label: '画风', kind: '风格', fallback: 'off' },
  // 画师尤其不能默认开：`dore \(gilles dore\)` 这类专有名词权重极高，
  // 摇错一位画风就全变，必须用户主动点开、亲手选，才有「今天用谁的手笔」的意味。
  { key: 'artist', label: '画师', kind: '画师', fallback: 'off' },
  { key: 'composition', label: '构图', kind: '构图', fallback: 'off' },
];

export const SLOT_MODES = ['random', 'locked', 'off'];

/**
 * 一张新的人物卡：默认所有格子都是「关闭」——打开哪格，哪格才参与抽卡。
 * tags 只在锁定后填（条目自带的英文 tag 串），用于状态栏立绘——label 是中文，
 * 概念 key 却是英文 tag，两者不能互相替代。
 */
export function makePerson(uid, gender = 'female') {
  const slots = {};
  for (const d of PERSON_SLOTS) {
    slots[d.key] = { kind: d.kind, mode: d.fallback, pick: '', tags: '' };
  }
  // extra = 这个人物「意群」的自由输入：池里没有的 tag 从这里补。
  // 一个人物卡 = 一个意群，extra 只描述这个人，不会漏到别人身上。
  return { uid, gender, slots, extra: '' };
}

/** 场景默认值。extra 是场景意群自己的自由输入。 */
export function makeScene() {
  const scene = {};
  for (const d of SCENE_SLOTS) {
    scene[d.key] = { kind: d.kind, mode: d.fallback, pick: '', tags: '' };
  }
  scene.extra = '';
  return scene;
}

/**
 * 意群（semantic group）：一个独立的描述单元——场景是意群 1，
 * 每张人物卡各是一个意群（人物 1 / 人物 2 …）。每个意群有自己的范围：
 * 六格（或场景四格）+ 一个不限池的自由输入 extra。
 * 编译 prompt 时同一意群的内容必须挨在一起，才不会把 A 的衣着写到 B 身上。
 * 用「逗号分隔 + 相邻排列」分组，不用括号：A1111 里括号是权重 ×1.1，
 * 不是分组语法，写了反而把整串放大、改变出图。
 */
export const GROUP_SCENE = '场景';
export const groupNameOf = (idx) => `P${idx + 1}`;


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
 * 装配状态 → 后端可执行的配方定义。按「意群」顺序编译：
 *   意群1 场景（四格 + 场景 extra）
 *   意群2 人物1（六格 + 人物1 extra）
 *   意群3 人物2（六格 + 人物2 extra）…
 * 同一意群的 tag 挨在一起 = 天然分组，A 的衣着不会串到 B 身上。
 * 旧版的全局 a.extra 也兼容：有值时并入场景意群末尾，避免老会话丢词。
 */
export function assemblyToDefinition(assembly) {
  const a = assembly && typeof assembly === 'object' ? assembly : {};
  const scene = a.scene && typeof a.scene === 'object' ? a.scene : {};
  const people = Array.isArray(a.people) ? a.people.filter(Boolean) : [];
  const slots = [];
  const push = (cfg, group) => {
    if (!cfg || cfg.mode === 'off') return;
    // group 是意群归属（场景 / P1 / P2…），必须显式传给后端存进关系表；
    // 只靠 pool 字符串前缀表达归属是补丁做法，刷新页面后就丢了。
    const slot = { pool: cfg.kind || '', count: 1, weight: 1, group, mode: cfg.mode };
    // 手填值：`pick` 是「池里的条目名」，`free` 是「用户自己写的任意 tag」。
    // 两者互斥，后端优先认 free（池里找不到东西也能出图）。
    if (cfg.mode === 'locked' && cfg.free) slot.free = cfg.free;
    else if (cfg.mode === 'locked' && cfg.pick) slot.pick = cfg.pick;
    slots.push(slot);
  };
  // 意群自己的自由输入：pool 名带上意群标记，卡片明细里能看出这句话属于谁。
  const pushExtra = (text, group) => {
    const v = String(text || '').trim();
    if (v) slots.push({ pool: `任意值·${group}`, count: 1, weight: 1,
      group, mode: 'locked', free: v });
  };
  SCENE_SLOTS.forEach((d) => push(scene[d.key], GROUP_SCENE));
  pushExtra(scene.extra, GROUP_SCENE);
  // 旧会话的全局 extra：并进场景，别让升级后用户的自定义词凭空消失。
  if (!scene.extra && a.extra) pushExtra(a.extra, GROUP_SCENE);
  people.forEach((p, i) => {
    const g = groupNameOf(i);
    PERSON_SLOTS.forEach((d) => push(p.slots && p.slots[d.key], g));
    pushExtra(p.extra, g);
  });
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
  return SLOT_MODES.includes(c.mode) ? c.mode : 'off';
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
    ${zone('artist', '画师 · 点左下角签名也能换',
      '<path class="hit" d="M10 84 H56"/>'
      + '<path d="M13 85q5 -9 9 -1q4 7 8 -3q3 -6 7 1q3 5 7 -2"/>'
      + '<path d="M48 78v10"/>')}
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
  // 画师：中文池名（画师图鉴）与英文池名（SDXL/artists）各命中一半。
  // 故意把 /画师|艺术家/ 放 strong、/artist/ 放 weak：前者是 noobai 那份带中文风格
  // 标签的 1025 位画师（抽到的 tag 更干净），后者是 3887 条的裸名字池，排在第二。
  artist: {
    strong: [/画师|艺术家|画家|illustrator/i],
    weak: [/artist/i],
  },
};

/** 与「人穿在身上 / 拍出来」无关的池：命中关键词也降一档，别让 sex_/audio_/food_ 抢前排。 */
const POOL_OFF_TOPIC = /(?:^|\s)(?:sex|nudity|bondage|cum|injury|audio|food|flower|plant|bread|meat|fruit|vegetable|drink|dairy|sweets|utensil|meta|provenance|verbs?|gerund)/i;

/** 人工整理过的母语池（人物-衣服 / 组合预设 / 构图-视角…）质量比裸 tag 池稳，微加分。 */
const POOL_CURATED = /^(?:人物-|组合预设\/|动作$|构图-|镜头-|自然景观-|人文景观-|色彩|材质纹理|物品$)/;

/** 池名里的 `_` `/` 是分词符，正则前先摊成空格，否则 `\b` 在 `food_sweets` 上不成立。 */
const poolText = (p) => String((p && p.name) || '').replace(/[_/]+/g, ' ').trim();

/**
 * 类别别名：用户嘴里的名字和池的正式名常常对不上——「艺术家」要能搜到「画师图鉴」。
 * 只用于**搜索匹配**，绝不能进 poolScore：同一部位下的候选池 kind 都相同，把 kind
 * 也算进匹配文本等于给所有池加同样的分，部位匹配度会被抹平成「谁条目多谁第一」。
 */
const KIND_ALIAS = {
  画师: '画家 艺术家 artist artists 作者 illustrator 笔触',
  风格: '画风 style',
  服装: '衣服 穿搭 outfit clothes',
  物品: '道具 装备 item equipment',
  构图: '视角 镜头 composition',
};

/** 搜索用文本：池名 + 类别 + 别名。筛选框打「艺术家」才有反应。 */
export function poolSearchText(pool) {
  const p = pool || {};
  return `${p.name || ''} ${p.kind || ''} ${KIND_ALIAS[p.kind] || ''}`
    .replace(/[_/]+/g, ' ').replace(/\s+/g, ' ').trim();
}

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

// ---------------- 池图标：让 568 个池名一眼分出「这一池装的是什么」 ----------------
// 只认池名关键词，不只看 kind：同一个 kind 里混得很杂（「风格」19 池里 12 个是
// 乐器，「物品」69 池几乎全是食物和花）。按 kind 一刀切会给出错误信息——把「食物」
// 池标成剑，用户点进去才发现是 sausage。认出「这池其实是花」才是有用的信息。
// 顺序即优先级：先把混进来的离题类认掉，再认这一格的正主。
const ICON_PATHS = {
  close: ['<path d="M4.2 4.2 L11.8 11.8"/><path d="M11.8 4.2 L4.2 11.8"/>'],
  shirt: ['<path d="M5.6 2.8 L3.2 3.9 L2.4 6.5 L4.4 7.2 V13.2 H11.6 V7.2 L13.6 6.5 L12.8 3.9 L10.4 2.8"/>',
    '<path d="M5.6 2.8 A2.4 2.4 0 0 0 10.4 2.8"/>'],
  hair: ['<circle cx="8" cy="9.3" r="3.8"/>',
    '<path d="M3.9 7.5 A4.1 4.1 0 0 1 12.1 7.5"/>',
    '<path d="M12.1 7.5 C12.6 9.8 12.3 11.6 11.6 12.8"/>'],
  face: ['<circle cx="8" cy="8" r="5.4"/>',
    '<circle class="ifill" cx="6.2" cy="6.9" r=".75"/>',
    '<circle class="ifill" cx="9.8" cy="6.9" r=".75"/>',
    '<path d="M5.9 9.7 C6.6 11 9.4 11 10.1 9.7"/>'],
  run: ['<circle cx="9.6" cy="3.5" r="1.6"/>',
    '<path d="M9.2 5.7 L6.9 8.3"/><path d="M9.2 5.9 L11.6 8"/>',
    '<path d="M6.9 8.3 L5 11 L3 12"/><path d="M6.9 8.3 L9 11 L10.6 13.2"/>'],
  sword: ['<path d="M13.1 2.9 L6.4 9.6"/><path d="M4.6 7.8 L8.2 11.4"/>',
    '<path d="M3.2 12.8 L5.4 10.6"/>'],
  gem: ['<path d="M4.2 5.8 L8 2.6 L11.8 5.8 L8 13.2 Z"/>',
    '<path d="M4.2 5.8 H11.8 M8 5.8 V13.2"/>'],
  mountain: ['<path d="M2.2 12.7 L6.3 5.5 L8.7 9.5 L10.3 7.2 L13.8 12.7 Z"/>',
    '<circle cx="11.8" cy="4.2" r="1.5"/>'],
  brush: ['<path d="M11.9 2.6 L13.4 4.1 L7 10.5 L4.1 11.4 L5 8.5 Z"/>',
    '<path d="M10.2 4.3 L11.7 5.8"/>'],
  frame: ['<rect x="2.4" y="3.4" width="11.2" height="9.2" rx="1"/>',
    '<path d="M2.4 8 H13.6 M8 3.4 V12.6"/>'],
  person: ['<circle cx="8" cy="5.4" r="2.6"/>',
    '<path d="M3.4 13.4 C3.4 10.4 5.4 9 8 9 C10.6 9 12.6 10.4 12.6 13.4"/>'],
  bag: ['<path d="M3 5.8 H13 V13.2 H3 Z"/>',
    '<path d="M5.8 5.8 V4.2 A2.2 2.2 0 0 1 10.2 4.2 V5.8"/>'],
  food: ['<path d="M5.1 2.8 V13.2"/>',
    '<path d="M3.5 2.8 V5.1 A1.6 1.6 0 0 0 6.7 5.1 V2.8"/>',
    '<path d="M10.9 13.2 V2.8 C12.7 3.6 12.7 7.2 10.9 7.6"/>'],
  flower: ['<circle cx="8" cy="5.5" r="1.8"/><circle cx="8" cy="10.5" r="1.8"/>',
    '<circle cx="5.5" cy="8" r="1.8"/><circle cx="10.5" cy="8" r="1.8"/>',
    '<circle class="ifill" cx="8" cy="8" r="1.1"/>'],
  note: ['<path d="M6.5 11.5 V3.6 L12 2.7 V10.6"/>',
    '<circle cx="5.1" cy="11.7" r="1.5"/><circle cx="10.6" cy="10.8" r="1.5"/>'],
  drop: ['<path d="M8 2.4 C8 2.4 4.2 6.8 4.2 9.3 A3.8 3.8 0 0 0 11.8 9.3 C11.8 6.8 8 2.4 8 2.4 Z"/>'],
  camera: ['<rect x="2.2" y="5.2" width="11.6" height="7.8" rx="1.6"/>',
    '<circle cx="8" cy="9.1" r="2.5"/>', '<path d="M5.9 5.2 L6.8 3.3 H9.2 L10.1 5.2"/>'],
  layers: ['<path d="M8 2.4 L13.4 5.2 L8 8 L2.6 5.2 Z"/>',
    '<path d="M2.6 8 L8 10.8 L13.4 8"/><path d="M2.6 10.8 L8 13.6 L13.4 10.8"/>'],
  body: ['<circle cx="8" cy="3.9" r="1.7"/>',
    '<path d="M8 5.6 V10 M5.6 7.2 H10.4 M8 10 L6.2 13.2 M8 10 L9.8 13.2"/>'],
  eye: ['<path d="M1.7 8 C3.7 4.7 12.3 4.7 14.3 8 C12.3 11.3 3.7 11.3 1.7 8 Z"/>',
    '<circle cx="8" cy="8" r="2.2"/>'],
  paw: ['<circle cx="5" cy="5.5" r="1.35"/><circle cx="8" cy="4.3" r="1.35"/>',
    '<circle cx="11" cy="5.5" r="1.35"/>',
    '<path d="M8 7.7 C10.5 7.7 12.3 9.5 12.3 11.3 C12.3 12.7 11.1 13.1 10.1 13.1 C9.2 13.1 8.6 12.5 8 12.5 C7.4 12.5 6.8 13.1 5.9 13.1 C4.9 13.1 3.7 12.7 3.7 11.3 C3.7 9.5 5.5 7.7 8 7.7 Z"/>'],
  glasses: ['<circle cx="4.7" cy="8.8" r="2.6"/><circle cx="11.3" cy="8.8" r="2.6"/>',
    '<path d="M7.3 8.8 H8.7 M2.1 7.9 L3.3 5.2 M13.9 7.9 L12.7 5.2"/>'],
  pen: ['<path d="M8 2.3 L11.7 10.3 L8 13.7 L4.3 10.3 Z"/><path d="M8 2.3 V9.7"/>'],
  grid: ['<rect x="2.6" y="2.6" width="4.5" height="4.5" rx=".9"/>',
    '<rect x="8.9" y="2.6" width="4.5" height="4.5" rx=".9"/>',
    '<rect x="2.6" y="8.9" width="4.5" height="4.5" rx=".9"/>',
    '<rect x="8.9" y="8.9" width="4.5" height="4.5" rx=".9"/>'],
  tag: ['<path d="M2.6 8.6 V3.4 A.8 .8 0 0 1 3.4 2.6 H8.6 L13.4 7.4 L8.6 12.6 Z"/>',
    '<circle cx="5.4" cy="5.4" r=".9"/>'],
};

/** kind 兜底：池名一个关键词都没命中时，至少按类别给个不倒胃口的东西。 */
const KIND_ICON = {
  角色: 'person', 发型: 'hair', 表情: 'face', 服装: 'shirt', 物品: 'bag',
  动作: 'run', 背景: 'mountain', 风格: 'brush', 构图: 'frame', 身体: 'body',
  动物: 'paw', 眼睛: 'eye', 画师: 'pen', 颜色: 'drop', 标签: 'tag',
};

const ICON_RULES = [
  // 先把「混在别类里」的池认掉——这几类在库里条目极多，认错会一直误导。
  [/(?:^|[^a-z])(?:food|bread|meat|fruit|vegetable|drink|dairy|sweets|utensil|cuisine|dish|snack|candy)/i, 'food'],
  [/食物|料理|甜点|饮品|厨具|餐具|水果|蔬菜|肉类|面包/, 'food'],
  [/flower|blossom|plant|tree|leaf|herb|garden|floral|花卉|植物|树木|花/i, 'flower'],
  [/audio[_ -]|instrument|guitar|piano|violin|drum|trumpet|flute|music|乐器|音效/i, 'note'],
  // 眼睛要排在「颜色」前面：eyes_iris_colors 这类池名带 colors，但它讲的是眼睛。
  [/eyes?_|eye[_ -]|眼睛|瞳孔|瞳/i, 'eye'],
  [/eyewear|glasses|sunglasses|眼镜/i, 'glasses'],
  [/color|colour|palette|hue|色彩|配色/i, 'drop'],
  [/camera|lens|photograph|镜头|机位/i, 'camera'],
  // 再认这一格的正主。
  [/hair|发型|头发/i, 'hair'],
  [/face|expression|emote|表情|面部|五官/i, 'face'],
  [/weapon|sword|gun|armor|equip|equpment|装备|武器|道具/i, 'sword'],
  [/accessor|jewel|necklace|earring|首饰|配饰|饰品/i, 'gem'],
  [/outfit|attire|cloth|costume|wear|dress|uniform|skirt|shirt|shoe|sock|服装|衣服|穿搭|裙|鞋|袜/i, 'shirt'],
  [/action|pose|posture|gesture|动作|姿态|摆位/i, 'run'],
  [/composition|framing|构图|视角|三分|取景/i, 'frame'],
  [/background|location|scenery|interior|exterior|建筑|室内|室外|场景|都市|奇幻|景观|天象|背景/i, 'mountain'],
  [/style|movement|film|texture|画风|风格|纹理|材质/i, 'brush'],
  [/preset|组合预设|合集|bundle/i, 'layers'],
  [/body|anatomy|身体|器官/i, 'body'],
  [/animal|creature|(?:^|[^a-z])(?:cats?|dogs?|birds?)(?:[_ ]|$)|兽|动物|宠物/i, 'paw'],
  [/画师|artists?(?:\/|$)/i, 'pen'],
  [/character|角色|人物/i, 'person'],
];

/**
 * 池 → 图标 key。`name` 与 `kind` 一起看，但池名优先（见上）。
 * 认不出来时按 kind 兜底，再不行给个标签——绝不返回空。
 */
export function poolIcon(name, kind) {
  // 只拿池名去匹配。把 kind 拼进来会盖住池名本身的信息：kind=眼睛 的所有池都会
  // 命中「眼睛」而丢掉 eyewear→眼镜 的区分，等于白分。kind 只在池名一个关键词
  // 都没命中时兜底（「物品」这种就叫「物品」的池靠它拿到袋子图标）。
  const text = String(name || '');
  for (const [re, key] of ICON_RULES) if (re.test(text)) return key;
  return KIND_ICON[String(kind || '')] || 'tag';
}

/** 按 key 直接出 SVG：图标尺寸固定 13px（CSS 写死），所以不需要 non-scaling-stroke。 */
export function iconSvg(key) {
  const parts = ICON_PATHS[key] || ICON_PATHS.tag;
  return `<svg class="pico" viewBox="0 0 16 16" aria-hidden="true">${parts.join('')}</svg>`;
}

/** 池 → SVG。chip、组头、下拉左图标全走这一个入口，保证同一池在各处长得一样。 */
export const poolIconHtml = (name, kind) => iconSvg(poolIcon(name, kind));

export function poolChipsHtml(pools, kind, key, selected, limit = 8, q = '') {
  const ranked = rankPools(pools, kind, key);
  const total = ranked.reduce((s, p) => s + Number(p.item_count || 0), 0);
  // 每个 chip 前挂一枚图标：106 个池里「能穿的衣服」和「混进来的乐器」文字上分不出，
  // 图标先给一眼判断。文字从 13 字收到 11 字，把宽度让给图标。
  const chip = (v, label, count, on, ico, facets) => `<button type="button"
    class="pool-chip${on ? ' on' : ''}" data-act="asm-pick-pool" data-v="${esc(v)}"
    data-qtext="${esc(label)} ${esc(count)}"${facets ? ' data-facets="1"' : ''}
    title="${esc(label)} · ${count} 条${facets ? ' · 可按维度细化' : ''}">${ico || poolIconHtml(label, kind)}<span
    class="pool-chip-n">${esc(cut(label, 11))}</span><i>${count}</i></button>`;
  // 有筛选词时不按「前 8 个匹配池」截断：搜「服装」命中的池很可能排在第 12 位，
  // 截断等于搜了没反应。改成把命中的池全摆出来（上限 30），顺序仍按部位匹配度。
  const words = queryWords(q);
  // 用别名文本筛：打「艺术家」要能筛出「画师图鉴」，打「artists」要能筛出 SDXL/artists。
  const poolHit = (p) => matchQuery(poolSearchText(p), q);
  const hits = words.length
    ? ranked.filter(poolHit).slice(0, 30)
    : ranked.slice(0, Math.max(1, limit));
  let shown = hits;
  // 选中的池如果排在前 n 个之外（从下拉里选的），也要把它提到行首，
  // 否则用户看不到自己当前在哪一池 —— 高亮必须永远可见。
  const sel = ranked.find((p) => p.name === selected);
  if (sel && !shown.includes(sel)) shown = [sel, ...shown.slice(0, Math.max(0, shown.length - 1))];
  // 不放「还有 N 池」的提示：左栏只有 392px，一截文字就挤掉一个可点的池。
  // 池总数写在选择器标题上（「106 池匹配」），剩下的池去下面那个下拉里找。
  return [
    chip('', words.length ? '清除筛选' : '全部', total, !selected, iconSvg(words.length ? 'close' : 'grid')),
    ...shown.map((p) => chip(p.name, p.name, Number(p.item_count || 0), p.name === selected,
      '', Number(p.facet_groups || 0) > 0)),
  ].join('');
}

/**
 * 池内切片行：选中一个池后，把「这个池里的东西按维度切开」摆在条目列表上方。
 *
 * 512 个池里最痛的是一个池装了好几个维度：`人物-头发` 214 条混着长短 / 束法 /
 * 质地 / 性别向。整池随机的结果就是「想画长发女孩，抽到光头」。这一行让用户
 * 在**不离开当前池**的前提下把范围收到那一档——组内互斥、组间叠加。
 *
 * 一个切片都不选 = 整池，和没有这个功能时完全一样（这是零回归的关键）。
 * 选中时行首补一颗「全部」，否则取消单选只能靠再点一次同一个 chip，不好发现。
 */
export function facetChipsHtml(groups, selected) {
  const list = (groups || []).filter((g) => g && (g.options || []).length);
  if (!list.length) return '';
  const on = new Set(selected || []);
  // 组名占一列、档位占一列：服装「类型」有 8 个档，一排放不下，靠列内换行而不是
  // 整组溢出被裁——组名固定列宽后，换行出来的档位仍与上一行左对齐。
  const group = (g) => `<span class="facet-group"><span class="facet-g">${esc(g.name)}</span>`
    + '<span class="facet-opts">'
    + (g.options || []).map((o) => `<button type="button"
        class="facet-chip${on.has(o.slug) ? ' on' : ''}"
        data-act="asm-facet" data-v="${esc(o.slug)}"
        title="只看「${esc(o.name)}」· ${o.count} 条">${esc(o.name)}<i>${o.count}</i></button>`).join('')
    + '</span></span>';
  const clear = on.size
    ? `<button type="button" class="facet-chip clear" data-act="asm-facet" data-v=""
        title="取消全部切片，回到整池">全部</button>`
    : '';
  // 组名自己就是分隔符，不再插竖线：wrap 之后竖线会孤零零挂在行尾（「无发 3 |」）。
  return clear + list.map(group).join('');
}
