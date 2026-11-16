// 任务队列视图 —— 第一个换成 Vue 的视图，跑通「Vue 与原生视图共存」这套机制。
//
// 迁移约定（后面每个视图照这个来）：
// 1. 对外的导出名不变（renderJobs / refreshJobsBody / actions），所以 app.js、router 都不用改；
//    换框架这件事在视图文件内部消化掉。
// 2. 组件之外留一个模块级 ref 当「数据入口」：SSE 那边喊 refreshJobsBody() 就是给 ref 赋值，
//    不需要知道 Vue 的存在，也不会碰 DOM。
// 3. 按钮继续写 data-act：事件仍然由 app.js 那一层委派给 actions 注册表，
//    组件不绑 @click，同一个动作不会有两套实现。
import { api } from '../api.js';
import { cut } from '../detail.js';
import { state } from '../store.js';
import { refresh } from '../core/router.js';
import { computed, defineComponent, mountVue, ref } from '../vue/index.js';

// 可以取消 / 可以重试的状态：写在模板里会变成两串很长的 includes，收在这里。
const CANCELABLE = ['queued', 'submitted', 'running', 'cancelling'];
const RETRYABLE = ['failed', 'dead', 'cancelled', 'succeeded'];

// 模块级数据源：唯一实例，refreshJobsBody() 直接写它，Vue 自己重绘。
const jobs = ref([]);
const sseOk = ref(null);   // null = 还没收到过连接状态

const JobsView = defineComponent({
  name: 'JobsView',
  setup() {
    const streamText = computed(() => {
      if (sseOk.value === null) return 'SSE 连接中…';
      return sseOk.value ? 'SSE 实时连接' : 'SSE 断开，重连中…';
    });
    return { jobs, streamText, CANCELABLE, RETRYABLE, cut };
  },
  // 文本插值 {{ }} 自带转义，不用再手写 esc()
  template: `
    <div class="panel">
      <div class="panel-head"><h2>生成任务</h2>
        <div class="row">
          <span class="sub" id="streamState">{{ streamText }}</span>
          <button class="btn small" data-act="job-refresh">刷新</button>
          <button class="btn small" data-act="goto-gallery">去画廊</button>
        </div>
      </div>
      <div id="jobsBody">
        <div v-if="!jobs.length" class="loading">还没有生成任务</div>
        <div v-for="j in jobs" :key="j.id" class="card" style="margin-bottom:10px">
          <div class="card-head"><b>任务 #{{ j.id }} · 抽卡 #{{ j.draw_id }}</b>
            <span class="state" :class="j.status">{{ j.status }} {{ j.progress || 0 }}%</span></div>
          <div class="bar"><i :style="{ width: (j.progress || 0) + '%' }"></i></div>
          <div class="row" style="margin-top:9px">
            <span class="hint">步数 {{ j.step || 0 }}/{{ j.steps_total || 0 }} ·
              重试 {{ j.retry_count || 0 }} · {{ j.created_at || '' }}</span>
            <button v-if="CANCELABLE.includes(j.status)" class="btn small danger"
              data-act="job-cancel" :data-id="j.id">取消</button>
            <button v-if="RETRYABLE.includes(j.status)" class="btn small"
              data-act="job-retry" :data-id="j.id">重新生成</button>
          </div>
          <div v-if="j.error_message" class="err-text">{{ cut(j.error_message, 260) }}</div>
        </div>
      </div>
    </div>`,
});

export async function renderJobs() {
  state.jobs = await api.get('/api/jobs');
  refreshJobsBody();
  mountVue(JobsView);
}

/** SSE 每次推事件后调用：把 state 的快照推给 Vue。 */
export const refreshJobsBody = () => { jobs.value = state.jobs.slice(); };

/** SSE 连接状态（app.js 的 startStream 回调里调）。 */
export const setStreamState = (ok) => { sseOk.value = ok; };

// ---- 动作注册表：data-act → 处理器（app.js 事件委派调用）----
export const actions = {
  'job-refresh': async () => {
    await refresh('jobs');
  },
  'job-cancel': async (btn) => {
    const id = Number(btn.dataset.id);
    await api.post(`/api/jobs/${id}/cancel`, {}); await refresh('jobs');
  },
  'job-retry': async (btn) => {
    const id = Number(btn.dataset.id);
    await api.post(`/api/jobs/${id}/retry`, {}); await refresh('jobs');
  },
  'goto-gallery': async () => {
    location.hash = '#gallery';
  },
};
