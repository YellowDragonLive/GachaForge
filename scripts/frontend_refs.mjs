// 前端引用自检：模块里**调用**的每个函数，都必须有来源（本模块声明 / import / 浏览器内置）。
//
// 为什么需要它：拆文件最典型的错是把调用搬进新模块、却把 import 留在旧文件里。
// `node --check` 只验语法，这种错要等用户真点到那个按钮才炸——views/draw.js 丢过
// `restoreForm as restoreFormState`，结果整个 boot 抛 ReferenceError、所有视图空数据，
// 而当时的探针只看到「视图渲染了」就放行。
//
// 判据只取「调用点」`name(`，不取所有标识符：对象键、CSS 属性、HTML 文本都不会长成 `name(`，
// 噪声因此极低；模板字面量里的 HTML 正文先剔除，只保留 ${...} 表达式。
export const BROWSER_GLOBALS = new Set(`window document location history navigator console JSON Math
Date Number String Boolean Array Object Promise Map Set WeakMap WeakSet Symbol RegExp Error TypeError
RangeError BigInt Intl setTimeout clearTimeout setInterval clearInterval requestAnimationFrame
cancelAnimationFrame queueMicrotask structuredClone fetch localStorage sessionStorage performance
URL URLSearchParams Blob File FormData Image Event CustomEvent Element HTMLElement Node
IntersectionObserver ResizeObserver AbortController TextEncoder TextDecoder crypto
isNaN parseInt parseFloat encodeURIComponent decodeURIComponent encodeURI alert confirm prompt
requestIdleCallback EventSource`.split(/\s+/).filter(Boolean));

// 语法关键字与语句形式（`if (` `for (` `catch (` …）不算函数调用
const KEYWORDS = new Set(`if for while switch catch return typeof function new await delete void in
of do else try import export super constructor async yield throw case default instanceof
this null true false undefined`.split(/\s+/).filter(Boolean));

/** 把注释、字符串、模板字面量的正文抹成空格，只保留 ${...} 里的表达式。 */
/** 斜杠是不是正则的开头：看它前面最后一个非空字符（赋值/分隔符之后才是正则，`a / b` 是除法）。 */
function regexCanStart(src, i) {
  for (let k = i - 1; k >= 0; k -= 1) {
    const c = src[k];
    if (/\s/.test(c)) continue;
    if ('=(:,[!&|?{};'.includes(c)) return true;
    return false;
  }
  return true;
}

export function stripNonCode(src) {
  let out = '';
  const stack = [];   // 'tpl' | 'tsub' | 'brace'
  const n = src.length;
  const push = (c) => { out += c; };
  const blank = (c) => { out += c === '\n' ? '\n' : ' '; };
  let i = 0;
  while (i < n) {
    const top = stack[stack.length - 1];
    const c = src[i], d = src[i + 1];
    if (top === 'line') { if (c === '\n') { stack.pop(); push(c); } else blank(c); i += 1; continue; }
    if (top === 'block') {
      if (c === '*' && d === '/') { stack.pop(); out += '  '; i += 2; continue; }
      blank(c); i += 1; continue;
    }
    if (top === 'tpl') {
      if (c === '\\') { out += '  '; i += 2; continue; }
      if (c === '`') { stack.pop(); push(c); i += 1; continue; }
      if (c === '$' && d === '{') { stack.push('tsub'); out += '${'; i += 2; continue; }
      blank(c); i += 1; continue;
    }
    if (top === 'str') {
      if (c === '\\') { out += '  '; i += 2; continue; }
      if (c === "'" || c === '"') { stack.pop(); push(c); i += 1; continue; }
      blank(c); i += 1; continue;
    }
    if (top === 'tsub' || top === 'brace') {
      if (c === '{') { stack.push('brace'); push(c); i += 1; continue; }
      if (c === '}') { stack.pop(); push(c); i += 1; continue; }
      if (c === '`') { stack.push('tpl'); push(c); i += 1; continue; }
      if (c === "'" || c === '"') { stack.push('str'); push(c); i += 1; continue; }
    }
    // 普通代码
    if (c === '/' && d !== '/' && d !== '*' && regexCanStart(src, i)) {
      // 正则字面量：内容抹掉，结束斜杠后带回 flags——否则 /^solo(...)$/ 里的 `solo(` 会被误判成调用
      out += '/'; i += 1;
      while (i < n && src[i] !== '/') {
        if (src[i] === '\\') { out += '  '; i += 2; continue; }
        out += src[i] === '\n' ? '\n' : ' '; i += 1;
      }
      out += '/'; i += 1;
      while (i < n && /[a-z]/.test(src[i])) { out += src[i]; i += 1; }
      continue;
    }
    if (c === '/' && d === '/') { stack.push('line'); out += '  '; i += 2; continue; }
    if (c === '/' && d === '*') { stack.push('block'); out += '  '; i += 2; continue; }
    if (c === '`') { stack.push('tpl'); push(c); i += 1; continue; }
    if (c === "'" || c === '"') { stack.push('str'); push(c); i += 1; continue; }
    push(c); i += 1;
  }
  return out;
}

/** 模块自己声明/导入的名字。 */
export function declaredNames(code) {
  const names = new Set();
  for (const m of code.matchAll(/import\s+\{([^}]*)\}\s+from/g)) {
    for (const p of m[1].split(',')) {
      const t = p.trim();
      if (!t) continue;
      const as = t.split(/\s+as\s+/);
      names.add((as[1] || as[0]).trim());
    }
  }
  for (const m of code.matchAll(/import\s+([\w$]+)\s+from/g)) names.add(m[1]);
  for (const m of code.matchAll(/\bfunction\s*\*?\s*([\w$]+)/g)) names.add(m[1]);
  for (const m of code.matchAll(/\bclass\s+([\w$]+)/g)) names.add(m[1]);
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([\w$]+)/g)) names.add(m[1]);
  for (const m of code.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}/g)) {
    for (const p of m[1].split(',')) {
      const t = p.trim().split(':').pop().trim().replace(/=.*$/, '').trim();
      if (/^[\w$]+$/.test(t)) names.add(t);
    }
  }
  // 形参：`(a, b) =>`、`function f(a)`、`catch (e)`——宁可多认，避免误报
  for (const m of code.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
    for (const p of m[1].split(',')) {
      const t = p.trim().replace(/=.*$/, '').replace(/^\.\.\./, '').trim();
      if (/^[\w$]+$/.test(t)) names.add(t);
    }
  }
  for (const m of code.matchAll(/([\w$]+)\s*=>/g)) names.add(m[1]);
  for (const m of code.matchAll(/\bcatch\s*\(\s*([\w$]+)/g)) names.add(m[1]);
  return names;
}

/** 返回未解析的调用名列表：[{ name, count }] */
export function unresolvedCalls(code) {
  const clean = stripNonCode(code);
  const declared = declaredNames(clean);
  const missing = new Map();
  for (const m of clean.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[1];
    if (KEYWORDS.has(name) || BROWSER_GLOBALS.has(name) || declared.has(name)) continue;
    missing.set(name, (missing.get(name) || 0) + 1);
  }
  return [...missing].map(([name, count]) => ({ name, count }));
}
