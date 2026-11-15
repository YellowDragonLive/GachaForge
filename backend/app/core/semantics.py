# -*- coding: utf-8 -*-
"""画师语义索引：加载离线预算的向量，运行期只做 numpy 余弦检索。

索引由 scripts/build_semantics.py 生成，纯静态文件、可重建、不进数据库。
返回的每个候选都带风格样图地址与命中标签，让眼睛而不是文字做最终判断。
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from ..config import ROOT
from . import embed

INDEX_DIR = ROOT / "data" / "semantics"


class SemanticsUnavailable(RuntimeError):
    """索引或编码器未就绪；API 层降级为明确提示，不影响抽卡主流程。"""


@dataclass
class Index:
    meta: dict
    items: list[dict]
    vectors: np.ndarray
    tags: list[str]
    tag_vectors: np.ndarray


_cached: Index | None = None
_cached_sig: tuple | None = None


def _signature() -> tuple:
    names = ("meta.json", "vectors.npy", "tags.json", "tag_vectors.npy")
    out = []
    for n in names:
        p = INDEX_DIR / n
        out.append((p.stat().st_mtime_ns, p.stat().st_size) if p.is_file() else None)
    return tuple(out)


def load() -> Index:
    global _cached, _cached_sig
    sig = _signature()
    if any(x is None for x in sig):
        raise SemanticsUnavailable(
            "语义索引未构建，请运行 python scripts/build_semantics.py")
    if _cached is not None and sig == _cached_sig:
        return _cached
    meta = json.loads((INDEX_DIR / "meta.json").read_text(encoding="utf-8"))
    if meta.get("dim") != embed.DIM:
        raise SemanticsUnavailable("索引维度与当前编码器不一致，请重建索引")
    idx = Index(
        meta=meta,
        items=meta.get("items", []),
        vectors=np.load(INDEX_DIR / "vectors.npy"),
        tags=json.loads((INDEX_DIR / "tags.json").read_text(encoding="utf-8")),
        tag_vectors=np.load(INDEX_DIR / "tag_vectors.npy"),
    )
    if len(idx.vectors) != len(idx.items) or len(idx.tag_vectors) != len(idx.tags):
        raise SemanticsUnavailable("索引文件与元数据条数不一致，请重建索引")
    _cached, _cached_sig = idx, sig
    return idx


def status() -> dict:
    try:
        idx = load()
        thumbs = Path(idx.meta.get("thumbs_dir", ""))
        return {
            "ready": True,
            "encoder": idx.meta.get("encoder"),
            "dim": idx.meta.get("dim"),
            "count": len(idx.items),
            "tag_count": len(idx.tags),
            "built_at": idx.meta.get("built_at"),
            "source": idx.meta.get("source"),
            "thumbs_ready": thumbs.is_dir(),
            "thumbs_count": sum(1 for it in idx.items if it.get("thumb")),
            "embed_ready": embed.is_ready(),
        }
    except SemanticsUnavailable as exc:
        return {"ready": False, "reason": str(exc), "embed_ready": embed.is_ready()}


def thumb_path(index: int) -> Path:
    """按构建时记录的缩略图文件名取图，严格限制在白名单目录内。"""
    idx = load()
    root = Path(idx.meta.get("thumbs_dir", "")).resolve()
    if not str(root) or not root.is_dir():
        raise SemanticsUnavailable("画师样图目录不可用")
    item = next((it for it in idx.items if it.get("index") == index), None)
    name = (item or {}).get("thumb")
    if not name:
        raise SemanticsUnavailable(f"画师 #{index} 没有风格样图")
    p = (root / str(name)).resolve()
    if root not in p.parents or not p.is_file():
        raise SemanticsUnavailable(f"画师 #{index} 的样图不可读")
    return p


def suggest(query: str, top_k: int = 12) -> dict:
    """返回带样图的画师卡片；空查询给精选/核心/收藏作为可浏览的起点。"""
    idx = load()
    q = str(query or "").strip()
    if not idx.items:
        return {"query": q, "items": [], "total": 0, "mode": "empty"}
    if q:
        try:
            qv = embed.encode([q])[0]
        except embed.EmbedUnavailable as exc:
            raise SemanticsUnavailable(str(exc)) from exc
        scores = idx.vectors @ qv
        tag_scores = idx.tag_vectors @ qv
        order = np.argsort(-scores)[:top_k]
        mode = "semantic"
    else:
        scores = np.zeros(len(idx.items), dtype=np.float32)
        tag_scores = np.zeros(len(idx.tags), dtype=np.float32)
        # 核心 > 精选 > 收藏 > 其余，保证空查询也有高质量起点
        rank = np.array([3 if it.get("core") else 2 if it.get("selected")
                         else 1 if it.get("favorite") else 0 for it in idx.items])
        order = np.argsort(-rank, kind="stable")[:top_k]
        mode = "curated"

    items = []
    for i in order:
        src = idx.items[int(i)]
        row = {k: v for k, v in src.items() if k not in ("tag_ids", "text")}
        row["score"] = round(float(scores[int(i)]), 4) if q else None
        row["thumb_url"] = (f"/api/semantics/thumb?index={src['index']}"
                            if src.get("thumb") else None)
        tids = [int(t) for t in src.get("tag_ids", [])
                if 0 <= int(t) < len(idx.tags)]
        if q:
            top = sorted(tids, key=lambda t: -float(tag_scores[t]))[:3]
            row["reason"] = [{"tag": idx.tags[t],
                              "score": round(float(tag_scores[t]), 4)} for t in top]
        else:
            row["reason"] = [{"tag": idx.tags[t]} for t in tids[:3]]
        items.append(row)
    return {"query": q, "items": items, "total": len(items), "mode": mode}
