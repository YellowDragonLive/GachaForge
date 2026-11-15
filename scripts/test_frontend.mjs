// 前端纯函数契约测试：固定入口 `node scripts/test_frontend.mjs`。
// 不依赖 DOM / 浏览器 / 构建链；用 data URL 加载 .js，避免给项目引入 package.json。
// 覆盖抽卡 detail 的两种历史形状与各种脏数据，防止 "x.tags.join is not a function" 回归。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../frontend/detail.js', import.meta.url), 'utf8');
const { slotChips, esc, cut } = await import(
  'data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

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
  ['抽卡台接线：状态持久化 + 不再直接 join', () => {
    const app = readFileSync(new URL('../frontend/app.js', import.meta.url), 'utf8');
    for (const needle of [
      "import { esc, cut, slotChips } from './detail.js'",
      'slotChips(d.detail)',
      'state.form =',
      "view.addEventListener('input', onInput)",
      'sessionStorage.setItem(LAST_SESSION_KEY',
      'await restoreLastDraw()',
    ]) {
      assert.ok(app.includes(needle), `app.js 缺少接线：${needle}`);
    }
    assert.doesNotMatch(app, /\.tags\.join\(/, '不得再对 tags 直接调用 join');
    assert.doesNotMatch(app, /id="dPulls" value="3"/, '表单值不得写死为默认值');
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
