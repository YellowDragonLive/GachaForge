# -*- coding: utf-8 -*-
"""概念缩略图接口（v2）：列表只给文字与计数，图片一律按需拉取。

  GET /api/concepts/wall    概念墙（不含任何 <img> 数据）
  GET /api/concepts/cover   单张代表图，供卡片 hover / focus 悬浮
  GET /api/concepts/images  概念详情页，首屏最多 50 张，可 offset 翻页

所有缩略图都复用 /api/images/{id}/thumb，不接受客户端传路径。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from ..db import get_db
from ..errors import ok
from ..schemas import ConceptBatchIn
from ..services import concepts as svc

router = APIRouter(prefix="/api/concepts", tags=["concepts"])


@router.get("/status")
def status(db: Session = Depends(get_db)):
    """概念索引是否就绪、覆盖了多少图与多少概念。"""
    return ok(svc.status(db))


@router.get("/wall")
def wall(limit: int = Query(12, ge=1, le=60),
         kind: str = "", q: str = "", include_info: bool = False,
         db: Session = Depends(get_db)):
    """概念墙：数据库自动发现的高频概念，只返回文字与计数。"""
    return ok(svc.wall(db, limit=limit, kind=kind, q=q,
                       include_info=include_info))


@router.get("/cover")
def cover(key: str = "", db: Session = Depends(get_db)):
    """单张代表图；前端按 key 缓存，hover / focus 时才请求。"""
    return ok(svc.cover(db, key))


@router.get("/images")
def images(key: str = "", limit: int = Query(50, ge=1, le=50),
           offset: int = Query(0, ge=0), db: Session = Depends(get_db)):
    """概念详情页：该概念曾经出过的图，首屏上限 50 张。"""
    return ok(svc.images_for(db, key, limit=limit, offset=offset))


@router.get("/thumbs")
def thumbs(key: str = "", limit: int = Query(1, ge=1, le=12),
           db: Session = Depends(get_db)):
    """兼容旧调用：最多返回一张封面（不再是多图堆叠）。"""
    return ok(svc.thumbs_for(db, key, 1))


@router.post("/thumbs-batch")
def thumbs_batch(body: ConceptBatchIn, db: Session = Depends(get_db)):
    """兼容旧调用：批量取单张封面。"""
    return ok(svc.thumbs_batch(db, body.keys, 1))
