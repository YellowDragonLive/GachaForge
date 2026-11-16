// Vue 与原生视图共存的宿主。
//
// 为什么不用 Vite：整个项目是「双击 start.bat 就能跑、零 node_modules、零构建」。
// vendor/vue.esm-browser.prod.js 是官方 ESM 全量版（自带模板编译器），
// 浏览器直接 import 就能跑 template 字符串，不需要任何打包步骤。
//
// 共存规则：一次只挂一个 Vue 实例，挂进 #view 里的一个宿主 div。
// 老的视图仍然是 `view.innerHTML = ...`，所以**切换视图前必须先卸载**——
// 否则 Vue 实例还指向已被替换掉的节点，事件和 watcher 会挂在野节点上。
// 卸载点放在 core/router.js 的 refresh() 里（唯一的路口），各视图不用管。
import { createApp, h } from '../vendor/vue.esm-browser.prod.js';
import { view } from '../core/ui.js';

let current = null;

/** 挂载一个 Vue 组件到 #view。重复调用会先卸载上一个。 */
export function mountVue(component, props = null) {
  unmountVue();
  const host = document.createElement('div');
  host.className = 'vue-view';
  view.replaceChildren(host);
  const app = createApp({ render: () => h(component, props) });
  app.mount(host);
  current = { app, host };
  return app;
}

export function unmountVue() {
  if (!current) return;
  try {
    current.app.unmount();
  } catch (_) { /* 已经卸载过，忽略 */ }
  current = null;
}

export const isVueMounted = () => current !== null;
