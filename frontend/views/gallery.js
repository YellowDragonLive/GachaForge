// 画廊视图（Vue）。第二个迁移的视图，比任务页多三件事：
// 1. 三个筛选下拉以前靠 app.js 的 onChange 认 id（gFav/gOrigin/gRating），现在由组件自己 v-model
//    并直接改 state.gallery —— 一个控件只有一套实现，app.js 里那段分支已删掉。
// 2. 评分 / 收藏的动作仍在 app.js（跨视图：概念页、画廊、抽卡台都要改同一张图），
//    所以组件对外暴露 refreshGallery()，那边改完 state.images 喊一声即可。
// 3. 星级是 widgets.js 拼好的 HTML 字符串（内部已转义），只能用 v-html。
import { api } from '../api.js';
import { cut } from '../detail.js';
import { state } from '../store.js';
import { ratingStarsHtml } from '../widgets.js';
import { refresh } from '../core/router.js';
import { $, done } from '../core/ui.js';
import { noteDir } from '../features/suggest.js';
import { defineComponent, mountVue, ref } from '../vue/index.js';

const images = ref([]);
const favorite = ref(state.gallery.favorite);
const origin = ref(state.gallery.origin);
const minRating = ref(String(state.gallery.min_rating));
const dir = ref('');

export async function loadImages() {
  const g = state.gallery;
  const q = new URLSearchParams({ limit: '120' });
  if (g.favorite !== '') q.set('favorite', g.favorite);
  if (g.origin) q.set('origin', g.origin);
  if (g.min_rating) q.set('min_rating', String(g.min_rating));
  state.images = (await api.get('/api/images?' + q.toString())).items;
}

/** app.js 那边改完 state.images（评分 / 收藏 / SSE 出新图）后调用。 */
export const refreshGallery = () => { images.value = state.images.slice(); };

async function applyFilters() {
  // state.gallery 是唯一事实源：筛选值变了先写回去，再按它重新拉列表
  state.gallery = {
    favorite: favorite.value, origin: origin.value, min_rating: Number(minRating.value),
  };
  await loadImages();
  refreshGallery();
}

const GalleryView = defineComponent({
  name: 'GalleryView',
  setup() {
    return { images, favorite, origin, minRating, dir, applyFilters, cut,
      stars: (im) => ratingStarsHtml(im.id, im.rating) };
  },
  template: `
    <div>
      <div class="panel">
        <div class="panel-head"><h2>画廊</h2>
          <span class="sub">{{ images.length }} 张 · 生成图与画师图鉴已合并</span></div>
        <div class="row" style="margin-bottom:12px">
          <select v-model="favorite" @change="applyFilters" style="max-width:150px">
            <option value="">全部</option><option value="true">仅收藏</option><option value="false">未收藏</option>
          </select>
          <select v-model="origin" @change="applyFilters" style="max-width:160px">
            <option value="">全部来源</option><option value="generated">生成图</option><option value="gallery">图鉴注册</option>
          </select>
          <select v-model="minRating" @change="applyFilters" style="max-width:140px">
            <option value="0">不限评分</option><option value="3">3 分以上</option><option value="4">4 分以上</option>
          </select>
          <button class="btn small" data-act="gallery-export">导出元数据</button>
        </div>
        <div class="gallery">
          <div v-if="!images.length" class="loading">还没有图片。生成任务完成后会出现在这里；也可在下方注册历史图鉴目录。</div>
          <div v-for="im in images" :key="im.id" class="tile">
            <img :src="'/api/images/' + im.id + '/thumb'" :alt="'图片 ' + im.id"
              data-act="img-open" :data-id="im.id">
            <div class="meta">#{{ im.id }} · {{ im.origin }} · {{ im.width }}×{{ im.height }}<br>
              {{ cut(im.meta?.prompt || im.meta?.name || '', 46) }}</div>
            <div class="ops">
              <button class="btn small" data-act="img-fav" :data-id="im.id"
                :data-v="im.favorite ? 0 : 1">{{ im.favorite ? '★ 已收藏' : '☆ 收藏' }}</button>
              <span v-html="stars(im)"></span>
              <button v-if="im.meta?.draw_id" class="btn small"
                data-act="img-rerun" :data-id="im.id">同参重跑</button>
            </div>
          </div>
        </div>
      </div>
      <div class="panel"><div class="panel-head"><h2>并入历史画师图鉴</h2></div>
        <div class="row"><input type="text" v-model="dir" id="galleryDir" data-suggest="dir"
            placeholder="项目内图片目录，如 artist_style_test_20260526" style="max-width:440px">
          <button class="btn" data-act="gallery-scan">扫描并注册</button></div>
        <p class="hint">只读扫描，不移动原图；注册后缩略图会显示在上方画廊。历史目录不存在时请先确认路径。</p>
      </div>
    </div>`,
});

export async function renderGallery() {
  // 每次进页面都按 state.gallery 重新对齐一次筛选控件，避免上次的临时改动残留
  favorite.value = state.gallery.favorite;
  origin.value = state.gallery.origin;
  minRating.value = String(state.gallery.min_rating);
  await loadImages();
  refreshGallery();
  mountVue(GalleryView);
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

// ---- 动作注册表：data-act → 处理器（app.js 事件委派调用）----
export const actions = {
  'img-open': async (btn) => {
    openLightbox(Number(btn.dataset.id));
  },
  'img-rerun': async (btn) => {
    const id = Number(btn.dataset.id);
    const im = state.images.find((x) => x.id === id);
    await api.post('/api/jobs', { draw_ids: [im.meta.draw_id], force: true });
    done('已用同一抽卡结果重新提交任务'); location.hash = '#jobs';
  },
  'gallery-scan': async () => {
    // 输入框有 id，读 DOM 值即可；组件里 v-model 只是为了让重绘不吞掉已输入的文字
    const path = $('#galleryDir').value.trim();
    if (!path) throw new Error('请填写图片目录');
    const r = await api.post('/api/images/register-dir', { path });
    noteDir(path);
    done(`注册完成：新增 ${r.added} 张`); await refresh('gallery');
  },
  'gallery-export': async () => {
    const ids = state.images.map((x) => x.id).join(',');
    const data = await api.get('/api/images/export?ids=' + encodeURIComponent(ids));
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'gacha_gallery_meta.json'; a.click();
    URL.revokeObjectURL(a.href); done('元数据已导出');
  },
};
