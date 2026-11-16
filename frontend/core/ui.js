// 跨域共用的 DOM / 提示小工具。
//
// 只放「每个域都要用、且与业务无关」的东西：查询元素、数字兜底、toast。
// 业务函数一律不往这里塞，否则又会变成第二个 app.js。

import { friendlyError } from '../api.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** 视图容器。模块加载时已解析完 DOM（type=module 是 defer 的）。 */
export const view = document.querySelector('#view');

/** 空串 / null / undefined 回落到默认值，避免 Number('') 变 0。 */
export const num = (v, d) => (v === '' || v === undefined || v === null ? d : Number(v));

let toastTimer = null;

export function toast(msg, kind = '') {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'toast ' + kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3600);
}

export const fail = (e) => toast(friendlyError(e), 'err');
export const done = (msg) => toast(msg, 'ok');
