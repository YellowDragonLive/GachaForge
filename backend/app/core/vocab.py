# -*- coding: utf-8 -*-
"""提示词中英对照词表：本地字典，供意群自由输入做双语补全。

数据源 data/vocab/danbooru-cn.json（scripts/fetch_vocab.py 下载，MIT）：
  {英文tag: 中文} 33071 条。不联网、不调翻译 API、不要 key。

查询语义与项目其它快速筛选保持一致（见 widgets.js queryWords/matchQuery）：
  空格分词 AND、`_` ≡ 空格、子串命中。
  - q 是中文 → 在中文译名上匹配，返回「中文 → english」候选
  - q 是英文 → 在英文 tag 上匹配，返回「english → 中文」候选
  - 两项都返回双语字段，前端决定谁主谁次；写入 prompt 的永远是英文 tag。

优雅降级：词表缺失/损坏时 raise VocabUnavailable，由 API 转 503，
不影响抽卡、出图等其它功能（和 semantics 索引同一套约定）。
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from ..config import ROOT

VOCAB_PATH = ROOT / "data" / "vocab" / "danbooru-cn.json"


class VocabUnavailable(RuntimeError):
    """词表未下载或损坏。"""


def query_words(q: str) -> list[str]:
    s = str(q or "").strip().lower().replace("_", " ")
    return [w for w in re.split(r"\s+", s) if w]


def _match(text: str, words: list[str]) -> bool:
    low = str(text or "").lower().replace("_", " ")
    return all(w in low for w in words)


class _Index:
    def __init__(self):
        self.sig: tuple = ()
        self.pairs: list[tuple[str, str]] = []   # (en, zh)
        self.by_en: dict[str, str] = {}
        self.by_zh: dict[str, list[str]] = {}

    def refresh(self) -> None:
        if not VOCAB_PATH.is_file():
            self.sig = ()
            self.pairs = []
            self.by_en = {}
            self.by_zh = {}
            raise VocabUnavailable(
                "提示词词表未下载，运行 python scripts/fetch_vocab.py 后重试")
        try:
            sig = (VOCAB_PATH.stat().st_size, VOCAB_PATH.stat().st_mtime_ns)
            if sig == self.sig:
                return
            obj = json.loads(VOCAB_PATH.read_text(encoding="utf-8-sig"))
            if not isinstance(obj, dict) or not obj:
                raise ValueError("空词表")
        except VocabUnavailable:
            raise
        except Exception as exc:
            raise VocabUnavailable(f"提示词词表读取失败：{exc}") from exc

        pairs = [(str(en).strip(), str(zh).strip()) for en, zh in obj.items()
                 if str(en).strip() and str(zh).strip()]
        by_en: dict[str, str] = {}
        by_zh: dict[str, list[str]] = {}
        for en, zh in pairs:
            by_en[en.lower()] = zh
            by_zh.setdefault(zh.lower(), []).append(en)
        self.sig = sig
        self.pairs = pairs
        self.by_en = by_en
        self.by_zh = by_zh


_INDEX = _Index()


def status() -> dict:
    try:
        _INDEX.refresh()
    except VocabUnavailable as exc:
        return {"ready": False, "count": 0, "reason": str(exc)}
    return {"ready": True, "count": len(_INDEX.pairs),
            "path": str(VOCAB_PATH.relative_to(ROOT)).replace("\\", "/")}


def _is_chinese(s: str) -> bool:
    return any("\u4e00" <= ch <= "\u9fff" for ch in s)


def suggest(q: str = "", limit: int = 12) -> dict:
    """双语补全候选。每条含 en / zh / display，写入 prompt 用 en。"""
    _INDEX.refresh()
    q = str(q or "").strip()
    if not q:
        return {"query": "", "lang": "", "items": [], "total": 0}

    lang = "zh" if _is_chinese(q) else "en"
    words = query_words(q)
    out: list[dict] = []
    seen: set[str] = set()

    if lang == "zh":
        # 中文输入 → 在译名上匹配。命中后按译名分组，同义的多个英文并列。
        for en, zh in _INDEX.pairs:
            if not _match(zh, words):
                continue
            key = zh.lower()
            if key in seen:
                continue
            seen.add(key)
            ens = _INDEX.by_zh.get(key, [en])[:4]
            out.append({"en": ", ".join(ens), "zh": zh,
                        "display": f"{zh} · {' / '.join(ens)}"})
            if len(out) >= limit:
                break
    else:
        # 英文输入 → 在英文 tag 上匹配，短的优先（前缀感更强）。
        hits = [(en, zh) for en, zh in _INDEX.pairs if _match(en, words)]
        hits.sort(key=lambda p: (len(p[0]), p[0]))
        for en, zh in hits[:limit]:
            out.append({"en": en, "zh": zh, "display": f"{en} · {zh}"})

    return {"query": q, "lang": lang, "items": out, "total": len(out)}


def translate(text: str) -> dict:
    """整段中文 → 英文 tag 串：逐词查中文译名，未命中的原样保留。

    用户输入「黑发, 微笑」→ en="black hair, smile"，missing=[]。
    多条中文对多个英文时只取第一条（避免把 prompt 撑爆），
    想换词用补全候选手动挑。
    """
    _INDEX.refresh()
    raw = str(text or "").strip()
    parts = [p.strip() for p in re.split(r"[,，]", raw) if p.strip()]
    ens: list[str] = []
    missing: list[str] = []
    for p in parts:
        hit = _INDEX.by_zh.get(p.lower())
        if hit:
            ens.append(hit[0])
        elif p.lower() in _INDEX.by_en:
            ens.append(p)           # 本来就是英文 tag
        else:
            ens.append(p)
            missing.append(p)
    return {"text": raw, "en": ", ".join(ens), "missing": missing}
