// 任务队列视图：SSE 之外的拉取式兜底 + 手动刷新/取消/重试。

import { api } from '../api.js';
import { cut, esc } from '../detail.js';
import { state } from '../store.js';
import { $, view } from '../core/ui.js';
import { refresh } from '../core/router.js';

// ---------------- 任务队列 ----------------
export function jobsBody() {
  if (!state.jobs.length) return '<div class="loading">还没有生成任务</div>';
  return state.jobs.map((j) => `<div class="card" style="margin-bottom:10px">
    <div class="card-head"><b>任务 #${j.id} · 抽卡 #${j.draw_id}</b>
      <span class="state ${esc(j.status)}">${esc(j.status)} ${j.progress || 0}%</span></div>
    <div class="bar"><i style="width:${j.progress || 0}%"></i></div>
    <div class="row" style="margin-top:9px">
      <span class="hint">步数 ${j.step || 0}/${j.steps_total || 0} · 重试 ${j.retry_count || 0} · ${esc(j.created_at || '')}</span>
      ${['queued', 'submitted', 'running', 'cancelling'].includes(j.status)
        ? `<button class="btn small danger" data-act="job-cancel" data-id="${j.id}">取消</button>` : ''}
      ${['failed', 'dead', 'cancelled', 'succeeded'].includes(j.status)
        ? `<button class="btn small" data-act="job-retry" data-id="${j.id}">重新生成</button>` : ''}
    </div>
    ${j.error_message ? `<div class="err-text">${esc(cut(j.error_message, 260))}</div>` : ''}
  </div>`).join('');
}

export async function renderJobs() {
  state.jobs = await api.get('/api/jobs');
  view.innerHTML = `<div class="panel"><div class="panel-head"><h2>生成任务</h2>
    <div class="row"><span class="sub" id="streamState">SSE 连接中…</span>
      <button class="btn small" data-act="job-refresh">刷新</button>
      <button class="btn small" data-act="goto-gallery">去画廊</button></div></div>
    <div id="jobsBody">${jobsBody()}</div></div>`;
}
export const refreshJobsBody = () => { const el = $('#jobsBody'); if (el) el.innerHTML = jobsBody(); };

