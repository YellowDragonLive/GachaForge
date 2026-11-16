// 画廊视图：图片墙、筛选、灯箱、导出。

import { api } from '../api.js';
import { cut, esc } from '../detail.js';
import { ratingStarsHtml } from '../widgets.js';
import { state } from '../store.js';
import { $, view } from '../core/ui.js';

// ---------------- 画廊 ----------------
export async function loadImages() {
  const g = state.gallery;
  const q = new URLSearchParams({ limit: '120' });
  if (g.favorite !== '') q.set('favorite', g.favorite);
  if (g.origin) q.set('origin', g.origin);
  if (g.min_rating) q.set('min_rating', String(g.min_rating));
  state.images = (await api.get('/api/images?' + q.toString())).items;
}

export function galleryTiles() {
  if (!state.images.length) return '<div class="loading">还没有图片。生成任务完成后会出现在这里；也可在下方注册历史图鉴目录。</div>';
  return state.images.map((im) => `<div class="tile">
    <img src="/api/images/${im.id}/thumb" alt="图片 ${im.id}" data-act="img-open" data-id="${im.id}">
    <div class="meta">#${im.id} · ${esc(im.origin)} · ${im.width}×${im.height}<br>
      ${esc(cut(im.meta?.prompt || im.meta?.name || '', 46))}</div>
    <div class="ops">
      <button class="btn small" data-act="img-fav" data-id="${im.id}" data-v="${im.favorite ? 0 : 1}">${im.favorite ? '★ 已收藏' : '☆ 收藏'}</button>
      ${ratingStarsHtml(im.id, im.rating)}
      ${im.meta?.draw_id ? `<button class="btn small" data-act="img-rerun" data-id="${im.id}">同参重跑</button>` : ''}
    </div></div>`).join('');
}

export async function renderGallery() {
  await loadImages();
  view.innerHTML = `<div class="panel"><div class="panel-head"><h2>画廊</h2>
    <span class="sub">${state.images.length} 张 · 生成图与画师图鉴已合并</span></div>
    <div class="row" style="margin-bottom:12px">
      <select id="gFav" style="max-width:150px">
        <option value="">全部</option><option value="true">仅收藏</option><option value="false">未收藏</option></select>
      <select id="gOrigin" style="max-width:160px">
        <option value="">全部来源</option><option value="generated">生成图</option><option value="gallery">图鉴注册</option></select>
      <select id="gRating" style="max-width:140px">
        <option value="0">不限评分</option><option value="3">3 分以上</option><option value="4">4 分以上</option></select>
      <button class="btn small" data-act="gallery-export">导出元数据</button>
    </div>
    <div class="gallery" id="galleryGrid">${galleryTiles()}</div></div>
  <div class="panel"><div class="panel-head"><h2>并入历史画师图鉴</h2></div>
    <div class="row"><input type="text" id="galleryDir" placeholder="项目内图片目录，如 artist_style_test_20260526" style="max-width:440px">
      <button class="btn" data-act="gallery-scan">扫描并注册</button></div>
    <p class="hint">只读扫描，不移动原图；注册后缩略图会显示在上方画廊。历史目录不存在时请先确认路径。</p></div>`;
  $('#gFav').value = state.gallery.favorite;
  $('#gOrigin').value = state.gallery.origin;
  $('#gRating').value = String(state.gallery.min_rating);
}

export function openLightbox(id) {
  // 抽卡台的图不在 state.images 里，先从结果卡缓存找一遍，找不到也照样打开原图
  const im = state.images.find((x) => x.id === id)
    || Object.values(state.drawImages).flat().find((x) => x.id === id);
  $('#lightboxImg').src = `/api/images/${id}/file`;
  const parts = [`#${id}`];
  if (im?.width) parts.push(`${im.width}×${im.height}`);
  const desc = im?.meta?.prompt || im?.meta?.name || '';
  if (desc) parts.push(desc);
  if (im?.meta?.seed !== undefined && im?.meta?.seed !== null) parts.push(`seed ${im.meta.seed}`);
  $('#lightboxInfo').textContent = parts.join(' · ');
  $('#lightbox').hidden = false;
}

