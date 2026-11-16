# -*- coding: utf-8 -*-
"""语义抽卡接口：候选画师卡片 + 风格样图只读分发。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from ..core import semantics
from ..db import get_db
from ..errors import AppError, ok
from ..services import concepts

router = APIRouter(prefix="/api/semantics", tags=["semantics"])


def _unavailable(exc: semantics.SemanticsUnavailable) -> AppError:
    return AppError(str(exc), code="semantics_unavailable", status=503)


@router.get("/status")
def status():
    """索引是否就绪、编码器、条数；前端据此决定面板显示还是提示。"""
    return ok(semantics.status())


@router.get("/suggest")
def suggest(q: str = "", top_k: int = Query(12, ge=1, le=30),
            db: Session = Depends(get_db)):
    """一句话画风 → 画师候选；q 为空时给精选/核心/收藏。

    卡片只保留一个外部风格锚点 URL（hover 才加载），「我用它出过的图」
    只给数量，详情由前端按需走 /api/concepts/cover 与 /api/concepts/images。
    """
    try:
        data = semantics.suggest(q, top_k=top_k)
    except semantics.SemanticsUnavailable as exc:
        raise _unavailable(exc) from exc
    for item in data.get("items", []):
        hist = concepts.thumbs_for(db, str(item.get("name") or ""), limit=1)
        item["history"] = {"image_count": hist["image_count"],
                           "draw_count": hist["draw_count"]}
    return ok(data)


@router.get("/thumb")
def thumb(index: int = Query(..., ge=1)):
    """按需读取项目外的风格缩略图，路径由构建时白名单决定，不接受任意路径。"""
    try:
        p = semantics.thumb_path(index)
    except semantics.SemanticsUnavailable as exc:
        raise _unavailable(exc) from exc
    return FileResponse(str(p), media_type="image/png",
                        headers={"Cache-Control": "public, max-age=86400"})


@router.get("/artist-thumb")
def artist_thumb(name: str = Query(..., min_length=1)):
    """画师池条目名 → 该画师的风格样图（只读，路径来自样图目录白名单）。

    画师图鉴有一千多条名字，光看 `dore \\(gilles dore\\)` 判断不了画风；
    选择器里悬停一行就拉这张图，看的是画不是字。
    """
    p = semantics.artist_thumb(name)
    if p is None:
        raise AppError("这个画师没有风格样图", code="thumb_not_found", status=404)
    return FileResponse(str(p), media_type="image/png",
                        headers={"Cache-Control": "public, max-age=86400"})
