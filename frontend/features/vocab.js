import { api } from '../api.js';
import { cut, esc } from '../detail.js';
import { state } from '../store.js';
import { refresh } from '../core/router.js';
import { $, done, fail, toast } from '../core/ui.js';

// 意群双语补全：输入框是「查询工具」，g.extra 是「已确认的英文 tag 串」。
// 中文查询词绝不写进 extra —— 写进 prompt 的永远是候选对应的英文 tag。

/** 补全候选行：display 已是「主 · 对照」双语；data-en 是真正写入的英文。 */
export function vocabSuggestHtml() {
  const v = state.vocab;
  if (v.loading) return '<div class="hint">查词表中…</div>';
  if (!v.q.trim()) return '<div class="hint">输入中文（黑发）或英文（silver hair）看候选</div>';
  if (!v.items.length) {
    return `<div class="hint">词表里没有「${esc(cut(v.q, 20))}」——回车可原样写一个英文 tag</div>`;
  }
  return v.items.map((x, i) => `<button type="button" class="vocab-item${i === 0 ? ' first' : ''}"
    data-act="vocab-pick" data-en="${esc(x.en)}" data-scope="${esc(v.scope)}" data-uid="${v.uid}"
    title="${esc(x.en)} = ${esc(x.zh)}｜点一下写进这个词群">
    <span class="vocab-en">${esc(cut(x.en, 34))}</span><span class="vocab-zh">${esc(cut(x.zh, 18))}</span>
  </button>`).join('');
}

/** 当前激活意群的对象（场景 / 某个人物）。 */
export function vocabTarget(scope, uid) {
  if (scope === 'scene') return state.assembly.scene;
  return state.assembly.people.find((p) => p.uid === Number(uid)) || null;
}

/** 只刷候选容器与 chip 区，不重建输入框：打字时不能失焦。 */
export function refreshVocabParts() {
  const v = state.vocab;
  const box = document.querySelector(`.vocab-suggest[data-scope="${v.scope}"][data-uid="${v.uid}"]`);
  if (box) {
    box.innerHTML = vocabSuggestHtml();
    box.hidden = !v.open;
  }
  const chosen = document.querySelector(`.vocab-chosen[data-scope="${v.scope}"][data-uid="${v.uid}"]`);
  const g = vocabTarget(v.scope, v.uid);
  if (g && chosen) {
    const words = String(g.extra || '').split(',').map((x) => x.trim()).filter(Boolean);
    chosen.innerHTML = words.map((w, i) => `<span class="vocab-chip" title="已选词，点 × 删除">${esc(cut(w, 30))}
      <button type="button" data-act="vocab-del" data-i="${i}" data-scope="${esc(v.scope)}" data-uid="${v.uid}">×</button></span>`).join('');
  }
}

let vocabTimer = null;
export async function loadVocabSuggest() {
  const v = state.vocab;
  if (!v.q.trim()) { v.items = []; v.open = true; refreshVocabParts(); return; }
  v.loading = true; v.open = true;
  refreshVocabParts();
  try {
    const data = await api.get('/api/vocab/suggest?' + new URLSearchParams({ q: v.q, limit: 12 }));
    if (state.vocab !== v) return;           // 换意群了，丢弃旧响应
    v.items = data.items || []; v.ready = true;
  } catch (err) {
    if (state.vocab !== v) return;
    v.items = []; v.ready = false;
  } finally {
    if (state.vocab === v) v.loading = false;
  }
  refreshVocabParts();
}

/** 点候选 / 回车：把一个英文 tag 追加到该意群 extra，清空查询框。 */
export function vocabAddWord(scope, uid, en) {
  const g = vocabTarget(scope, uid);
  const word = String(en || '').trim();
  if (!g || !word) return false;
  const words = String(g.extra || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!words.some((w) => w.toLowerCase() === word.toLowerCase())) words.push(word);
  g.extra = words.join(', ');
  g.draft = '';                 // 草稿已转正，输入框跟着清空
  state.vocab.q = ''; state.vocab.open = false; state.vocab.items = [];
  refresh('draw').catch(fail);
  return true;
}

/**
 * 抽卡前把「输入框里还没回车的草稿」提交成正式词。
 *
 * 病根是输入框看起来像自由文本框、实际只当查询工具用：用户把
 * 「A realistic photograph of coser」打进去就去点抽卡，字留在框里、
 * `g.extra` 是空的，图里自然没有——这是静默丢失，最坏的一种。
 * 所以抽卡时统一收编：英文段原样写进该意群；中文段与「prompt 只收英文 tag」
 * 的约定冲突，不偷偷丢，收集起来由调用方提示一次。
 */
export function commitAssemblyDrafts() {
  const list = [['场景', state.assembly.scene],
    ...state.assembly.people.map((p, i) => [`P${i + 1}`, p])];
  const rejected = [];
  let added = 0;
  for (const [label, g] of list) {
    const draft = String((g && g.draft) || '').trim();
    if (!draft) continue;
    const words = String(g.extra || '').split(',').map((x) => x.trim()).filter(Boolean);
    for (const seg of draft.split(',').map((x) => x.trim()).filter(Boolean)) {
      if (/[\u4e00-\u9fff]/.test(seg)) { rejected.push(`${label}「${seg}」`); continue; }
      if (!words.some((w) => w.toLowerCase() === seg.toLowerCase())) words.push(seg);
      added += 1;
    }
    g.extra = words.join(', ');
    g.draft = '';
  }
  return { added, rejected };
}

/** 打字查词表（input 委派）：记录激活意群并防抖，只刷候选容器不重建输入框。 */
export function vocabInput(t) {
  state.vocab.scope = t.dataset.scope || '';
  state.vocab.uid = Number(t.dataset.uid) || 0;
  state.vocab.q = t.value;
  // 同时记到意群自己的 draft：切走再切回来、或者刷新面板，都不能把已打的字弄丢。
  const g = vocabTarget(state.vocab.scope, state.vocab.uid);
  if (g) g.draft = t.value;
  clearTimeout(vocabTimer);
  vocabTimer = setTimeout(() => loadVocabSuggest(), 220);
}

/** 失焦收起候选（change 事件）；查询词不进 extra，回车选词走 keydown。 */
export function vocabBlur() { state.vocab.open = false; }

/** Esc 收起候选并刷新；Enter 选第一个候选，没有候选且是英文则原样写入（逃生口）。 */
export function vocabKeydown(t, e) {
  if (e.key === 'Escape') { state.vocab.open = false; refresh('draw').catch(fail); return; }
  if (e.key !== 'Enter') return;
  clearTimeout(vocabTimer);
  const v = state.vocab;
  if (v.items && v.items.length) {
    vocabAddWord(v.scope, v.uid, v.items[0].en);
    done(`已加入「${v.items[0].en}」（${v.items[0].zh}）`);
  } else {
    const q = t.value.trim();
    if (!q) return;
    // 没有候选且是中文 → 提示换词，绝不把中文写进 prompt
    if (/[\u4e00-\u9fff]/.test(q)) { toast('词表里没有这个词，换一个或改用英文 tag'); return; }
    vocabAddWord(v.scope, v.uid, q);
    done(`已原样加入「${q}」`);
  }
}

// ---- 动作注册表：data-act → 处理器（app.js 事件委派调用）----
export const actions = {
  'vocab-pick': async (btn) => {
    vocabAddWord(btn.dataset.scope, btn.dataset.uid, btn.dataset.en);
    done(`已加入「${btn.dataset.en}」`);
  },
  'vocab-del': async (btn) => {
    const g = vocabTarget(btn.dataset.scope, btn.dataset.uid);
    if (g) {
      const words = String(g.extra || '').split(',').map((x) => x.trim()).filter(Boolean);
      words.splice(Number(btn.dataset.i), 1);
      g.extra = words.join(', ');
      await refresh('draw');
    }
  },
};
