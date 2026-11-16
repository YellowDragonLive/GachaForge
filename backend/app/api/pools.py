# -*- coding: utf-8 -*-
"""卡池与条目接口。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from ..db import get_db
from ..errors import ok
from ..schemas import ImportIn, PoolIn, PoolItemIn, PoolUpdate
from ..services import pools as svc

router = APIRouter(prefix="/api/pools", tags=["pools"])


@router.get("")
def list_pools(enabled_only: bool = False, db: Session = Depends(get_db)):
    return ok(svc.list_pools(db, enabled_only=enabled_only))


@router.post("")
def create_pool(body: PoolIn, db: Session = Depends(get_db)):
    row = svc.create_pool(db, body.model_dump())
    return ok({"id": row.id, "slug": row.slug})


@router.get("/batches")
def batches(db: Session = Depends(get_db)):
    return ok(svc.list_batches(db))


# 注意：必须声明在 /{pool_id} 之前，否则会被当成 pool_id 做 int 校验而返回 422。
@router.get("/tag-suggest")
def tag_suggest(q: str = "", pool: str = "", limit: int = Query(30, ge=1, le=100),
                db: Session = Depends(get_db)):
    """给前端下拉用的 tag 候选：空 q 返回热门词，q 做子串联想，pool 按类别/池名限定。"""
    return ok(svc.suggest_tags(db, q=q, pool=pool, limit=limit))


@router.get("/items")
def list_items(kind: str = "", q: str = "", pool: str = "",
               limit: int = Query(60, ge=1, le=200),
               offset: int = Query(0, ge=0),
               db: Session = Depends(get_db)):
    """装配面板的选择器数据源：按类别列出条目本身，供锁定到具体 tag。"""
    return ok(svc.list_items(db, kind=kind, q=q, pool=pool,
                             limit=limit, offset=offset))


@router.delete("/batches/{batch_id}")
def rollback(batch_id: int, db: Session = Depends(get_db)):
    return ok(svc.rollback_batch(db, batch_id))


@router.post("/import")
def import_path(body: ImportIn, db: Session = Depends(get_db)):
    return ok(svc.import_path(db, body.path, kind=body.kind, pool_slug=body.pool_slug))


@router.get("/{pool_id}")
def get_pool(pool_id: int, db: Session = Depends(get_db)):
    p = svc.get_pool(db, pool_id)
    return ok({"id": p.id, "slug": p.slug, "name": p.name, "kind": p.kind,
               "enabled": p.enabled, "item_count": svc._count(db, p.id)})


@router.put("/{pool_id}")
def update_pool(pool_id: int, body: PoolUpdate, db: Session = Depends(get_db)):
    row = svc.update_pool(db, pool_id, body.model_dump(exclude_none=True))
    return ok({"id": row.id, "enabled": row.enabled})


@router.delete("/{pool_id}")
def delete_pool(pool_id: int, db: Session = Depends(get_db)):
    svc.delete_pool(db, pool_id)
    return ok({"deleted": pool_id})


@router.get("/{pool_id}/items")
def list_items(pool_id: int, q: str = "", limit: int = Query(100, le=500),
               offset: int = 0, db: Session = Depends(get_db)):
    return ok(svc.list_pool_items(db, pool_id, q=q, limit=limit, offset=offset))


@router.post("/{pool_id}/items")
def add_item(pool_id: int, body: PoolItemIn, db: Session = Depends(get_db)):
    row = svc.add_item(db, pool_id, body.model_dump())
    return ok({"id": row.id})


@router.put("/items/{item_id}")
def toggle_item(item_id: int, enabled: bool = Query(True), db: Session = Depends(get_db)):
    svc.toggle_item(db, item_id, enabled)
    return ok({"id": item_id, "enabled": enabled})


@router.delete("/items/{item_id}")
def delete_item(item_id: int, db: Session = Depends(get_db)):
    svc.delete_item(db, item_id)
    return ok({"deleted": item_id})
