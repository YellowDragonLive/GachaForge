# -*- coding: utf-8 -*-
"""角色冷启动缩略图：条目 tags → 角色立绘图（只读分发）。

索引由 scripts/import_character_thumbs.py 从外部角色选择器的内嵌 webp 生成，
落在 data/char_thumbs/index.json。纯静态、可重建、不进数据库。

和画师样图（semantics.py）的区别：画师图靠文件名反推 key、依赖语义向量索引；
这里 key 直接写在 index.json 里、完全自包含，没有 numpy/编码器依赖，
抽卡主流程即使语义索引没构建也能显示角色立绘。

配对用英文 tags（不用中文 label）：缩略图 key 与角色池条目的 tags 都是
`作品, 角色, 作品` 格式，完整 key 命中率约 99.7%，角色名约 100%。
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from ..config import ROOT

DIR = ROOT / "data" / "char_thumbs"
INDEX = DIR / "index.json"

_CACHE: dict = {"sig": None, "exact": {}, "loose": {}}


def _norm(s: str) -> str:
    """与前端 conceptKeyOf 同语义：去反斜杠、压空白、转小写。"""
    return re.sub(r"\s+", " ", str(s or "").replace("\\", "")).strip().lower()


def _loose(s: str) -> str:
    s = _norm(s)
    return re.sub(r"[^0-9a-z\u4e00-\u9fff]+", "", s)


def _load() -> dict | None:
    if not INDEX.is_file():
        return None
    try:
        sig = (INDEX.stat().st_mtime_ns, INDEX.stat().st_size)
    except OSError:
        return None
    if _CACHE["sig"] == sig:
        return _CACHE
    try:
        data = json.loads(INDEX.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    exact: dict[str, Path] = {}
    loose: dict[str, Path] = {}
    for e in data.get("entries", []):
        f = DIR / str(e.get("file") or "")
        if not f.is_file():
            continue  # 图片被删了就当没这张，不返回坏路径
        for key in (e.get("full"), e.get("name")):
            k = _norm(key)
            if not k:
                continue
            exact.setdefault(k, f)
            loose.setdefault(_loose(k), f)
    _CACHE.update(sig=sig, exact=exact, loose=loose)
    return _CACHE


def thumb_path(name: str) -> Path | None:
    """条目 tags / 角色名 → 缩略图路径；对不上（索引没建）返回 None，不抛错。

    依次尝试：完整 tags → 单个角色名 → loose 兜底。前端立绘传的是拆开的
    单个 tag（作品名/角色名），所以单个名字也必须能命中。
    """
    key = str(name or "").strip()
    if not key:
        return None
    cache = _load()
    if cache is None:
        return None
    # 支持逗号分隔的多个候选（角色条目的 tags 是 `作品, 角色, 作品`）
    for part in key.split(","):
        p = part.strip()
        if not p:
            continue
        for k in (_norm(p), _loose(p)):
            hit = cache["exact"].get(k) or cache["loose"].get(k)
            if hit is not None:
                return hit
    return None


def has_thumb(name: str) -> bool:
    return thumb_path(name) is not None


def status() -> dict:
    cache = _load()
    return {"ready": cache is not None,
            "count": len(cache["exact"]) // 2 if cache else 0,
            "dir": str(DIR)}
