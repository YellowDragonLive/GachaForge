// 视图层唯一允许出现 Vue 的地方。
//
// 具体版本 / 文件路径 / 导出名都收口在这个文件：将来换 Vue 版本、或者整站迁完
// 换成带 SFC 的构建版，只改这里，各视图的 import 不用动。
// 现在用的是官方 ESM 全量版（runtime + compiler），所以组件可以写 template 字符串，
// 不需要 .vue 文件，也不需要 Vite。
export {
  createApp, defineComponent, ref, reactive, computed, watch,
  onMounted, onBeforeUnmount, onUnmounted, nextTick, h, toRef, toRaw,
} from '../vendor/vue.esm-browser.prod.js';

export { mountVue, unmountVue, isVueMounted } from './host.js';
