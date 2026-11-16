// 快速筛选：一个 input 让长列表就地变短。
// 一个处理器服务所有落点：select 隐藏不匹配的 option；普通容器隐藏不匹配的子项。
// 输入即过滤，Enter 直接选中第一个匹配项，Esc 清空 —— 「筛 → 选 → 重来」三种键盘动作，
// 鼠标用户照旧点。落点见设置页（LoRA / checkpoint）、调参抽屉、抽卡装配、配方模板池。

import { $ } from '../core/ui.js';
import { queryWords, matchQuery } from '../widgets.js';

// ---------------- 快速筛选：一个 input 让长列表就地变短 ----------------
// 一个处理器服务所有落点：select 隐藏不匹配的 option；普通容器隐藏不匹配的子项。
// 输入即过滤，Enter 直接选中第一个匹配项，Esc 清空 —— 「筛 → 选 → 重来」三种键盘动作，
// 鼠标用户照旧点。落点见设置页（LoRA / checkpoint）、调参抽屉、抽卡装配、配方模板池。
export function applyQuickFilter(el, q) {
  if (!el) return 0;
  const words = queryWords(q);
  let shown = 0;
  if (el.tagName === 'SELECT') {
    for (const o of el.options) {
      const hit = !words.length || matchQuery(`${o.textContent} ${o.value}`, q);
      // 当前值永远留着：隐藏它会让用户以为预设是空的，保存时还以为丢了
      o.hidden = !(hit || (o.value && o.value === el.value));
      if (hit) shown += 1;
    }
    el.querySelectorAll('optgroup').forEach((g) => {
      g.hidden = ![...g.children].some((o) => !o.hidden);
    });
    // 还没选过东西时自动落在第一个命中项：筛「neg」下拉直接停在 neg4all…，
    // 不用再点开确认。已有选择的场合不抢（Enter 才是明确的「就选这个」）。
    if (!el.value) {
      const hit = [...el.options].find((o) => !o.hidden && o.value);
      if (hit) el.value = hit.value;
    }
  } else {
    for (const k of el.querySelectorAll('[data-qtext]')) {
      const hit = !words.length || matchQuery(k.dataset.qtext || k.textContent, q);
      k.hidden = !hit;
      if (hit) shown += 1;
    }
  }
  return shown;
}

/** 筛选框右侧的小计数：「12 项」，清空后消失，不占常驻空间。 */
export function setQfCount(targetId, n, q) {
  const box = document.querySelector(`[data-qf-count="${targetId}"]`);
  if (box) box.textContent = String(q || '').trim() ? `${n} 项` : '';
}

export function onQuickFilterInput(t) {
  const el = document.getElementById(t.dataset.qf);
  setQfCount(t.dataset.qf, applyQuickFilter(el, t.value), t.value);
}

export function onQuickFilterKey(t, e) {
  const el = document.getElementById(t.dataset.qf);
  if (e.key === 'Escape') {
    t.value = '';
    setQfCount(t.dataset.qf, applyQuickFilter(el, ''), '');
    return;
  }
  if (e.key !== 'Enter' || !el || el.tagName !== 'SELECT') return;
  // 回车即选定第一个匹配项：`neg` + Enter 就落定，不用再点开下拉找
  const hit = [...el.options].find((o) => !o.hidden && o.value);
  if (!hit) return;
  e.preventDefault();
  if (el.value !== hit.value) {
    el.value = hit.value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
}
