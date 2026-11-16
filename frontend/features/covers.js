// 按需悬浮封面 / 画师样图浮层 / 状态栏立绘。
// 三件事的共同原则：图按需请求、按 key 缓存、列表里一张都不铺——
// 抽象概念先给文字，鼠标悬停才浮出一张代表图。

import { api } from '../api.js';
import { esc } from '../detail.js';
import { state } from '../store.js';
import { view } from '../core/ui.js';
import { coverPopoverHtml } from '../widgets.js';

// ---------------- 按需悬浮封面：一次只显示一张，按 key 缓存 ----------------
export function hideCover(el) {
  const pop = el && el.querySelector ? el.querySelector('.cover-pop') : null;
  if (pop) pop.remove();
}

export function paintCover(el, cover) {
  // coverActive 由进入时置位、离开时清除；异步请求返回时若已离开就不插入孤儿浮层
  if (!el || !el.isConnected || el.dataset.coverActive !== '1') return;
  hideCover(el);
  el.insertAdjacentHTML('beforeend', coverPopoverHtml(cover));
}

export async function showCover(el) {
  if (!el || el.querySelector('.cover-pop')) return;
  const key = String(el.dataset.coverKey || '');
  if (!key) return;
  el.dataset.coverActive = '1';
  // 语义卡的外部风格锚点已随卡片给出，无需再打后端
  const direct = el.dataset.coverUrl;
  if (direct) {
    paintCover(el, {
      key, found: true, image_count: Number(el.dataset.coverCount || 0),
      image: { url: direct.startsWith('/api/') ? direct : '' },
    });
    return;
  }
  const cache = state.covers.cache;
  if (cache[key]) { paintCover(el, cache[key]); return; }
  if (state.covers.pending[key]) return;
  state.covers.pending[key] = true;
  try {
    const d = await api.get('/api/concepts/cover?' + new URLSearchParams({ key }));
    cache[key] = d;
    paintCover(el, d);
  } catch (_) {
    paintCover(el, { key, found: false });
  } finally {
    delete state.covers.pending[key];
  }
}

export function onCoverOver(e) {
  const el = e.target.closest ? e.target.closest('[data-cover-key]') : null;
  if (!el || (e.relatedTarget && el.contains(e.relatedTarget))) return;
  showCover(el);
}

export function onCoverOut(e) {
  const el = e.target.closest ? e.target.closest('[data-cover-key]') : null;
  if (!el || (e.relatedTarget && el.contains(e.relatedTarget))) return;
  delete el.dataset.coverActive;
  hideCover(el);
}

// ---------------- 画师样图浮层：名字判断不了画风，得看图 ----------------
// 条目列表在 `overflow:auto` 的小盒子里，浮层挂在行内会被裁掉，挂在 .draw-side
// （同样 overflow:auto）也会被裁。所以浮层单独挂在 body 上，用 position:fixed
// 按行的位置定位——滚列表时直接收起来，不做跟随（跟随要每帧算位置，不值）。
const THUMB_POP_W = 198;
const THUMB_POP_H = 224;
let thumbPop = null;

export function thumbPopEl() {
  if (thumbPop && thumbPop.isConnected) return thumbPop;
  thumbPop = document.createElement('div');
  thumbPop.className = 'thumb-pop';
  thumbPop.hidden = true;
  document.body.appendChild(thumbPop);
  return thumbPop;
}

export function showThumbPop(el) {
  const url = String(el.dataset.thumbUrl || '');
  if (!url) return;
  const pop = thumbPopEl();
  if (pop.dataset.url !== url) {
    pop.dataset.url = url;
    pop.innerHTML = `<img src="${esc(url)}" alt="${esc(el.dataset.thumbName || '画师')} 的风格样图">`;
  }
  pop.hidden = false;
  const r = el.getBoundingClientRect();
  // 优先放右栏外侧；右边没地方就翻到左边，再夹进视口，别跑出屏幕。
  let left = r.right + 10;
  if (left + THUMB_POP_W > window.innerWidth - 8) left = r.left - THUMB_POP_W - 10;
  left = Math.max(8, Math.min(left, window.innerWidth - THUMB_POP_W - 8));
  const top = Math.max(8, Math.min(r.top - 12, window.innerHeight - THUMB_POP_H - 8));
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;
}

export function hideThumbPop() {
  if (!thumbPop) return;
  thumbPop.hidden = true;
  thumbPop.dataset.url = '';
}

export function onThumbOver(e) {
  const el = e.target.closest ? e.target.closest('[data-thumb-url]') : null;
  if (el) showThumbPop(el);
}

export function onThumbOut(e) {
  const el = e.target.closest ? e.target.closest('[data-thumb-url]') : null;
  if (!el || (e.relatedTarget && el.contains(e.relatedTarget))) return;
  hideThumbPop();
}

// ---------------- 状态栏立绘：常驻一张，按概念 key 缓存 ----------------
// 和 hover 浮层不同：立绘是状态栏的一部分，必须一直在，才能和右栏出的图并排比对。
export async function loadPortrait(el) {
  if (!el || el.dataset.loaded === '1') return;
  const keys = String(el.dataset.portrait || '').split(',').filter(Boolean);
  el.dataset.loaded = '1';
  if (!keys.length) return;
  for (const key of keys) {
    if (!(key in state.portraits)) {
      try {
        state.portraits[key] = await api.get('/api/concepts/cover?'
          + new URLSearchParams({ key }));
      } catch (_) {
        state.portraits[key] = { key, found: false, image: null };
      }
    }
    const c = state.portraits[key];
    if (c && c.found && c.image && c.image.url) {
      paintPortrait(el, c);
      return;
    }
  }
  el.dataset.miss = '1';   // 这个角色还没出过图：留着占位，等第一次生成后长立绘
}

export function paintPortrait(el, cover) {
  if (!el || !el.isConnected) return;
  el.classList.add('has-img');
  if (el.parentElement) el.parentElement.classList.add('has-art');
  // 立绘铺在小人底下当底图：虚线轮廓叠在照片上，还是能一眼看出哪块是什么。
  el.innerHTML = `<img src="${esc(cover.image.url)}" alt="${esc(el.dataset.title || '角色立绘')}"
      loading="lazy"><span class="doll-cap">立绘</span>`;
}

export async function loadPortraits(root = view) {
  const els = [...root.querySelectorAll('.doll-art[data-portrait]')];
  await Promise.all(els.map((el) => loadPortrait(el).catch(() => {})));
}

/** 出了新图就重置立绘：同一个角色刚生成的图，可能正是它该显示的那张。 */
export function resetPortraits() {
  state.portraits = {};
  document.querySelectorAll('.doll-art[data-portrait]').forEach((el) => {
    delete el.dataset.loaded;
    delete el.dataset.miss;
  });
  loadPortraits().catch(() => {});
}
