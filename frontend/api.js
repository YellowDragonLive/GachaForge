// 统一 API 客户端：错误映射、5xx 自动重试（最多 3 次）、断网提示、SSE。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rid = () => Math.random().toString(36).slice(2, 12);

const MESSAGES = {
  comfy_unavailable: 'ComfyUI 未运行，无法提交生图；可以先抽卡，或启动 ComfyUI / 开启 mock 模式',
  invalid_job_state: '任务状态不允许此操作',
  conflict: '数据冲突，请刷新后重试',
  not_found: '请求的对象不存在',
  bad_request: '请求参数不合法',
  unauthorized: '令牌无效',
};

async function request(path, { method = 'GET', body, retry = 0 } = {}) {
  let res, payload;
  try {
    res = await fetch(path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Request-Id': rid(),
        ...(localStorage.getItem('gacha_token')
          ? { 'X-Gacha-Token': localStorage.getItem('gacha_token') } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    payload = await res.json().catch(() => ({}));
  } catch (e) {
    const err = new Error('无法连接服务，请确认 start.bat 仍在运行');
    err.offline = true;
    throw err;
  }
  if (!res.ok || payload.ok === false) {
    const info = payload.error || {};
    const err = new Error(info.message || MESSAGES[info.code] || `请求失败 (${res.status})`);
    err.status = res.status;
    err.code = info.code;
    err.retryable = res.status >= 500;
    err.details = info.details;
    throw err;
  }
  return payload.data;
}

async function withRetry(path, opts) {
  for (let i = 0; i < 4; i++) {
    try {
      return await request(path, opts);
    } catch (err) {
      if (err.retryable && i < 3) { await sleep(350 * (i + 1)); continue; }
      throw err;
    }
  }
}

export const api = {
  get: (p) => withRetry(p),
  post: (p, body) => withRetry(p, { method: 'POST', body }),
  put: (p, body) => withRetry(p, { method: 'PUT', body }),
  patch: (p, body) => withRetry(p, { method: 'PATCH', body }),
  del: (p) => withRetry(p, { method: 'DELETE' }),
};

export function jobStream(onEvent, onStatus) {
  const es = new EventSource('/api/jobs/stream');
  es.onopen = () => onStatus && onStatus(true);
  es.onerror = () => onStatus && onStatus(false);
  es.onmessage = (e) => {
    if (!e.data) return;
    try { onEvent(JSON.parse(e.data)); } catch (_) { /* ignore */ }
  };
  return es;
}

export function friendlyError(err) {
  return err?.message || '未知错误';
}
