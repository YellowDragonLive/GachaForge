// 视图注册表 + 路由。
//
// 为什么不是各模块直接 import 彼此的 render：装配面板改完要刷新抽卡台，
// 抽卡台又要 import 装配面板来拼 HTML——直接互相 import 就是循环依赖。
// 这里用注册表把「谁渲染什么」放到运行时绑定：域模块只管 registerView，
// 需要刷新别人时调 refresh('draw')，模块之间零耦合。
//
// 这一层将来直接换成 vue-router，各视图函数换成组件。

import { friendlyError } from '../api.js';
import { esc } from '../detail.js';
import { state } from '../store.js';
import { $, view, fail } from './ui.js';
import { unmountVue } from '../vue/host.js';

export const VIEWS = ['draw', 'pools', 'recipes', 'jobs', 'gallery', 'settings'];

const renderers = new Map();

/** 注册一个视图渲染函数。同名覆盖，便于反复注册。 */
export function registerView(name, render) {
  renderers.set(name, render);
}

/** 渲染某个视图；未注册则什么都不做（而不是抛错把整页打挂）。 */
export async function refresh(name, ...args) {
  const render = renderers.get(name);
  if (!render) return;
  // 切换视图前先卸载上一屏的 Vue 实例：老视图靠 `view.innerHTML = ...` 接管 #view，
  // 不清掉的话 Vue 会继续对着已被替换的节点打补丁。这里也是唯一的路口，视图不用各自处理。
  unmountVue();
  return render(...args);
}

export function setNav(v) {
  state.view = v;
  $$nav().forEach((b) => b.classList.toggle('active', b.dataset.view === v));
}

const $$nav = () => document.querySelectorAll('#nav button');

/** 顶栏状态灯：离线 / mock / 在线。 */
export function updateStatus() {
  const dot = $('#comfyDot'), text = $('#comfyText');
  if (!dot || !text) return;
  if (!state.comfy.online) {
    dot.className = 'dot off'; text.textContent = 'ComfyUI 离线';
  } else if (state.comfy.mock) {
    dot.className = 'dot mock'; text.textContent = 'mock 模式（占位图）';
  } else {
    dot.className = 'dot on'; text.textContent = 'ComfyUI 在线';
  }
}

/** 解析 hash 并渲染对应视图。概念详情页是 draw 下的子页面。 */
export async function onRoute() {
  const raw = (location.hash.slice(1) || 'draw').replace(/^\//, '');
  if (raw.startsWith('concept/')) {
    setNav('draw');
    state.view = 'concept';
    try {
      await refresh('concept', decodeURIComponent(raw.slice(8)));
    } catch (err) {
      fail(err);
      view.innerHTML = `<div class="panel err-text">概念页加载失败：${esc(friendlyError(err))}
        <button class="btn small" data-act="concept-back">返回抽卡台</button></div>`;
    }
    return;
  }
  const v = VIEWS.includes(raw) ? raw : 'draw';
  setNav(v);
  state.view = v;
  try {
    await refresh(v);
  } catch (err) {
    // 不整页替换：保留已有内容，只在顶部插入错误条，避免一条脏数据把界面清空
    fail(err);
    const bar = `<div class="panel err-text">页面加载失败：${esc(friendlyError(err))}
      <button class="btn small" data-act="view-retry">重试</button></div>`;
    view.innerHTML = view.innerHTML.trim() ? bar + view.innerHTML : bar;
  }
}
