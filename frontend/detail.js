// 纯展示函数：不依赖 DOM / 框架，浏览器与 Node 均可直接 import。
// 抽卡 detail 历史上有两种形状，这里统一兼容，避免脏数据让整个页面渲染失败。

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const cut = (s, n = 120) => {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n) + '…' : t;
};

/** 把抽卡明细渲染成 chip HTML。
 *  配方模式：{slot, tags: string[]}；旧全池随机：{pool, friendly, label, tags: string}。
 *  其余形状（null / 非数组 / 数字 / skipped）一律安全退化，不抛异常。
 */
export function slotChips(detail, limit = 20) {
  if (!Array.isArray(detail)) return '';
  const chips = detail.map((x) => {
    if (!x || typeof x !== 'object' || x.skipped) return '';
    const name = x.slot || x.friendly || x.pool || '条目';
    if (x.empty) {
      return `<span class="chip warn" title="${esc(x.reason || '无匹配条目')}">` +
        `${esc(name)}: ⚠ 无匹配条目</span>`;
    }
    const raw = x.tags;
    const text = Array.isArray(raw)
      ? raw.map((v) => String(v ?? '')).filter(Boolean).join(' / ')
      : (raw == null ? '' : String(raw));
    if (!text.trim()) return '';
    const label = x.label && x.label !== text ? `${x.label} → ` : '';
    // 锁定的格子要能一眼认出：装配面板里锁了什么，这里就标什么，方便和图逐项对照。
    const lock = x.locked
      ? `<i class="chip-lock" title="本次锁定：${esc(x.locked)}">锁</i>` : '';
    // 条目原文里手写的 `:1.2` 在出图前就被剥掉了，chip 上只显示干净的那份。
    // 保留一句 hover 说明，用户对照卡池原文时才不会以为「抽错了/少字了」。
    const note = x.stripped_weight ? '｜原文带手写权重（:1.2 之类的超重标记），出图前已剥' : '';
    return `<span class="chip${x.locked ? ' locked' : ''}" title="${esc(cut(text, 300))}${note}">` +
      `${lock}${esc(name)}: ${esc(cut(label + text, 72))}</span>`;
  }).filter(Boolean);
  // 全池随机一次可抽到数百个池，全部铺开会拖垮页面；完整结果已在 prompt 文本框里。
  if (chips.length > limit) {
    const rest = chips.length - limit;
    chips.length = limit;
    chips.push(`<span class="chip">…另有 ${rest} 个槽位，完整内容见上方 prompt</span>`);
  }
  return chips.join('');
}
