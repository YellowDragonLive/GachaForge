// 前端纯函数契约测试：固定入口 `node scripts/test_frontend.mjs`。
// 不依赖 DOM / 浏览器 / 构建链；用 data URL 加载 .js，避免给项目引入 package.json。
// 覆盖抽卡 detail 的两种历史形状与各种脏数据，防止 "x.tags.join is not a function" 回归。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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
    const app = readFileSync(new URL('../frontend/app.js', import.meta.url), 'utf8');
    for (const needle of [
      "import { esc, cut, slotChips } from './detail.js'",
      'slotChips(d.detail)',
      'state.form =',
      "view.addEventListener('input', onInput)",
      'sessionStorage.setItem(LAST_SESSION_KEY',
      'await restoreLastDraw()',
      'state.warnings = data.warnings || []',
      'sessionStorage.setItem(FORM_KEY',
      'restoreForm()',
      'function filterHintText()',
      'function updateFilterHint()',
    ]) {
      assert.ok(app.includes(needle), `app.js 缺少接线：${needle}`);
    }
    assert.doesNotMatch(app, /\.tags\.join\(/, '不得再对 tags 直接调用 join');
    assert.doesNotMatch(app, /id="dPulls" value="3"/, '表单值不得写死为默认值');
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
    const html = W.loraRowsHtml([{ name: 'a.safetensors', weight: 0.8 }]);
    assert.match(html, /data-lora-w="0"/);
    assert.match(html, /data-act="lora-del"/);
    assert.match(html, /lora-up[^>]*disabled/);
    assert.match(W.loraOptionsHtml(['a', 'b'], [{ name: 'a' }]), /value="a" disabled/);
  }],
  ['槽位表：可视化行、单一 datalist 引用、数值范围', () => {
    assert.deepEqual(W.normalizeSlots('[{"pool":"角色","count":9,"weight":5}]'),
      [{ pool: '角色', count: 9, weight: 1, filter: '' }]);
    const html = W.slotRowsHtml([{ pool: '角色', count: 1, weight: 1, filter: 'fate' }],
      [{ name: 'zh_TW', kind: '角色' }], [{ value: 'asuna' }]);
    assert.match(html, /data-slot="pool"/);
    assert.match(html, /data-slot="filter"/);
    assert.match(html, /list="slotTagList"/);
    assert.doesNotMatch(html, /<datalist/);   // datalist 由页面输出一份，避免重复 id
    assert.match(html, /value="角色" selected/);
    assert.match(W.slotPoolOptionsHtml([{ name: 'p', kind: '角色' }], '自定义池'),
      /自定义池（自定义）/);
  }],
  ['app.js 接线：过滤构造器 / 槽位表 / LoRA 行', () => {
    const app = readFileSync(new URL('../frontend/app.js', import.meta.url), 'utf8');
    for (const needle of [
      "from './widgets.js'", 'id="dFilterPool"', 'id="dFilterTag"', 'hotTagChipsHtml(',
      'function setFilterSpec(', 'async function loadTagOptions(', 'function refreshSlots()',
      'function refreshLoraRows()', 'slotRowsHtml(', 'loraRowsHtml(', 'normalizeLoras(',
      'state.loraDraft', 'state.slotsDraft', 'await loadTagOptions()',
    ]) {
      assert.ok(app.includes(needle), `app.js 缺少接线：${needle}`);
    }
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
  ['概念卡片：缩略图是主视觉，点选即带过滤池', () => {
    const html = W.conceptCardHtml({ key: 'asuna (sao)', label: 'asuna (sao)',
      kind: '角色', pool: '角色', image_count: 5, draw_count: 9,
      thumbs: [{ id: 3, url: '/api/images/3/thumb' },
        { id: 4, url: '/api/images/4/thumb' }] });
    assert.equal((html.match(/<img /g) || []).length, 2);
    assert.match(html, /data-act="concept-pick"/);
    assert.match(html, /data-pool="角色"/);
    assert.match(html, /data-v="asuna \(sao\)"/);
    assert.match(html, /5 张出图 \/ 9 次抽到/);
    assert.match(html, /按 角色 池/);
    const injected = W.conceptCardHtml({ key: '<img src=x>', label: '"x"', pool: 'a' });
    assert.match(injected, /&lt;img/);
    assert.doesNotMatch(injected, /<img src=x>/);
    const info = W.conceptCardHtml({ key: 'wai', label: 'wai', filterable: false,
      thumbs: [{ id: 7, url: '/api/images/7/thumb' }] });
    assert.match(info, /data-act="img-open"/);
    assert.doesNotMatch(info, /data-act="concept-pick"/);
  }],
  ['概念墙：空态提示 / 跨类别 / 选中高亮', () => {
    assert.match(W.conceptCardsHtml([]), /先抽几次卡/);
    const html = W.conceptCardsHtml([
      { key: 'a', label: 'A', kind: '画师', pool: '画师',
        thumbs: [{ url: '/api/images/1/thumb' }] },
      { key: 'b', label: 'B', kind: '服装', pool: '服装',
        thumbs: [{ url: '/api/images/2/thumb' }] },
    ], { selectedKeys: ['A'] });
    assert.equal((html.match(/class="concept-card/g) || []).length, 2);
    assert.equal((html.match(/concept-card picked/g) || []).length, 1);
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
  ['语义卡片：风格锚点 + 我的出图叠放，命中依据可解释', () => {
    const html = W.semanticCardsHtml([{ name: 'quasarcake', core: true,
      thumb_url: '/api/semantics/thumb?index=430',
      reason: [{ tag: '厚涂' }, { tag: '柔和光影' }],
      history: { image_count: 2, thumbs: [{ url: '/api/images/9/thumb' }] } }]);
    assert.equal((html.match(/<img /g) || []).length, 2);
    assert.match(html, /data-act="semantic-pick"/);
    assert.match(html, /data-v="quasarcake"/);
    assert.match(html, /核心/);
    assert.match(html, /厚涂 \/ 柔和光影/);
    assert.match(html, /风格锚点/);
    assert.match(W.semanticCardsHtml([]), /输入一句想要的感觉/);
    assert.doesNotMatch(
      W.semanticCardsHtml([{ name: 'x', thumb_url: 'javascript:alert(1)' }]), /javascript:/);
  }],
  ['结果卡槽位小图：概念反查 / 去转义 / 去重 / 空白输入', () => {
    const map = { 'asuna (sao)': '/api/images/9/thumb', outdoors: '/api/images/8/thumb' };
    const html = W.conceptStripHtml([
      { slot: '角色', tags: ['1girl, asuna \\(sao\\), outdoors'] },
      { slot: '角色', tags: ['asuna (sao)'] },
      { slot: '背景', tags: ['javascript:alert(1)'] },
    ], map);
    assert.equal((html.match(/<img /g) || []).length, 2);
    assert.match(html, /title="asuna \(sao\)"/);
    assert.match(html, /\/api\/images\/8\/thumb/);
    assert.equal(W.conceptStripHtml([], map), '');
    assert.equal(W.conceptStripHtml(null, null), '');
  }],
  ['app.js 接线：通用概念面板 / 语义面板 / 结果小图', () => {
    const app = readFileSync(new URL('../frontend/app.js', import.meta.url), 'utf8');
    for (const needle of [
      'conceptCardsHtml(', 'conceptKindChipsHtml(', 'semanticCardsHtml(',
      'conceptStripHtml(', 'function conceptPanel()', 'function loadConcepts(',
      'function loadSemantics(', 'function syncConceptPanel()',
      "case 'concept-pick'", "case 'semantic-pick'", "case 'concept-kind'",
      '/api/concepts/wall', '/api/semantics/suggest', 'loadSemanticsStatus()',
      'id="conceptWall"', 'id="semanticCards"',
    ]) {
      assert.ok(app.includes(needle), `app.js 缺少接线：${needle}`);
    }
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
