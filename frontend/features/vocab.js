// 意群双语补全：输入框是「查询工具」，g.extra 是「已确认的英文 tag 串」。
// 中文查询词绝不写进 extra —— 写进 prompt 的永远是候选对应的英文 tag。

import { api } from '../api.js';
import { esc, cut } from '../detail.js';
import { state } from '../store.js';
import { toast, fail, done } from '../core/ui.js';
import { refresh } from '../core/router.js';

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
  state.vocab.q = ''; state.vocab.open = false; state.vocab.items = [];
  refresh('draw').catch(fail);
  return true;
}

/** 打字查词表（input 委派）：记录激活意群并防抖，只刷候选容器不重建输入框。 */
export function vocabInput(t) {
  state.vocab.scope = t.dataset.scope || '';
  state.vocab.uid = Number(t.dataset.uid) || 0;
  state.vocab.q = t.value;
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
