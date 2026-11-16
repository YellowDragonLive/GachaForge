// 前端纯函数契约测试：固定入口 `node scripts/test_frontend.mjs`。
// 不依赖 DOM / 浏览器 / 构建链；用 data URL 加载 .js，避免给项目引入 package.json。
// 覆盖抽卡 detail 的两种历史形状与各种脏数据，防止 "x.tags.join is not a function" 回归。
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { unresolvedCalls } from './frontend_refs.mjs';

// 拆模块后「接线断言」不再指向单一文件：把 frontend 下所有 .js 拼起来当一份前端源码查。
// 断言语义不变（某段 HTML / data-act 必须有对应实现），只是不再关心它写在哪个文件里。
const jsFiles = [];
(function walk(dir) {
  for (const n of readdirSync(dir)) {
    const fp = dir + '/' + n;
    if (statSync(fp).isDirectory()) {
      // vendor/ 是第三方代码（Vue 的 ESM 版），不参与"接线/引用"这类自家代码的契约检查
      if (n === 'vendor') continue;
      walk(fp);
    } else if (n.endsWith('.js')) jsFiles.push(fp);
  }
})(fileURLToPath(new URL('../frontend', import.meta.url)));
const frontendSrc = () => jsFiles.map((f) => readFileSync(f, 'utf8')).join('\n');

const src = readFileSync(new URL('../frontend/detail.js', import.meta.url), 'utf8');
const { slotChips, esc, cut } = await import(
  'data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

// widgets.js 零 import，可直接用 data URL 加载，无需构建链 / package.json
const widgetSrc = readFileSync(new URL('../frontend/widgets.js', import.meta.url), 'utf8');
const W = await import(
  'data:text/javascript;base64,' + Buffer.from(widgetSrc).toString('base64'));

let passed = 0;
const cases = [
  ['基础转义与截断', () => {
    assert.equal(esc('<a & "b">'), '&lt;a &amp; &quot;b&quot;&gt;');
    assert.equal(cut('abcdef', 3), 'abc…');
    assert.equal(cut(undefined, 3), '');
    assert.equal(cut(['a', 'b'], 3), 'a,b');
  }],
  ['配方模式：tags 为数组', () => {
    const html = slotChips([
      { slot: '画师', tags: ['kincora', 'masterpiece'] },
      { slot: '动作', tags: ['girl on top'] },
    ]);
    assert.match(html, /画师: kincora \/ masterpiece/);
    assert.match(html, /动作: girl on top/);
    assert.equal((html.match(/class="chip"/g) || []).length, 2);
  }],
  ['旧全池随机：tags 为字符串（本次故障的真实形状）', () => {
    const html = slotChips([
      { pool: 'action:action', friendly: '动作', label: 'girl on top 7', tags: '1girl, sex' },
      { pool: 'csv:wai_characters', friendly: '角色', label: '犬走椛', tags: 'inubashiri momiji' },
    ]);
    assert.match(html, /动作: girl on top 7 → 1girl, sex/);
    assert.match(html, /角色: 犬走椛 → inubashiri momiji/);
  }],
  ['新全池随机：已归一化的 slot + tags 数组', () => {
    const html = slotChips([
      { slot: '动作', pool: 'action:action', label: 'girl on top 7', tags: ['1girl, sex'] },
    ]);
    assert.match(html, /动作: girl on top 7 → 1girl, sex/);
  }],
  ['skipped / 空 tags / null 元素', () => {
    const html = slotChips([
      { slot: '风格', skipped: true, tags: [] },
      { slot: '角色', tags: [] },
      null, undefined, 'bad', 42,
      { slot: '背景', tags: null },
      { slot: '有效', tags: ['ok'] },
    ]);
    assert.equal((html.match(/class="chip"/g) || []).length, 1);
    assert.match(html, /有效: ok/);
  }],
  ['detail 非数组 / 数字 tags / 混合形状', () => {
    assert.equal(slotChips(null), '');
    assert.equal(slotChips(undefined), '');
    assert.equal(slotChips('oops'), '');
    assert.equal(slotChips({ slot: 'x' }), '');
    assert.match(slotChips([{ slot: '数值', tags: 123 }]), /数值: 123/);
    assert.match(slotChips([
      { slot: 'A', tags: ['a1', 'a2'] },
      { pool: 'p', friendly: 'B', label: 'L', tags: 'b1' },
    ]), /A: a1 \/ a2[\s\S]*B: L → b1/);
  }],
  ['HTML 注入被转义', () => {
    const html = slotChips([{ slot: '<b>', label: '"x"', tags: ['<img src=x onerror=alert(1)>'] }]);
    assert.doesNotMatch(html, /<img|<b>/);
    assert.match(html, /&lt;img/);
  }],
  ['长文本被截断但 title 保留全文', () => {
    const long = 'x'.repeat(400);
    const html = slotChips([{ slot: '长', tags: [long] }]);
    assert.match(html, /title="x{300}…"/);
    assert.match(html, /…<\/span>/);
  }],
  ['全池随机数百槽位时折叠显示', () => {
    const many = Array.from({ length: 558 }, (_, i) =>
      ({ slot: `池${i}`, tags: [`tag${i}`] }));
    const html = slotChips(many);
    assert.equal((html.match(/class="chip"/g) || []).length, 21);
    assert.match(html, /另有 538 个槽位/);
    assert.match(html, /池0: tag0/);
    assert.doesNotMatch(html, /池100/);
  }],
  ['空槽位显式标记（全局过滤把池筛掉时不再静默消失）', () => {
    const html = slotChips([
      { slot: 'fixed_head', tags: ['masterpiece'] },
      { slot: '画师', tags: [], empty: true, reason: '未找到匹配卡池' },
      { slot: 'action', tags: [], empty: true, reason: '被全局过滤移除' },
      { slot: '角色', tags: ['astolfo (fate)'] },
    ]);
    assert.equal((html.match(/class="chip warn"/g) || []).length, 2);
    assert.match(html, /画师: ⚠ 无匹配条目/);
    assert.match(html, /title="未找到匹配卡池"/);
    assert.match(html, /角色: astolfo/);
  }],
  ['抽卡台接线：状态持久化 + 过滤提示 + 不再直接 join', () => {
    const app = frontendSrc();
    for (const needle of [
      // 拆模块后 import 由脚本自动生成，名字顺序不再固定：按「detail 三件套都被 import」断言
      /import \{[^}]*\besc\b[^}]*\} from '.*detail\.js'/,
      /import \{[^}]*\bcut\b[^}]*\} from '.*detail\.js'/,
      /import \{[^}]*\bslotChips\b[^}]*\} from '.*detail\.js'/,
      'slotChips(d.detail)',
      'state.form =',
      "view.addEventListener('input', onInput)",
      'sessionStorage.setItem(LAST_SESSION_KEY',
      'await restoreLastDraw()',
      'state.warnings = data.warnings || []',
      'persistForm(state)',
      'restoreForm()',
      'function filterHintText()',
      'function updateFilterHint()',
    ]) {
      const ok = needle instanceof RegExp ? needle.test(app) : app.includes(needle);
      assert.ok(ok, `app.js 缺少接线：${needle}`);
    }
    assert.doesNotMatch(app, /\.tags\.join\(/, '不得再对 tags 直接调用 join');
    assert.doesNotMatch(app, /id="dPulls" value="3"/, '表单值不得写死为默认值');
    // 持久化收口到 state.js：修掉 readDrawForm 整体替换 state.form 丢 filterMode 的 bug
    const st = readFileSync(new URL('../frontend/state.js', import.meta.url), 'utf8');
    assert.match(st, /export function persistForm/, '持久化有唯一出口');
    assert.match(st, /Object\.assign\(state\.form, saved\)/,
      '恢复表单是逐字段合并，不是整体替换（否则 filterMode 会丢）');
    assert.match(st, /export function createState/, '状态定义集中在一处');
    assert.ok(!/state\.route|state\.currentView/.test(app),
      '视图状态只有一份 state.view，不再 currentView/route 双份');
  }],
  ['过滤表达式：解析 / 追加去重 / 删除', () => {
    assert.deepEqual(W.parseFilterSpec('角色:asuna, fate'), [
      { pool: '角色', tag: 'asuna', raw: '角色:asuna' },
      { pool: '', tag: 'fate', raw: 'fate' },
    ]);
    assert.equal(W.addFilter('角色:asuna', '角色', 'fate'), '角色:asuna, 角色:fate');
    assert.equal(W.addFilter('角色:asuna', '角色', 'ASUNA'), '角色:asuna');
    assert.equal(W.addFilter('', '角色', 'asuna'), '角色:asuna');
    assert.equal(W.addFilter('', '', 'fate'), 'fate');
    assert.equal(W.addFilter('a', 'p', 'x,y'), 'a, p:x y');  // 逗号会破坏表达式，自动清理
    assert.equal(W.removeFilter('角色:asuna, fate', 0), 'fate');
    assert.deepEqual(W.parseFilterSpec(''), []);
  }],
  ['过滤条件 chips：可删除、裸关键字标黄、注入被转义', () => {
    const html = W.filterChipsHtml('角色:asuna, fate');
    assert.equal((html.match(/data-act="filter-del"/g) || []).length, 2);
    assert.match(html, /data-i="0"/);
    assert.match(html, /class="chip warn removable"/);
    assert.match(html, /fate（全局）/);
    assert.doesNotMatch(W.filterChipsHtml('<img>:<script>'), /<script>/);
    assert.match(W.filterChipsHtml(''), /未设置过滤/);
  }],
  ['池与 tag 下拉：类别优先、脏池名跳过、选中项保留', () => {
    const pools = [
      { name: 'zh_TW', kind: '角色', item_count: 120 },
      { name: 'bad:name', kind: '角色', item_count: 3 },
      { name: 'artists', kind: '画师', item_count: 40 },
    ];
    const html = W.poolOptionsHtml(pools, '角色');
    assert.match(html, /optgroup label="按类别（推荐）"/);
    assert.match(html, /value="角色" selected/);
    assert.match(html, /角色 · 2 池 \/ 123 条/);
    assert.match(html, /指定卡池 · 画师/);
    assert.doesNotMatch(html, /value="bad:name"/);
    assert.match(W.tagOptionsHtml([{ value: 'asuna', count: 18 }], 'fate'),
      /value="fate" selected/);
    assert.match(W.hotTagChipsHtml([{ value: 'asuna', count: 18 },
      { value: '亚丝娜', count: 1, source: 'label' }]), /data-v="asuna"/);
    assert.doesNotMatch(W.hotTagChipsHtml([{ value: '亚丝娜', count: 1, source: 'label' }]),
      /data-act="filter-hot"/);
  }],
  ['LoRA：JSON 字符串 / 脏数据 / 去重 / 权重裁剪', () => {
    assert.deepEqual(W.normalizeLoras('[{"name":"x.safetensors","weight":0.8}]'),
      [{ name: 'x.safetensors', weight: 0.8 }]);
    assert.deepEqual(W.normalizeLoras([
      { name: 'a', weight: 0.5 }, { name: 'a', weight: 1 }, { name: '', weight: 1 },
      null, { name: 'b' }, { name: 'c', weight: 99 },
    ]), [{ name: 'a', weight: 0.5 }, { name: 'b', weight: 1 }, { name: 'c', weight: 4 }]);
    assert.deepEqual(W.normalizeLoras('坏 JSON'), []);
    // LoRA 下拉改成「返回数据」，由 Vue 模板 v-for 渲染：这里验的是候选与置灰规则
    const opts = W.loraOptionList(['a.safetensors', 'b.safetensors'], [{ name: 'a.safetensors' }]);
    assert.deepEqual(opts.map((o) => o.disabled), [true, false], '已添加的候选要置灰');
    assert.match(opts[0].text, /a\.safetensors/);
  }],
  ['槽位表：卡池分组数据、自定义池保留、数值范围', () => {
    assert.deepEqual(W.normalizeSlots('[{"pool":"角色","count":9,"weight":5}]'),
      [{ pool: '角色', count: 9, weight: 1, filter: '' }]);
    const g = W.poolOptionGroups(
      [{ name: 'zh_TW', kind: '角色' }, { name: '组合预设:服装', kind: '角色' }, { name: 'x', kind: '服装' }],
      '自定义池');
    assert.deepEqual(g.kinds, ['角色', '服装'], '类别去重且保持出现顺序');
    assert.deepEqual(g.pools.map((p) => p.value), ['zh_TW', 'x'], '带冒号的伪池不进槽位下拉');
    assert.equal(g.custom, '自定义池', '枚举外的当前值要保留，否则旧配方像是配置丢了');
    assert.equal(W.poolOptionGroups([{ name: 'zh_TW', kind: '角色' }], 'zh_TW').custom, '');
  }],
  ['接线：过滤构造器 / 槽位与 LoRA 都是数据驱动', () => {
    const app = frontendSrc();
    for (const needle of [
      "from './widgets.js'", 'id="dFilterPool"', 'id="dFilterTag"', 'hotTagChipsHtml(',
      'function setFilterSpec(', 'async function loadTagOptions(', 'normalizeLoras(',
      'await loadTagOptions()',
    ]) {
      assert.ok(app.includes(needle), `app.js 缺少接线：${needle}`);
    }
    // 槽位 / LoRA 行已改为 Vue v-for + v-model：判据从「有拼 HTML 的函数」变成
    // 「模板里有循环，且不再靠 data-slot / data-lora-w 回写 state」
    assert.match(app, /v-for="\(s, i\) in slots"/, '槽位行要由 v-for 渲染');
    assert.match(app, /v-model\.number="s\.count"/, '槽位条数要双向绑定，别再用 data-slot 回写');
    assert.match(app, /v-for="\(x, i\) in loras"/, 'LoRA 行要由 v-for 渲染');
    assert.match(app, /v-model\.number="x\.weight"/, 'LoRA 权重要双向绑定');
    assert.doesNotMatch(app, /data-slot=|data-lora-w=/, 'DOM → state 的槽位/LoRA 回写通道应已删除');
    assert.doesNotMatch(app, /JSON\.parse\(\$\('#pLoras'\)/, 'LoRA 不再要求用户手写 JSON');
    assert.doesNotMatch(app, /槽位 JSON（pool/, '槽位 JSON 不再作为主输入');
  }],
  ['概念卡片：脏数据归一化 / 图片 URL 白名单 / 去重', () => {
    const rows = W.normalizeConcepts([
      { key: 'asuna (sao)', label: 'asuna \\(sao\\)', kind: '角色', pool: '角色',
        image_count: 5, thumbs: [{ id: 3, url: '/api/images/3/thumb' },
          { url: 'javascript:alert(1)' }] },
      { key: 'asuna (sao)', label: 'dup' }, null, 'bad',
      { key: 'wai.safetensors', label: 'wai', filterable: false,
        thumb_url: 'http://evil.example/x.png' },
    ]);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].thumbs.length, 1);
    assert.equal(rows[0].thumbs[0].url, '/api/images/3/thumb');
    assert.equal(rows[1].thumbs.length, 0, '外链图片必须被拒绝');
    assert.equal(rows[1].filterable, false);
  }],
  ['概念卡片：默认零图片 / hover 按需 / 点名称进详情页', () => {
    const html = W.conceptCardHtml({ key: 'asuna (sao)', label: 'asuna (sao)',
      kind: '角色', pool: '角色', image_count: 5, draw_count: 9,
      thumbs: [{ id: 3, url: '/api/images/3/thumb' },
        { id: 4, url: '/api/images/4/thumb' }] });
    assert.equal((html.match(/<img /g) || []).length, 0, '卡片列表不许铺任何图片');
    assert.match(html, /data-cover-key="asuna \(sao\)"/);
    assert.match(html, /data-act="concept-pick"/);
    assert.match(html, /data-pool="角色"/);
    assert.match(html, /data-v="asuna \(sao\)"/);
    assert.match(html, /href="#\/concept\//, '概念名必须是详情页链接');
    assert.match(html, /5 张出图 \/ 9 次抽到/);
    assert.match(html, /按 角色 池/);
    const injected = W.conceptCardHtml({ key: '<img src=x>', label: '"x"', pool: 'a' });
    assert.match(injected, /&lt;img/);
    assert.doesNotMatch(injected, /<img src=x>/);
    const info = W.conceptCardHtml({ key: 'wai', label: 'wai', filterable: false });
    assert.match(info, /data-act="concept-open"/);
    assert.doesNotMatch(info, /data-act="concept-pick"/);
  }],
  ['概念墙：空态提示 / 跨类别 / 选中高亮 / 整墙零图片', () => {
    assert.match(W.conceptCardsHtml([]), /先抽几次卡/);
    const html = W.conceptCardsHtml([
      { key: 'a', label: 'A', kind: '画师', pool: '画师',
        thumbs: [{ url: '/api/images/1/thumb' }] },
      { key: 'b', label: 'B', kind: '服装', pool: '服装',
        thumbs: [{ url: '/api/images/2/thumb' }] },
    ], { selectedKeys: ['A'] });
    assert.equal((html.match(/class="concept-card/g) || []).length, 2);
    assert.equal((html.match(/concept-card picked/g) || []).length, 1);
    assert.equal((html.match(/<img /g) || []).length, 0, '一屏不许铺出上百个 img');
    assert.match(html, /画师/);
    assert.match(html, /服装/);
  }],
  ['类别切换 chip：全部 + 数据库真实类别', () => {
    const html = W.conceptKindChipsHtml(
      [{ kind: '画师', count: 20 }, { kind: '服装', count: 325 }], '服装');
    assert.match(html, /data-v="服装"/);
    assert.match(html, /class="chip hot on"/);
    assert.match(html, /325/);
    assert.equal((html.match(/data-act="concept-kind"/g) || []).length, 3);
  }],
  ['语义卡片：只留一个锚点 URL，图片不预先铺开', () => {
    const html = W.semanticCardsHtml([{ name: 'quasarcake', core: true,
      thumb_url: '/api/semantics/thumb?index=430',
      reason: [{ tag: '厚涂' }, { tag: '柔和光影' }],
      history: { image_count: 2, thumbs: [{ url: '/api/images/9/thumb' }] } }]);
    assert.equal((html.match(/<img /g) || []).length, 0);
    assert.match(html, /data-act="semantic-pick"/);
    assert.match(html, /data-v="quasarcake"/);
    assert.match(html, /data-cover-url="\/api\/semantics\/thumb\?index=430"/);
    assert.match(html, /data-cover-count="2"/);
    assert.match(html, /核心/);
    assert.match(html, /厚涂 \/ 柔和光影/);
    assert.match(html, /href="#\/concept\//);
    assert.match(W.semanticCardsHtml([]), /输入一句想要的感觉/);
    assert.doesNotMatch(
      W.semanticCardsHtml([{ name: 'x', thumb_url: 'javascript:alert(1)' }]), /javascript:/);
  }],
  ['结果卡槽位：只给概念 chip，悬浮才出图 / 去重 / 空白输入', () => {
    const map = { 'asuna (sao)': '/api/images/9/thumb', outdoors: '/api/images/8/thumb' };
    const html = W.conceptStripHtml([
      { slot: '角色', tags: ['1girl, asuna \\(sao\\), outdoors'] },
      { slot: '角色', tags: ['asuna (sao)'] },
      { slot: '背景', tags: ['javascript:alert(1)'] },
    ], map);
    assert.equal((html.match(/<img /g) || []).length, 0);
    assert.equal((html.match(/data-cover-key=/g) || []).length, 4,
      '切词去重后应得到 4 个概念 chip');
    assert.match(html, /data-cover-key="asuna \(sao\)"/);
    assert.match(html, /data-cover-key="outdoors"/);
    assert.equal(W.conceptStripHtml([], map), '');
    assert.equal(W.conceptStripHtml(null, null), '');
  }],
  ['hover 浮层：只渲染一张代表图 / 无图降级 / 外链拒绝', () => {
    const html = W.coverPopoverHtml({ key: 'asuna (sao)', found: true, image_count: 7,
      image: { url: '/api/images/3/thumb' } });
    assert.equal((html.match(/<img /g) || []).length, 1, '每个概念只要一张缩略图');
    assert.match(html, /7 张出图/);
    assert.match(html, /点概念名看全部/);
    const empty = W.coverPopoverHtml({ key: 'x', found: false });
    assert.equal((empty.match(/<img /g) || []).length, 0);
    assert.match(empty, /还没有这个概念/);
    assert.doesNotMatch(W.coverPopoverHtml({ key: 'x', found: true,
      image: { url: 'javascript:alert(1)' } }), /javascript:/);
  }],
  ['概念详情页：50 张上限提示 / 网格 / 评分收藏 / 加载更多', () => {
    const html = W.conceptDetailHtml({ key: 'asuna (sao)', label: 'asuna (sao)',
      kind: '角色', pool: '角色', total: 73, items: [
        { id: 1, url: '/api/images/1/thumb', rating: 0, favorite: false },
        { id: 2, url: '/api/images/2/thumb', rating: 5, favorite: true },
      ] });
    assert.equal((html.match(/<img /g) || []).length, 2, '详情页才铺图');
    assert.match(html, /首屏上限 50 张/);
    assert.match(html, /共 73 张/);
    assert.match(html, /data-act="concept-more"/);
    assert.match(html, /data-act="img-rate"/);
    assert.match(html, /data-act="img-fav"/);
    assert.match(html, /data-act="img-open"/);
    assert.match(html, /data-act="concept-back"/);
    const xss = W.conceptDetailHtml({ key: '<img src=x>', total: 0, items: [] });
    assert.doesNotMatch(xss, /<img src=x>/);
  }],
  ['app.js 接线：按需悬浮 / 封面缓存 / 概念页路由 / 评分换封面', () => {
    const app = frontendSrc();
    for (const needle of [
      'conceptCardsHtml(', 'conceptKindChipsHtml(', 'semanticCardsHtml(',
      'conceptStripHtml(', 'coverPopoverHtml(', 'conceptDetailHtml(',
      'function filterPaneHtml(', 'function setFilterMode(',
      'function loadConcepts(',
      'function loadSemantics(', 'function syncConceptPanel()',
      'function showCover(', 'function hideCover(', 'function onCoverOver(',
      'function renderConceptPage(', "raw.startsWith('concept/')",
      // 动作已按域搬进注册表：断言语义仍是「这个动作必须有人接」，不再绑定 switch 写法
      /'concept-pick':/, /'semantic-pick':/, /'concept-kind':/,
      /'concept-more':/, /'img-rate':/, /'img-fav':/,
      '/api/concepts/wall', '/api/concepts/cover', '/api/concepts/images',
      'mouseover', 'focusin', 'state.covers.cache = {}',
      'id="conceptWall"', 'id="semanticCards"',
    ]) {
      const hit = needle instanceof RegExp ? needle.test(app) : app.includes(needle);
      assert.ok(hit, `缺少接线：${needle}`);
    }
    assert.doesNotMatch(app, /thumbs: '2'/, '概念墙不再一次拉多张缩略图');
  }],
  ['缺槽位提示：类别与具体池名统一折算成 kind', () => {
    const pools = [
      { name: '画师图鉴', kind: '画师' },
      { name: 'zh_TW', kind: '角色' },
      { name: '自然景观-花卉', kind: '背景' },
    ];
    const recipe = { definition: { slots: [{ pool: '自然景观-花卉' }, { pool: '角色' }] } };
    const missing = W.missingFilterSlots('画师:bowalia, 角色:asuna, fate', recipe, pools);
    assert.deepEqual(missing.map((r) => `${r.pool}:${r.tag}`), ['画师:bowalia']);
    // 具体池名 zh_TW 折算成「角色」kind，与配方的「角色」槽位匹配，不该再提示
    assert.deepEqual(W.missingFilterSlots('zh_TW:asuna', recipe, pools), []);
    assert.deepEqual(W.missingFilterSlots('画师:bowalia',
      { definition: { slots: [{ pool: '画师' }] } }, pools), []);
    // 不用配方 / 空表达式 / 裸关键字都不提示
    assert.deepEqual(W.missingFilterSlots('画师:bowalia', null, pools), []);
    assert.deepEqual(W.missingFilterSlots('', recipe, pools), []);
    assert.deepEqual(W.missingFilterSlots('fate', recipe, pools), []);
  }],
  ['抽卡台布局：设置 sticky + 结果优先 + 探索并入过滤面板', () => {
    const app = frontendSrc();
    const css = readFileSync(new URL('../frontend/styles.css', import.meta.url), 'utf8');
    for (const needle of ['class="draw-shell"', 'class="draw-side"',
      'class="draw-main"', 'function filterPaneHtml(', 'data-act="filter-mode"',
      'missingFilterSlots(', 'min(96vw, 1680px)']) {
      assert.ok(app.includes(needle) || css.includes(needle),
        `左右布局缺少接线：${needle}`);
    }
    assert.match(css, /\.draw-side\s*\{[^}]*position:\s*sticky/);
    assert.match(css, /\.draw-shell\s*\{[^}]*336px/);
    // 三种过滤入口必须在左栏设置面板内，不能再挂到右栏结果之后
    const side = (app.match(/<aside class="draw-side">[\s\S]*?<\/aside>/) || [''])[0];
    const main = (app.match(/<section class="draw-main">[\s\S]*?<\/section>/) || [''])[0];
    assert.ok(side.includes('filterPaneHtml(mode)'), '过滤面板必须在设置栏内');
    assert.ok(!main.includes('conceptPanel'), '概念探索不能再挂在结果区末尾');
    assert.doesNotMatch(app, /conceptPanel\(\)/, '旧的全宽概念面板应已移除');
  }],
  ['结果卡内联状态：图长在卡片上，提交生图不再跳任务队列', () => {
    const app = frontendSrc();
    const css = readFileSync(new URL('../frontend/styles.css', import.meta.url), 'utf8');
    assert.match(app, /function drawStateHtml\(d\)/, '缺少卡片状态渲染');
    assert.match(app, /function updateDrawCard\(id\)/, '缺少局部刷新');
    assert.match(app, /async function refreshDrawStates\(ids\)/, '缺少批量状态拉取');
    assert.match(app, /\/api\/draws\/status\?draw_ids=/, '未接批量状态接口');
    assert.match(app, /data-state-for="\$\{d\.id\}"/, '卡片缺少状态容器');
    assert.match(app, /data-act="draw-and-gen"[^>]*>抽卡并生图/, '主按钮未合并生图');
    assert.match(app, /data-act="draw">只抽卡/, '缺少只抽卡次级入口');
    const submit = (app.match(/async function submitJobs[\s\S]*?\n\}/) || [''])[0];
    assert.ok(submit, '未找到 submitJobs');
    assert.doesNotMatch(submit, /done\([^)]*\);\s*location\.hash = '#jobs'/,
      '提交生图默认不能跳页');
    // 只有显式 opts.gotoJobs（画廊「同参重跑」这类跨页场景）才允许跳
    assert.match(submit, /if \(opts\.gotoJobs\) location\.hash = '#jobs'/,
      '跳页必须是显式可选项');
    assert.match(app, /state\.drawImages\[did\] = ids\.map/,
      '完成事件应直接用 image_ids 上图');
    assert.match(css, /\.card-state\s*\{/, '缺少状态区样式');
    assert.match(css, /\.shot-img\s*\{/, '缺少卡片内缩略图样式');
  }],
  ['缺槽位可就地固定进配方：不用跳配方编辑器再手动选一遍池', () => {
    const app = frontendSrc();
    assert.match(app, /function missingSlots\(\)/, '缺少缺槽位判断');
    assert.match(app, /async function addFilterToRecipe\(\)/, '缺少一键加槽位');
    assert.match(app, /data-act="fix-recipe"/, '提示旁缺少按钮');
    assert.match(app, /api\.put\('\/api\/recipes\/' \+ rid/, '应直接改配方');
    assert.match(app, /def\.slots\.push\(\{ pool: m\.pool, count: 1, weight: 1, filter: m\.tag \}\)/,
      '槽位要带上 tag 过滤，否则加进去也抽不到指定条目');
    assert.match(app, /id="filterHintBox"/, '提示区要能随输入更新');
  }],
  ['参数预设就地调参：保存即应用，且不漏传 loras', () => {
    const app = frontendSrc();
    assert.match(app, /async function openTuning\(\)/, '缺少调参抽屉');
    assert.match(app, /function tuningHtml\(\)/, '缺少调参表单');
    assert.match(app, /async function saveTuning\(\)/, '缺少保存逻辑');
    assert.match(app, /data-act="tune-open"/, '设置栏缺少调参入口');
    assert.match(app, /data-act="tune-save"/, '缺少保存按钮');
    // body 构造已收敛到 features/generation.js（多模型改造：三处 profile 编辑合一）
    const gen = readFileSync(new URL('../frontend/features/generation.js', import.meta.url), 'utf8');
    assert.match(gen, /loras: t\.loras \|\| \[\]/, '漏传 loras');
    assert.match(gen, /workflow: \$\('Workflow'\)\?\.value/, 'workflow 从选择器读，不再硬编码');
    assert.match(app, /state\.form\.gen_profile_id = String\(saved\.id\)/,
      '保存后应自动应用，否则还要手动重选预设');
  }],
  ['五星评分：点第 n 颗给 n 分、点当前分清零、画廊不再 +1 循环', () => {
    const app = frontendSrc();
    const html = W.ratingStarsHtml(7, 3);
    assert.match(html, /data-stars-for="7"/);
    assert.equal((html.match(/class="star on"/g) || []).length, 3, '3 分应点亮 3 颗');
    assert.match(html, /data-id="7" data-v="0"/, '点当前分应清零');
    assert.match(html, /data-v="5"/, '应能直接点到 5 分');
    assert.equal((W.ratingStarsHtml(9, 0).match(/class="star on"/g) || []).length, 0);
    assert.equal((W.ratingStarsHtml(1, 99).match(/class="star on"/g) || []).length, 5,
      '越界评分要夹到 5');
    assert.doesNotMatch(app, /\(im\.rating % 5\) \+ 1/, '画廊不能再用 +1 循环');
    assert.match(app, /function paintStars\(id, rating\)/, '缺少星级局部更新');
    assert.match(app, /ratingStarsHtml\(im\.id, im\.rating\)/, '画廊未接五星');
  }],
  ['装配：人数由人物卡张数推导', () => {
    const f = (n, g) => ({ uid: n, gender: g, slots: {} });
    assert.equal(W.countTagsFor([]), 'no humans', '0 人必须是无人物');
    assert.equal(W.countTagsFor([f(1, 'female')]), '1girl');
    assert.equal(W.countTagsFor([f(1, 'male')]), '1boy');
    assert.equal(W.countTagsFor([f(1, 'female'), f(2, 'female')]), '2girls');
    assert.equal(W.countTagsFor([f(1, 'male'), f(2, 'male')]), '2boys');
    assert.equal(W.countTagsFor([f(1, 'female'), f(2, 'male')]), '1girl, 1boy');
    const three = W.countTagsFor([f(1, 'female'), f(2, 'female'), f(3, 'male')]);
    assert.match(three, /multiple girls/, '3 人以上要带 multiple');
    assert.doesNotMatch(three, /solo/, '人数标签里不能出现 solo');
  }],
  ['装配：编译成配方定义（关闭不产生槽位、锁定带 pick）', () => {
    const p = W.makePerson(1, 'female');
    p.slots.role = { kind: '角色', mode: 'locked', pick: 'artoria pendragon' };
    p.slots.outfit = { kind: '服装', mode: 'off', pick: '' };
    p.slots.gear = { kind: '物品', mode: 'random', pick: '' };
    const scene = W.makeScene();
    scene.background = { kind: '背景', mode: 'locked', pick: 'flower field' };
    scene.style = { kind: '风格', mode: 'off', pick: '' };
    const def = W.assemblyToDefinition({ people: [p], scene });
    assert.equal(def.count_tags, '1girl');
    assert.equal(def.fixed_head, 'masterpiece, best quality');
    const pools = def.slots.map((s) => s.pool);
    assert.ok(!pools.includes('服装'), '关闭的格子不能产生槽位');
    assert.ok(!pools.includes('风格'), '关闭的场景格不能产生槽位');
    assert.deepEqual(pools.slice(0, 1), ['背景'], '场景排在人物之前');
    const role = def.slots.find((s) => s.pool === '角色');
    assert.equal(role.pick, 'artoria pendragon', '锁定必须带 pick');
    const gear = def.slots.find((s) => s.pool === '物品');
    assert.equal(gear.pick, undefined, '随机格不能带 pick，否则永远是同一件');
    // mode/group 现在要传给后端存进 slot_extras：快照复现三态与意群归属的前提。
    // 旧断言禁止它们进定义，是「快照只存 pool/count/weight」时代的补丁口径。
    assert.ok(def.slots.every((s) => s.mode && s.group),
      '每个槽位都带 mode/group，后端据此存快照（刷新后锁定标记不丢）');
    assert.equal(role.group, 'P1', '人物槽位带意群归属');
    // 默认状态是一张白纸：一进来任何格子都不该替用户做决定
    const fresh = W.assemblyToDefinition({ people: [W.makePerson(9)], scene: W.makeScene() });
    assert.equal(fresh.slots.length, 0, '默认全关：不预先把随机塞进 prompt');
    assert.equal(W.assemblyIsEmpty({ people: [W.makePerson(9)], scene: W.makeScene() }),
      true, '默认状态 = 空装配');
    const allSlots = [...W.PERSON_SLOTS, ...W.SCENE_SLOTS];
    assert.ok(allSlots.every((d) => d.fallback === 'off'),
      '每一格的默认值都必须是「关闭」：打开哪格才让哪格参与');
    assert.ok(!allSlots.some((d) => d.fallback === 'random'), '不能再有默认随机');
  }],
  ['装配：两人各自独立、全关判定为空', () => {
    const a = W.makePerson(1, 'female');
    a.slots.role = { kind: '角色', mode: 'locked', pick: 'artoria' };
    const b = W.makePerson(2, 'male');
    b.slots.role = { kind: '角色', mode: 'random', pick: '' };
    const scene = W.makeScene();
    W.SCENE_SLOTS.forEach((d) => { scene[d.key].mode = 'off'; });
    Object.keys(a.slots).forEach((k) => { if (k !== 'role') a.slots[k].mode = 'off'; });
    Object.keys(b.slots).forEach((k) => { if (k !== 'role') b.slots[k].mode = 'off'; });
    const def = W.assemblyToDefinition({ people: [a, b], scene });
    assert.equal(def.slots.length, 2, '两人各一个角色槽位');
    assert.equal(def.slots[0].pick, 'artoria', '第一人锁定');
    assert.equal(def.slots[1].pick, undefined, '第二人随机');
    assert.equal(def.count_tags, '1girl, 1boy');
    const empty = { people: [], scene: W.makeScene() };
    assert.equal(W.assemblyIsEmpty(empty), true, '默认全关应判定为空，回落到配方路径');
    const opened = { people: [], scene: W.makeScene() };
    opened.scene.background.mode = 'random';
    assert.equal(W.assemblyIsEmpty(opened), false, '打开一格就不算空');
  }],
  ['意群：场景/人物各有自己的自由词，按意群顺序进 prompt，不串味', () => {
    const scene = W.makeScene();
    W.SCENE_SLOTS.forEach((d) => { scene[d.key].mode = 'off'; });
    const p1 = W.makePerson(1, 'female');
    const p2 = W.makePerson(2, 'male');
    [p1, p2].forEach((p) => Object.keys(p.slots).forEach((k) => { p.slots[k].mode = 'off'; }));
    assert.equal(typeof scene.extra, 'string', '场景有自己的 extra');
    assert.equal(typeof p1.extra, 'string', '每个人物有自己的 extra');
    // 全空 = 空装配；只写某个意群 = 非空
    assert.equal(W.assemblyIsEmpty({ people: [p1, p2], scene }), true);
    scene.extra = 'flower field';
    p1.extra = 'black hair, watching tv';
    p2.extra = 'blonde hair, eat beef';
    const def = W.assemblyToDefinition({ people: [p1, p2], scene });
    assert.equal(def.slots.length, 3, '三个意群各一个自由词槽');
    assert.deepEqual(def.slots.map((s) => s.pool),
      ['任意值·场景', '任意值·P1', '任意值·P2'], '槽位名标注意群，明细里看得出归属');
    assert.deepEqual(def.slots.map((s) => s.free),
      ['flower field', 'black hair, watching tv', 'blonde hair, eat beef'],
      '先场景后人物1再人物2，各意群内容挨在一起，不会串味');
    assert.ok(def.slots.every((s) => s.pick === undefined), '自由词与 pick 互斥');
    // 旧会话的全局 extra 迁到场景，不让用户的词凭空消失
    const g = W.makeScene();
    const legacy = W.assemblyToDefinition({ people: [], scene: g, extra: 'legacy tag' });
    assert.equal(legacy.slots[0].free, 'legacy tag');
    assert.equal(legacy.slots[0].pool, '任意值·场景');
    // 括号不是分组语法：编译结果里不出现括号包裹的整串
    assert.ok(!def.slots.some((s) => /^\(.+\)$/.test(s.free || '')),
      'prompt 不写括号——A1111 里那是权重，不是意群分组');
  }],
  ['意群自由词输入：每个意群可点选、双语候选显示、写英文', () => {
    const app = frontendSrc();
    assert.match(app, /function asmGroupInputHtml\(scope, uid, label\)/, '有意群输入渲染函数');
    assert.match(app, /data-act="asm-extra"/, '有查询输入框');
    assert.match(app, /asmGroupInputHtml\('scene', 0/, '场景意群挂了输入');
    assert.match(app, /asmGroupInputHtml\('person', p\.uid/, '每个人物卡挂了输入');
    assert.ok(!/function asmExtraHtml\(/.test(app), '底部全局输入已拆除');
    // 查询与结果分离：中文查询不写进 extra，只写候选的英文
    assert.match(app, /state\.vocab\.q = t\.value/, '查询词存在独立 vocab 状态');
    assert.match(app, /vocabAddWord\(/, '点候选写英文到意群 extra');
    assert.match(app, /\/api\/vocab\/suggest/, '接了词表补全接口');
    assert.match(app, /\[\\u4e00-\\u9fff\]/, '没有候选时拦住中文，不写进 prompt');
    const css = readFileSync(new URL('../frontend/styles.css', import.meta.url), 'utf8');
    assert.match(css, /\.vocab-suggest \{/, '候选下拉样式');
    assert.match(css, /\.vocab-chip \{/, '已选词 chip 样式');
  }],
  ['装配：app.js 接线与提交优先级', () => {
    const app = frontendSrc();
    for (const needle of ['asm-tab', 'asm-add', 'asm-del', 'asm-copy', 'asm-gender',
      'asm-open', 'asm-mode', 'asm-pick', 'asm-close', 'asm-pool', 'asm-q',
      'assemblyPanelHtml', 'asmLoadEntries', '/api/pools/items']) {
      assert.ok(app.includes(needle), `装配面板缺少接线：${needle}`);
    }
    assert.match(app, /const useAssembly = !assemblyIsEmpty\(state\.assembly\)/,
      '提交时必须先判断装配是否有内容');
    assert.match(app, /recipe_id: useAssembly \? null :/, '装配优先，不能被配方覆盖');
    assert.match(app, /filter: useAssembly \? '' :/, '装配模式下不能再叠全局过滤');
    assert.match(app, /data-scope="scene"/, '场景格与人物格要用 scope 区分');
  }],
  ['状态栏立绘：从条目的英文 tags 推概念 key，不吃中文 label', () => {
    const cfg = { mode: 'locked', pick: '阿爾托莉亞 (Fate/Grand Order)',
      tags: '1girl, artoria pendragon \\(fate\\), fate \\(series\\)' };
    const keys = W.portraitKeys(cfg);
    assert.equal(keys[0], 'artoria pendragon (fate)', '要取剥掉人数后的第一个 tag');
    assert.ok(!keys.includes('1girl'), '人数 tag 不能当成概念 key');
    assert.ok(keys.length <= 3, '候选最多 3 个，避免一串请求');
    // 旧会话没有 tags：退回 pick 试一次，不能直接空手
    assert.deepEqual(W.portraitKeys({ mode: 'locked', pick: 'Artoria' }), ['artoria']);
    assert.deepEqual(W.portraitKeys({ mode: 'random', tags: '' }), []);
  }],
  ['状态栏立绘：人数 tag 剥离与后端同一套语义', () => {
    for (const t of ['1girl', '2boys', 'multiple girls', 'no humans', 'solo', 'solo focus']) {
      assert.deepEqual(W.stripCountTags(t), [], `${t} 应被剥离`);
    }
    // 正常内容不能被误伤
    assert.deepEqual(W.stripCountTags('girl, artoria'), ['girl', 'artoria']);
    assert.deepEqual(W.stripCountTags('flower field, blue sky'), ['flower field', 'blue sky']);
    assert.equal(W.conceptKeyOf('  Artoria \\\\(Fate\\\\) '), 'artoria (fate)');
  }],
  ['状态栏立绘：标题只在锁定角色时显示条目名', () => {
    const p = W.makePerson(1, 'female');
    assert.equal(W.personTitle(p), '', '默认随机时不该显示角色名');
    p.slots.role = { kind: '角色', mode: 'locked', pick: '阿爾托莉亞', tags: '1girl, artoria' };
    assert.equal(W.personTitle(p), '阿爾托莉亞');
    assert.equal(p.slots.role.tags, '1girl, artoria', '锁定后要记住 tags，立绘靠它查');
  }],
  ['任务卡：锁定的槽位要能一眼认出', () => {
    const html = slotChips([{ slot: '角色', tags: ['artoria'], locked: '阿爾托莉亞' }]);
    assert.match(html, /chip locked/, '锁定槽位要加 locked 样式');
    assert.match(html, /chip-lock/, '锁定槽位要有「锁」标记');
    assert.match(html, /角色: artoria/, '锁定不能吃掉原有内容');
    assert.doesNotMatch(slotChips([{ slot: '角色', tags: ['artoria'] }]), /chip-lock/,
      '随机槽位不该出现锁标记');
  }],
  ['任务卡与状态栏：app.js 接线', () => {
    const app = frontendSrc();
    const css = readFileSync(new URL('../frontend/styles.css', import.meta.url), 'utf8');
    for (const needle of ['doll-art', 'data-portrait', 'loadPortraits', 'asm-portrait',
      'dollFigureHtml', 'sceneStageHtml', 'part-k', 'part-v',
      'questState', 'quest-badge', 'quest-flag', 'quest-loadout', 'quest-foot',
      'data-flag-for']) {
      assert.ok(app.includes(needle) || css.includes(needle), `缺少接线：${needle}`);
    }
    // 徽标与描边要跟着状态走，否则卡片头尾说法不一致
    assert.match(app, /card\.dataset\.status = st\.key/,
      '状态变化时任务卡描边要同步');
    assert.match(app, /loadPortraits\(\)\.catch/,
      '立绘必须异步补，不能阻塞面板渲染');
    assert.match(css, /\.quest\[data-status="running"\]\s*\.bar\s*>\s*i/,
      '生成中要有条纹进度条');
  }],
  ['线稿小人：部位槽位对齐身体、三态写在身上', () => {
    const p = W.makePerson(7, 'female');
    p.slots.hair = { kind: '发型', mode: 'locked', pick: 'silver hair', tags: 'silver hair' };
    p.slots.action = { kind: '动作', mode: 'off', pick: '', tags: '' };
    const html = W.dollFigureHtml(p.slots, { uid: 7, gender: 'female' });
    assert.match(html, /<svg class="doll-svg"/, '必须是内联 SVG，不能是图片');
    for (const key of ['face', 'hair', 'outfit', 'gear', 'action']) {
      assert.ok(html.includes(`data-key="${key}"`), `缺少部位：${key}`);
    }
    assert.equal((html.match(/data-act="asm-open"/g) || []).length, 5,
      '五个部位都要能点开对应那格');
    assert.equal((html.match(/data-scope="person"/g) || []).length, 5);
    assert.match(html, /class="doll-zone m-locked"[^>]*data-key="hair"/, '锁定要画成实线');
    assert.match(html, /class="doll-zone m-off"[^>]*data-key="action"/, '关闭要淡出');
    assert.match(html, /class="doll-zone m-off"[^>]*data-key="outfit"/,
      '未打开的格子默认关闭：只留底稿身体，不画虚线部位');
    // 打开一格（随机）才画成虚线
    p.slots.outfit = { kind: '服装', mode: 'random', pick: '', tags: '' };
    assert.match(W.dollFigureHtml(p.slots, { uid: 7, gender: 'female' }),
      /class="doll-zone m-random"[^>]*data-key="outfit"/, '打开随机后画虚线');
    assert.ok(html.includes('data-uid="7"'), '部位点击要带上人物 uid');
    // 空状态：0 张人物卡也要有个占位小人，但不能可点（没有可改的对象）
    const ghost = W.dollFigureHtml({}, { ghost: true });
    assert.ok(ghost.includes('is-ghost'));
    assert.ok(!ghost.includes('data-act'), '占位小人不能挂点击事件');
    assert.match(ghost, /m-off/, '占位小人只有底稿轮廓，没有任何格子是打开的');
    // 男/女轮廓不同，才看得出这是个人
    assert.notEqual(W.dollFigureHtml(p.slots, { uid: 1, gender: 'male' }),
      W.dollFigureHtml(p.slots, { uid: 1, gender: 'female' }));
  }],
  ['场景线稿：点画面/色点/签名/画框分别对应背景画风画师构图', () => {
    const scene = W.makeScene();
    scene.background = { kind: '背景', mode: 'locked', pick: 'flower field', tags: '' };
    scene.composition = { kind: '构图', mode: 'off', pick: '', tags: '' };
    scene.style = { kind: '风格', mode: 'random', pick: '', tags: '' };
    const html = W.sceneStageHtml(scene);
    for (const key of ['background', 'style', 'artist', 'composition']) {
      assert.ok(html.includes(`data-key="${key}"`), `场景缺少区域：${key}`);
    }
    assert.equal((html.match(/data-scope="scene"/g) || []).length, 4);
    assert.match(html, /class="doll-zone m-locked"[^>]*data-key="background"/);
    assert.match(html, /class="doll-zone frame m-off"/, '画框就是构图那一格');
    assert.match(html, /class="doll-zone m-random"[^>]*data-key="style"/);
    assert.ok(html.includes('thirds'), '构图要有三分线做提示');
    assert.ok(!html.includes('data-act="asm-open" data-scope="person"'), '场景不能误挂人物 scope');
  }],
  ['部位版面：格子与身体位置的对应关系写在 CSS 里', () => {
    const css = readFileSync(new URL('../frontend/styles.css', import.meta.url), 'utf8');
    assert.match(css, /grid-template-areas:\s*"role\s+role\s+role"\s*"hair\s+doll\s+face"/,
      '必须按身体位置排版：角色在头顶、发型/表情贴头');
    assert.match(css, /"outfit\s+doll\s+gear"/, '衣着/装备放在身体两侧');
    assert.match(css, /"action\s+action\s+action"/, '动作横在脚下');
    for (const key of ['role', 'hair', 'face', 'outfit', 'gear', 'action']) {
      assert.ok(css.includes(`.part[data-key="${key}"]`), `缺少部位落位：${key}`);
    }
    assert.match(css, /\.doll-zone\s*\{[^}]*stroke-dasharray/, '随机状态必须是虚线');
    assert.match(css, /\.doll-zone\.m-locked\s*\{[^}]*stroke-dasharray:\s*none/,
      '锁定要变成实线');
    assert.match(css, /\.part\.side-l::after/, '左列要有连到小人的虚线');
  }],
  ['池匹配：点哪个部位就先摆哪些池', () => {
    const pools = [
      { name: '组合预设/服装-女性简单穿搭', kind: '服装', item_count: 740 },
      { name: '人物-衣服', kind: '服装', item_count: 190 },
      { name: 'DanbooruTAG/audio_instruments_brass', kind: '服装', item_count: 9 },
      { name: 'DanbooruTAG/panties_main', kind: '服装', item_count: 41 },
      { name: '人文景观-建筑', kind: '背景', item_count: 88 },
      { name: '自然景观-花卉', kind: '背景', item_count: 177 },
      { name: 'wai_characters', kind: '角色', item_count: 5108 },
      { name: '人物-类型', kind: '角色', item_count: 104 },
    ];
    const outfit = W.rankPools(pools, '服装', 'outfit').map((p) => p.name);
    assert.equal(outfit[0], '组合预设/服装-女性简单穿搭', '衣着先给能穿的池');
    assert.ok(outfit.indexOf('DanbooruTAG/audio_instruments_brass') > outfit.indexOf('DanbooruTAG/panties_main'),
      '跑偏池必须排到最后');
    // 只在 kind 内匹配，不能把背景池混进衣着
    assert.ok(!outfit.includes('人文景观-建筑'), 'kind 要严格过滤');

    const bg = W.rankPools(pools, '背景', 'background').map((p) => p.name);
    assert.equal(bg[0], '人文景观-建筑', '背景要先给建筑/场景，不是花卉');

    const role = W.rankPools(pools, '角色', 'role').map((p) => p.name);
    assert.equal(role[0], 'wai_characters', '角色要先给真实角色名池');

    // 没见过的部位不猜：返回空数组而不是把全部池倒出来
    assert.deepEqual(W.rankPools(pools, '服装', 'nope').length, 4, '未知部位仍按 kind 过滤');
  }],
  ['池 chip：全部在最前，池名与条数都可点', () => {
    const pools = [
      { name: '人物-衣服', kind: '服装', item_count: 190 },
      { name: '组合预设/服装-女性简单穿搭', kind: '服装', item_count: 740 },
      { name: 'DanbooruTAG/panties_main', kind: '服装', item_count: 41 },
    ];
    // 选中一个排在后面的池：它必须被提到行首并高亮，不能「藏着」让用户不知道自己选了啥
    const html = W.poolChipsHtml(pools, '服装', 'outfit', 'DanbooruTAG/panties_main', 1);
    assert.ok(html.startsWith('<button'), '第一项必须是「全部」chip');
    assert.match(html, /data-act="asm-pick-pool" data-v=""/, '「全部」要能点回默认');
    assert.match(html, /class="pool-chip on"[^>]*data-v="DanbooruTAG\/panties_main"/,
      '当前池即使排在后面也要高亮（提到行首）');
    assert.ok(html.includes('<i>41</i>'), 'chip 上要带条目数，用户才知道值不值得点');
    // 只摆 limit 个池 + 「全部」：放不下的靠标题里的「N 池匹配」与下拉，不占 chip 行空间
    assert.equal((html.match(/data-act="asm-pick-pool"/g) || []).length, 2,
      'chip 数量要受 limit 控制');
  }],
  ['池选择接线：选择器渲染 chip 行、默认落在最佳池', () => {    const app = frontendSrc();
    assert.match(app, /poolChipsHtml\(state\.pools/, '选择器要渲染匹配池 chip 行');
    assert.match(app, /asm-pick-pool['"]\s*:/, '点 chip 要有 handler（已搬进装配域注册表）');
    assert.match(app, /rankPools\(state\.pools[\s\S]{0,120}item_count/,
      '打开选择器时要默认落在条目最多的匹配池');
    const css = readFileSync(new URL('../frontend/styles.css', import.meta.url), 'utf8');
    assert.match(css, /\.asm-pools\s*\{[^}]*overflow-x:\s*auto/, 'chip 行横向滚动，不折行');
  }],
  ['快速筛选：`black h` 要能命中 `black hair`', () => {
    // 用户口径：每个长列表旁边一个 input，打半个词就能筛
    assert.ok(W.matchQuery('black hair, long hair', 'black h'), '半截词必须命中');
    assert.ok(W.matchQuery('black hair', 'hair black'), '词序不限');
    assert.ok(W.matchQuery('black_hair', 'black hair'), '下划线与空格等价（库里两种写法都有）');
    assert.ok(W.matchQuery('black hair', 'black_hair'), '反过来也要等价');
    assert.ok(!W.matchQuery('black hair', 'black skirt'), '多词是 AND，不是 OR');
    assert.ok(W.matchQuery('neg4all_v4', 'neg'), '前缀命中');
    assert.ok(W.matchQuery('随便什么', ''), '空词恒真');
    assert.deepEqual(W.queryWords('  Black   H '), ['black', 'h']);
  }],
  ['池筛选：搜到的池不受前 8 个截断', () => {
    const pools = [];
    for (let i = 0; i < 10; i += 1) {
      pools.push({ name: `组合预设/服装-第${i}款`, kind: '服装', item_count: 10 + i });
    }
    pools.push({ name: 'DanbooruTAG/hair', kind: '服装', item_count: 3 });
    const all = W.poolChipsHtml(pools, '服装', 'outfit', '', 8);
    assert.equal((all.match(/data-act="asm-pick-pool"/g) || []).length, 9,
      '不筛选时严格按 limit（8 池 + 全部）');
    const hit = W.poolChipsHtml(pools, '服装', 'outfit', '', 8, '第3');
    assert.match(hit, /data-v="组合预设\/服装-第3款"/, '筛选要真的把命中的池摆出来');
    assert.equal((hit.match(/data-act="asm-pick-pool"/g) || []).length, 2,
      '只命中一个池时 = 全部(清除筛选) + 1');
    assert.match(hit, /清除筛选/, '筛选态下第一个 chip 变成清除入口');
  }],
  ['筛选接线：各处都有 input，不是只有一个地方能用', () => {
    const app = frontendSrc();
    // LoRA 选择器的筛选框随 profile 编辑收敛到 features/generation.js
    const gen = readFileSync(new URL('../frontend/features/generation.js', import.meta.url), 'utf8');
    for (const id of ['pLoraPick', 'pCheckpoint', 'tCheckpoint', 'dFilterPool', 'rTplPool']) {
      // 抽卡台/过滤面板仍用 quickFilterHtml 生成；设置页与配方页是 Vue 模板，直接写 data-qf。
      // 判据统一成「有筛选框挂在这个 id 上」，不限定产出方式。
      const wired = (app + gen).includes(`quickFilterHtml('${id}'`)
        || new RegExp(`data-qf="${id}"`).test(app);
      assert.ok(wired, `${id} 旁边要有筛选框`);
    }
    assert.match(app, /data-asm-pool-q/, '抽卡装配的池 chip 行要能筛');
    assert.match(app, /冷存/, '冷存池要在下拉兜底里可见（否则「明明导入过怎么没有」）');
    assert.match(app, /a\.picking !== token/, '条目加载要丢过期响应（换格后旧数据不许覆盖新格）');
    assert.match(readFileSync(new URL('../frontend/api.js', import.meta.url), 'utf8'),
      /AbortSignal\.timeout/, 'API 请求要有超时，加载中不能永久卡死');
    assert.match(app, /pickerPool && \(!a\.pickerQ \|\| a\.pickerLocked\)/,
      '搜索要跨池：默认池只在没搜索或用户手动锁池时生效');
    const py = readFileSync(new URL('../backend/app/services/pools.py', import.meta.url), 'utf8');
    assert.match(py, /def _q_clauses/, '后端搜索要分词 AND，与前端 matchQuery 同语义');
    assert.match(py, /replace\(func\.lower\(PoolItem\.tags\), "_", " "\)/,
      '后端也要把下划线归一成空格');
  }],
  ['超重权重：只在组装 prompt 时剥，池子文本不动', () => {
    const recipes = readFileSync(new URL('../backend/app/core/recipes.py', import.meta.url), 'utf8');
    const poolsPy = readFileSync(new URL('../backend/app/core/pools.py', import.meta.url), 'utf8');
    assert.match(recipes, /from \.weights import strip_weights/, '配方抽卡要复用同一套剥离规则');
    assert.match(recipes, /strip_weights\(part\)/, 'run_recipe 要对每个 part 剥离');
    assert.match(recipes, /raw_tags/, '明细要留原文，能对照「这条为什么少了 :1.2」');
    assert.match(poolsPy, /strip_weights\(p\)/, '手工卡片出口 build_prompt 也要剥');
    // 反向断言：这两处以外不许悄悄改池子文本（抄到服务层去写库就错了）
    assert.ok(!/pool_items\s*\.\s*update|update\(pool_items\)/.test(recipes),
      '组装链路不许写库改条目');
    const clean = readFileSync(new URL('./clean_weights.py', import.meta.url), 'utf8');
    assert.match(clean, /--apply/, '审计脚本写库要显式 --apply');
    assert.match(clean, /这不写库|不需要写库/, '默认路径要说明「不用写库，出图时自动净化」');
    const detailJs = readFileSync(new URL('../frontend/detail.js', import.meta.url), 'utf8');
    assert.match(detailJs, /stripped_weight/, '装配明细要说明这条的权重被剥了（否则像抽错）');
  }],
  ['画师槽位：场景第四格默认关，池能按别名搜到', () => {
    const keys = W.SCENE_SLOTS.map((s) => s.key);
    assert.ok(keys.includes('artist'), '场景要有画师格');
    assert.equal(W.SCENE_SLOTS.find((s) => s.key === 'artist').kind, '画师');
    const scene = W.makeScene();
    assert.equal(scene.artist.mode, 'off', '画师默认关：专有名词摇错一位画风就全变');
    const asm = { scene: { ...scene, artist: { ...scene.artist, mode: 'locked', pick: 'dore (gilles dore)' } }, people: [] };
    const def = W.assemblyToDefinition(asm);
    assert.ok(def.slots.some((s) => s.pool === '画师'), '锁定的画师要进配方槽位');
    // 别名：口语「艺术家」和池名「画师图鉴」对不上，搜索必须能穿过这层
    const pools = [
      { name: '画师图鉴', kind: '画师', item_count: 1005, enabled: true },
      { name: 'SDXL/artists', kind: '画师', item_count: 3887, enabled: true },
    ];
    assert.equal(W.poolSearchText(pools[0]).includes('艺术家'), true);
    assert.equal(W.matchQuery(W.poolSearchText(pools[0]), '艺术家'), true);
    assert.equal(W.matchQuery(W.poolSearchText(pools[1]), '艺术家'), true);
    assert.equal(W.matchQuery(W.poolSearchText(pools[1]), 'artists'), true);
    // 排序：带中文风格标签的「画师图鉴」要排在裸名字池前面
    const ranked = W.rankPools(pools, '画师', 'artist');
    assert.equal(ranked[0].name, '画师图鉴', `第一个应是画师图鉴，实际 ${ranked[0].name}`);
  }],
  ['任意值：free 与 pick 互斥，都能进配方槽位', () => {
    const scene = W.makeScene();
    // free/pick 都是槽位级概念，用场景两格验证即可（人物格同一套代码）
    scene.artist = { kind: '画师', mode: 'locked', pick: '', free: 'zzz custom artist', tags: 'zzz custom artist' };
    scene.style = { kind: '风格', mode: 'locked', pick: '油画', free: '', tags: 'oil painting' };
    const def = W.assemblyToDefinition({ scene, people: [] });
    const hair = def.slots.find((s) => s.pool === '画师');
    const style = def.slots.find((s) => s.pool === '风格');
    assert.equal(hair.free, 'zzz custom artist', '手填值要走 slot.free');
    assert.ok(!('pick' in hair) || !hair.pick, '手填值不许同时写 pick（后端优先认 free）');
    assert.equal(style.pick, '油画');
    assert.ok(!('free' in style) || !style.free, '池里点的条目不许带 free');
  }],
  ['任意值接线：选择器里有「直接写进 prompt」的入口', () => {
    const app = frontendSrc();
    assert.match(app, /data-act="asm-free"/, '自由值按钮要存在');
    assert.match(app, /asmPick\(btn\.dataset\.v, btn\.dataset\.v, true\)/, '点它走同一套锁定逻辑');
    assert.match(app, /asmFreeRowHtml\(\)/, '按钮要随条目刷新');
    assert.match(app, /cfg\.free = free \? String\(label \|\| ''\)\.trim\(\) : ''/, 'pick 与 free 互斥');
    const py = readFileSync(new URL('../backend/app/core/recipes.py', import.meta.url), 'utf8');
    assert.match(py, /slot\.get\("free"\)/, '后端 run_recipe 要认 free');
    const schemas = readFileSync(new URL('../backend/app/schemas.py', import.meta.url), 'utf8');
    assert.match(schemas, /free: str = ""/, 'Slot schema 要放行 free 字段（否则 Pydantic 静默丢弃）');
    const css = readFileSync(new URL('../frontend/styles.css', import.meta.url), 'utf8');
    assert.match(css, /\.part\.is-free\.m-locked/, '手填值的格子要有视觉区分');
  }],
  ['画师接线：场景面板与卡池搜索都真接上了', () => {
    const app = frontendSrc();
    assert.match(app, /part\('artist', '画师'/, '场景面板要画出画师格');
    // 卡池页已换成 Vue：搜索从「逐行藏 DOM」变成计算属性过滤，判据跟着改成「用 poolSearchText 参与匹配」
    assert.match(app, /matchQuery\(poolSearchText\(p\)[^)]*\),/, '卡池页搜索要带别名');
    assert.match(app, /filteredPools/, '命中结果要由计算属性产出，不再逐行改样式');
    const css = readFileSync(new URL('../frontend/styles.css', import.meta.url), 'utf8');
    assert.match(css, /grid-template-areas: "bg style" "stage stage" "artist comp"/,
      '画师格与构图并排，不挤掉画布');
  }],
  ['画师图鉴缩略图：条目带样图地址，浮层挂在 body 上不被列表裁掉', () => {
    const app = frontendSrc();
    const css = readFileSync(new URL('../frontend/styles.css', import.meta.url), 'utf8');
    assert.match(app, /data-thumb-url="\$\{esc\(thumb\)\}"/, '画师条目要带上样图地址');
    assert.match(app, /function showThumbPop/, '要有悬停浮层');
    assert.match(app, /thumbPop\.className = 'thumb-pop'/, '浮层节点由前端建');
    assert.match(app, /document\.body\.appendChild\(thumbPop\)/,
      '浮层挂到 body：列表是 overflow:auto，挂在行内会被裁掉');
    assert.match(app, /addEventListener\('scroll', hideThumbPop, true\)/,
      '滚动时收起浮层（fixed 定位会与行错位）');
    assert.match(css, /\.thumb-pop\s*\{[^}]*position:\s*fixed/, '浮层必须 fixed 定位');
    assert.match(css, /\.asm-entry-eye/, '有样图的行要有「图」标，否则用户不知道能悬停');
    // 后端配对：只有真配得上样图的画师才给地址，前端不会去打必然 404 的图
    const svc = readFileSync(new URL('../backend/app/services/pools.py', import.meta.url), 'utf8');
    assert.match(svc, /def _attach_artist_thumbs/);
    assert.match(svc, /\/api\/semantics\/artist-thumb\?name=/);
    const api = readFileSync(new URL('../backend/app/api/semantics.py', import.meta.url), 'utf8');
    assert.match(api, /@router\.get\("\/artist-thumb"\)/);
  }],
  ['data-act 契约：模板产出的每个动作都有人接（防死动作漂移）', () => {
    // 动作已按域搬进各模块的 actions 注册表，键形如 `'draw': async (btn) => {`。
    // 校验对象也从「app.js 的 switch」变成「全前端注册表」，覆盖面反而更全。
    const a = frontendSrc();
    const emitted = new Set([...a.matchAll(/data-act="([a-z0-9-]+)"/g)].map((m) => m[1]));
    const handled = new Set([...a.matchAll(/^  '([a-z0-9-]+)':\s*(?:async\s*)?\(/gm)].map((m) => m[1]));
    // input / select 的 data-act 不走点击委派，由 app.js 的 onInput / onChange / keydown 分支处理。
    const eventLevel = new Set([...a.matchAll(/dataset\.act === '([a-z0-9-]+)'/g)].map((m) => m[1]));
    const orphans = [...emitted].filter((x) => !handled.has(x) && !eventLevel.has(x));
    assert.deepEqual(orphans, [],
      `有模板输出但无人接的动作（点了没反应）: ${orphans.join(', ')}`);
    // 反方向：注册了但没有任何模板输出，也是死代码
    const dead = [...handled].filter((x) => !emitted.has(x));
    assert.deepEqual(dead, [], `已注册但没有任何模板产出的死动作: ${dead.join(', ')}`);
    assert.ok(handled.has('concept-open'), '不可过滤概念卡点的 concept-open 必须有 handler');
  }],
  ['引用契约：模块里调用到的每个函数都有来源（防漏 import）', () => {
    // 拆文件最容易犯的错：调用搬进新模块、import 留在旧文件。node --check 看不出，
    // 只有真点到那个按钮才炸（views/draw.js 曾丢掉 restoreFormState 导致整个 boot 失败）。
    const problems = [];
    for (const f of jsFiles) {
      const miss = unresolvedCalls(readFileSync(f, 'utf8'));
      if (miss.length) {
        problems.push(`${f.split(/[\\/]/).pop()}: ${miss.map((m) => `${m.name}×${m.count}`).join(', ')}`);
      }
    }
    assert.deepEqual(problems, [], `调用了但没有来源的函数：\n  ${problems.join('\n  ')}`);
  }],

  ['输入补全契约：每个文本输入都有候选来源', () => {
    // 口径：作为方便使用的工具，每个 input 都该能补全。静态扫所有 <input>，只放行四类：
    //   data-suggest     通用补全（features/suggest.js），候选取自池/tag/模型/预设/历史目录
    //   class="qf"       快速筛选框，输入即过滤（本身没有"候选"这回事）
    //   data-filter-only 输入即过滤的搜索框（Vue computed），同上
    //   data-free-text   自由描述（"想要的感觉"那种句子），候选只会碍事
    //   data-secret      令牌/密钥，绝不该联想
    // number / hidden / checkbox 一律跳过：数值补全不如直接敲。
    const uncovered = [];
    for (const f of jsFiles) {
      const s = readFileSync(f, 'utf8');
      for (const m of s.matchAll(/<input\b[^>]*>/g)) {
        const tag = m[0];
        const type = (tag.match(/type="(\w+)"/) || [])[1] || 'text';
        if (!['text', 'search', 'url'].includes(type)) continue;
        if (/data-suggest|data-filter-only|data-free-text|data-secret/.test(tag)) continue;
        if (/class="[^"]*\bqf\b/.test(tag)) continue;
        // 装配面板的条目搜索 / 意群自由词走各自老机制（跨池条目搜索、双语词表浮层）
        if (/data-asm-pool-q|data-act="asm-q"|data-act="asm-extra"/.test(tag)) continue;
        uncovered.push(`${f.split(/[\\/]/).pop()}: ${tag.replace(/\s+/g, ' ').slice(0, 92)}`);
      }
    }
    assert.deepEqual(uncovered, [], `这些输入框没有候选来源：\n  ${uncovered.join('\n  ')}`);
  }],

  ['输入补全接线：每个 data-suggest 都指向存在的 provider', () => {
    // 拼错 provider 名不会报错，只会静默不出候选 —— 这类"看起来能用"的坏接线最难查。
    const sugPath = fileURLToPath(new URL('../frontend/features/suggest.js', import.meta.url));
    const sug = readFileSync(sugPath, 'utf8');
    const start = sug.indexOf('const PROVIDERS = {');
    assert.ok(start > 0, 'suggest.js 里找不到 PROVIDERS 表');
    const block = sug.slice(start, sug.indexOf('// 选中后要记住'));
    const defined = new Set([...block.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]));
    const used = new Set([...frontendSrc().matchAll(/data-suggest="(\w+)"/g)].map((m) => m[1]));
    const unknown = [...used].filter((k) => !defined.has(k));
    assert.deepEqual(unknown, [], `data-suggest 指向了不存在的 provider：${unknown.join(', ')}`);
    assert.ok(used.size >= 8, `挂上补全的输入框只有 ${used.size} 类，是不是把属性删了`);
  }],
];

for (const [name, fn] of cases) {
  try {
    fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    console.error(`  [FAIL] ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}
console.log(`\n== 前端 detail 契约: ${passed}/${cases.length} 通过 ==`);
