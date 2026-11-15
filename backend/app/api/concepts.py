# -*- coding: utf-8 -*-
"""概念缩略图接口：只读反查抽卡数据库，返回带真实代表图的概念卡片。

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
         kind: str = "", q: str = "",
         thumbs: int = Query(3, ge=1, le=12),
         include_info: bool = False,
         db: Session = Depends(get_db)):
    """概念墙：数据库自动发现的高频概念 + 各自真实代表图。"""
    return ok(svc.wall(db, limit=limit, kind=kind, q=q, thumbs=thumbs,
                       include_info=include_info))


@router.get("/thumbs")
def thumbs(key: str = "", limit: int = Query(4, ge=1, le=12),
           db: Session = Depends(get_db)):
    """单个概念的代表图；给语义检索结果补「我用它出过的图」。"""
    return ok(svc.thumbs_for(db, key, limit))


@router.post("/thumbs-batch")
def thumbs_batch(body: ConceptBatchIn, db: Session = Depends(get_db)):
    """一次拿下整屏卡片的代表图，避免前端 N+1 请求。"""
    return ok(svc.thumbs_batch(db, body.keys, body.limit))
