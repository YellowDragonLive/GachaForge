// 前端唯一可变状态。
//
// 过去 state 在 app.js 顶部 createState() 出来，只有 app.js 一个文件能碰；
// 拆成多个域模块后如果各自 new 一份，抽卡台改的东西任务队列看不见。
// 所以这里只有一个实例，任何模块 `import { state } from '../store.js'`。
//
// 将来换 Vue 时，这个文件就是唯一需要改成 reactive() 的地方。

import { createState } from './state.js';

export const state = createState();
