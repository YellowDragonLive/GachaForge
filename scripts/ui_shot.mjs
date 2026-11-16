// 抽卡台 UI 截图验收：无头 Chrome + CDP，零依赖（Node 22 自带 fetch / WebSocket）。
//
// 为什么要它：`test_frontend.mjs` 只能断言字符串，看不见「小人画歪了 / 格子被裁掉 /
// 悬停高亮没生效」这类问题。改完 UI 必须眼见为实，而每次手工拼 CDP 命令最容易出错。
//
// 用法（服务需先起来）：
//   node scripts/ui_shot.mjs                          # 抽卡台首屏：整页 + 左栏
//   node scripts/ui_shot.mjs --steps s.json --out X   # 按步骤点选并逐屏截图
//
// 步骤文件是一个数组，按顺序执行：
//   [{ "name": "c-locked", "js": "document.querySelector('.part[data-key=hair]').click()",
//      "wait": 1200, "sel": ".draw-side" }]
//   sel 省略 = 整页；name 省略 = step1/step2…
//
// 两个必须知道的坑（踩过）：
//   1. 页面只在 reload({ignoreCache:true}) 后才拿到新 CSS，否则拍的是旧样式，
//      会误判「:has() 没生效」；所以本脚本每次都强制 reload。
//   2. 装配状态存在 sessionStorage，不清就会带着上一轮的卡片，所以默认先 clear。
//   用 --keep-state 关掉这两步（想看「刷新后状态是否恢复」时有用）。

import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, dflt = '') => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const flag = (name) => argv.includes('--' + name);

const URL_ = arg('url', 'http://127.0.0.1:8765/');
const OUT = resolve(arg('out', 'temp/ui-shots'));
const WIDTH = Number(arg('width', 1440));
const HEIGHT = Number(arg('height', 1200));
const SCALE = Number(arg('scale', 2));
const PORT = Number(arg('port', 9222));
const KEEP = flag('keep-state');
const STEPS_FILE = arg('steps', '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(OUT, { recursive: true });

function chromePath() {
  const cands = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium',
  ];
  return cands.find((p) => existsSync(p)) || '';
}

async function cdpList() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    return await r.json();
  } catch (_) { return null; }
}

/** 没有现成的调试端口就自己起一个无头浏览器，脚本结束时收掉。 */
async function ensureBrowser() {
  if (await cdpList()) return null;
  const exe = chromePath();
  if (!exe) throw new Error('找不到 Chrome / Edge，无法截图');
  const profile = join(tmpdir(), 'gacha-ui-shot-profile');
  rmSync(profile, { recursive: true, force: true });
  const child = spawn(exe, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    `--window-size=${WIDTH},${HEIGHT}`, 'about:blank',
  ], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    if (await cdpList()) return child;
    await sleep(250);
  }
  child.kill();
  throw new Error('无头浏览器没起来（调试端口 ' + PORT + ' 无响应）');
}

const browser = await ensureBrowser();
const target = (await cdpList()).find((t) => t.type === 'page');
if (!target) throw new Error('没有可用的 page target');

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });
let seq = 0;
const pending = new Map();
const pageErrors = [];
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.method === 'Runtime.exceptionThrown') {
    pageErrors.push(msg.params.exceptionDetails.exception?.description
      || msg.params.exceptionDetails.text);
  }
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq;
  pending.set(id, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result)));
  ws.send(JSON.stringify({ id, method, params }));
});
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'evaluate 失败');
  return r.result.value;
};
const waitFor = async (expr, tries = 80) => {
  for (let i = 0; i < tries; i++) {
    if (await evalJs(expr).catch(() => false)) return true;
    await sleep(200);
  }
  return false;
};

async function shot(name, sel) {
  let clip;
  if (sel) {
    const box = await evalJs(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return null; const r = el.getBoundingClientRect();
      return { x: Math.max(0, r.x + window.scrollX - 8), y: Math.max(0, r.y + window.scrollY - 8),
        width: r.width + 16, height: r.height + 16 }; })()`);
    if (!box) throw new Error('截图元素不存在：' + sel);
    clip = { ...box, scale: 1 };
  }
  const png = await send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: !!clip, clip,
  });
  const file = join(OUT, name + '.png');
  writeFileSync(file, Buffer.from(png.data, 'base64'));
  console.log('[shot]', file, clip ? `${Math.round(clip.width)}x${Math.round(clip.height)}` : '整页');
}

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: SCALE, mobile: false,
  });
  await send('Page.navigate', { url: URL_ });
  await waitFor('!!(document.querySelector(".draw-shell") || document.querySelector("#view .panel"))');
  if (!KEEP) {
    await evalJs('sessionStorage.clear(); localStorage.clear();');
    await send('Page.reload', { ignoreCache: true });
    await waitFor('!!(document.querySelector(".draw-shell") || document.querySelector("#view .panel"))');
  } else {
    await send('Page.reload', { ignoreCache: true });
    await waitFor('!!(document.querySelector(".draw-shell") || document.querySelector("#view .panel"))');
  }
  await sleep(1000);

  if (!STEPS_FILE) {
    await shot('01-full');
    await shot('02-draw-side', '.draw-side');
  } else {
    const steps = JSON.parse(readFileSync(STEPS_FILE, 'utf8'));
    for (const [i, st] of steps.entries()) {
      if (st.js) await evalJs(st.js);
      await sleep(Number(st.wait ?? 800));
      await shot(st.name || `step${i + 1}`, st.sel || '');
    }
  }
  if (pageErrors.length) {
    console.error('[page errors]', pageErrors.slice(0, 5));
    process.exitCode = 1;
  } else {
    console.log('[ok] 无页面异常，截图目录：' + OUT);
  }
} finally {
  ws.close();
  if (browser) browser.kill();
}
