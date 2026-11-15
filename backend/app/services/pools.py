# -*- coding: utf-8 -*-
"""卡池仓储与服务：SQLite 单一事实源 + 旧数据导入。"""
from __future__ import annotations

import csv
import hashlib
import json
import re
from pathlib import Path
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..core import wildcards as wc_core
from ..core.pools import Item, PoolData, discover_pools
from ..errors import ConflictError, NotFoundError
from ..models import ImportBatch, Pool, PoolItem


def _hash(label: str, tags: str) -> str:
    return hashlib.sha256(f"{label}\x1f{tags}".encode("utf-8")).hexdigest()[:32]


def _count(db: Session, pool_id: int) -> int:
    return int(db.scalar(select(func.count()).select_from(PoolItem)
                         .where(PoolItem.pool_id == pool_id)) or 0)


def list_pools(db: Session, *, enabled_only: bool = False) -> list[dict]:
    stmt = select(Pool).order_by(Pool.kind, Pool.slug)
    if enabled_only:
        stmt = stmt.where(Pool.enabled.is_(True))
    rows = db.scalars(stmt).all()
    counts = dict(db.execute(
        select(PoolItem.pool_id, func.count()).group_by(PoolItem.pool_id)).all())
    return [{"id": p.id, "slug": p.slug, "name": p.name, "kind": p.kind,
             "source": p.source, "source_ref": p.source_ref,
             "enabled": p.enabled, "weight": p.weight,
             "item_count": int(counts.get(p.id, 0))} for p in rows]


def get_pool(db: Session, pool_id: int) -> Pool:
    p = db.get(Pool, pool_id)
    if not p:
        raise NotFoundError(f"卡池不存在: id={pool_id}")
    return p


def create_pool(db: Session, data: dict) -> Pool:
    if db.scalar(select(Pool).where(Pool.slug == data["slug"])):
        raise ConflictError(f"卡池 slug 已存在: {data['slug']}")
    p = Pool(**data)
    db.add(p)
    db.commit()
    db.refresh(p)
    return p


def update_pool(db: Session, pool_id: int, data: dict) -> Pool:
    p = get_pool(db, pool_id)
    for k, v in data.items():
        if v is not None and hasattr(p, k):
            setattr(p, k, v)
    db.commit()
    db.refresh(p)
    return p


def delete_pool(db: Session, pool_id: int) -> None:
    p = get_pool(db, pool_id)
    db.delete(p)
    db.commit()


def list_items(db: Session, pool_id: int, *, q: str = "",
               limit: int = 100, offset: int = 0) -> dict:
    stmt = select(PoolItem).where(PoolItem.pool_id == pool_id)
    count_stmt = select(func.count()).select_from(PoolItem).where(PoolItem.pool_id == pool_id)
    if q:
        like = f"%{q}%"
        stmt = stmt.where(PoolItem.label.like(like) | PoolItem.tags.like(like))
        count_stmt = count_stmt.where(PoolItem.label.like(like) | PoolItem.tags.like(like))
    total = int(db.scalar(count_stmt) or 0)
    rows = db.scalars(stmt.order_by(PoolItem.id).limit(min(500, limit)).offset(offset)).all()
    return {"total": total, "items": [
        {"id": it.id, "pool_id": it.pool_id, "label": it.label, "tags": it.tags,
         "weight": it.weight, "enabled": it.enabled} for it in rows]}


def add_item(db: Session, pool_id: int, data: dict) -> PoolItem:
    get_pool(db, pool_id)
    it = PoolItem(pool_id=pool_id, label=data["label"], tags=data.get("tags", ""),
                  weight=data.get("weight", 1.0), enabled=data.get("enabled", True),
                  content_hash=_hash(data["label"], data.get("tags", "")))
    db.add(it)
    db.commit()
    db.refresh(it)
    return it


def toggle_item(db: Session, item_id: int, enabled: bool) -> None:
    it = db.get(PoolItem, item_id)
    if not it:
        raise NotFoundError(f"条目不存在: id={item_id}")
    it.enabled = enabled
    db.commit()


def delete_item(db: Session, item_id: int) -> None:
    it = db.get(PoolItem, item_id)
    if not it:
        raise NotFoundError(f"条目不存在: id={item_id}")
    db.delete(it)
    db.commit()


def pools_for_draw(db: Session, slugs: list[str] | None = None,
                   *, include_disabled_pool: bool = False) -> list[PoolData]:
    """把 DB 里的启用的池组装成 core 需要的 PoolData。"""
    stmt = select(Pool)
    if not include_disabled_pool:
        stmt = stmt.where(Pool.enabled.is_(True))
    if slugs:
        stmt = stmt.where(Pool.slug.in_(slugs))
    pools = db.scalars(stmt.order_by(Pool.id)).all()
    result: list[PoolData] = []
    for p in pools:
        rows = db.execute(
            select(PoolItem.label, PoolItem.tags).where(
                PoolItem.pool_id == p.id, PoolItem.enabled.is_(True))
            .order_by(PoolItem.id)).all()
        if rows:
            result.append(PoolData(p.slug, p.kind, p.source_ref,
                                   [Item(r[0], r[1]) for r in rows]))
    return result


# ---------------- 导入 ----------------

def _upsert_pool(db: Session, *, slug: str, name: str, kind: str,
                 source: str, source_ref: str, enabled: bool = True) -> Pool | None:
    if db.scalar(select(Pool).where(Pool.slug == slug)):
        return None
    p = Pool(slug=slug, name=name, kind=kind, source=source,
             source_ref=source_ref, enabled=enabled)
    db.add(p)
    db.flush()
    return p


def _insert_items(db: Session, pool: Pool, items: list[Item]) -> int:
    seen: set[str] = set()
    mappings = []
    for it in items:
        h = _hash(it.label, it.tags)
        if h in seen:
            continue
        seen.add(h)
        mappings.append({"pool_id": pool.id, "label": it.label, "tags": it.tags,
                         "payload_json": "{}", "weight": 1.0, "enabled": True,
                         "content_hash": h})
    if mappings:
        db.bulk_insert_mappings(PoolItem, mappings)
    return len(mappings)


def _batch(db: Session, source: Path, kind: str, slug: str, count: int) -> None:
    checksum = ""
    if source.is_file():
        checksum = hashlib.sha256(source.read_bytes()).hexdigest()[:32]
    db.add(ImportBatch(source_path=str(source), kind=kind, pool_slug=slug,
                       item_count=count, checksum=checksum))


def _slugify(text: str) -> str:
    # 保留冒号作为「来源:池名」的分隔符，便于按前缀回滚导入批次
    return re.sub(r"[^\w\u4e00-\u9fff./: -]+", "_", text).strip("_")[:150]


def import_json_file(db: Session, path: Path, *, enabled: bool = True,
                     prefix: str | None = None) -> dict:
    """任意结构 JSON → 若干个卡池。"""
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    stem = prefix or path.stem
    pools = discover_pools(data, str(path), stem)
    created, total = 0, 0
    for p in pools:
        slug = _slugify(f"{stem}:{p.name}")
        pool = _upsert_pool(db, slug=slug, name=p.name, kind=p.friendly,
                            source="json", source_ref=str(path), enabled=enabled)
        if pool is None:
            continue
        total += _insert_items(db, pool, p.items)
        created += 1
    _batch(db, path, "json", f"{stem}:*", total)
    db.commit()
    return {"file": str(path), "pools": created, "items": total}


def import_csv_file(db: Session, path: Path, *, enabled: bool = True) -> dict:
    """两列 CSV：中文名, 英文 tag。"""
    items: list[Item] = []
    with path.open("r", encoding="utf-8-sig", newline="") as fh:
        for row in csv.reader(fh):
            if len(row) >= 2 and row[0].strip():
                items.append(Item(row[0].strip(), row[1].strip()))
    slug = _slugify(f"csv:{path.stem}")
    pool = _upsert_pool(db, slug=slug, name=path.stem, kind="角色",
                        source="csv", source_ref=str(path), enabled=enabled)
    count = _insert_items(db, pool, items) if pool else 0
    _batch(db, path, "csv", slug, count)
    db.commit()
    return {"file": str(path), "pools": 1 if pool else 0, "items": count}


def import_artists(db: Session, path: Path) -> dict:
    """noobai_data.json 的 artists[] → 画师卡池（图鉴并入）。"""
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    items = [Item(str(a.get("name", "")).strip(), str(a.get("name", "")).strip())
             for a in data.get("artists", []) if isinstance(a, dict) and a.get("name")]
    slug = "gallery:artists"
    pool = _upsert_pool(db, slug=slug, name="画师图鉴", kind="画师",
                        source="gallery", source_ref=str(path))
    count = _insert_items(db, pool, items) if pool else 0
    _batch(db, path, "gallery", slug, count)
    db.commit()
    return {"file": str(path), "pools": 1 if pool else 0, "items": count}


def import_wildcards(db: Session, root: Path) -> dict:
    """词卡库每个 .txt = 一个池。"""
    if not root.is_dir():
        return {"file": str(root), "pools": 0, "items": 0, "skipped": True}
    pools = wc_core.scan(str(root))
    created, total = 0, 0
    for p in pools:
        slug = _slugify(f"wc:{p.name}")
        pool = _upsert_pool(db, slug=slug, name=p.name, kind=p.friendly,
                            source="wildcards", source_ref=p.source)
        if pool is None:
            continue
        total += _insert_items(db, pool, p.items)
        created += 1
    _batch(db, root, "wildcards", "wc:*", total)
    db.commit()
    return {"file": str(root), "pools": created, "items": total}


def import_combos(db: Session, folder: Path) -> dict:
    """旧 combos/*.json 配方迁入 recipes 表（由 draws 服务处理，这里只返回内容）。"""
    out = []
    if not folder.is_dir():
        return {"file": str(folder), "recipes": 0, "skipped": True}
    for fp in sorted(folder.glob("*.json")):
        try:
            out.append(json.loads(fp.read_text(encoding="utf-8-sig")))
        except Exception:
            continue
    return {"file": str(folder), "recipes": len(out), "items": out}


def list_batches(db: Session) -> list[dict]:
    rows = db.scalars(select(ImportBatch).order_by(ImportBatch.id.desc())).all()
    return [{"id": b.id, "source_path": b.source_path, "kind": b.kind,
             "pool_slug": b.pool_slug, "item_count": b.item_count,
             "created_at": b.created_at.isoformat(timespec="seconds")} for b in rows]


def rollback_batch(db: Session, batch_id: int) -> dict:
    b = db.get(ImportBatch, batch_id)
    if not b:
        raise NotFoundError(f"导入批次不存在: {batch_id}")
    stmt = select(Pool)
    if b.pool_slug.endswith("*"):
        stmt = stmt.where(Pool.slug.like(b.pool_slug.replace("*", "%")))
    elif b.pool_slug:
        stmt = stmt.where(Pool.slug == b.pool_slug)
    else:
        stmt = stmt.where(Pool.source_ref == b.source_path)
    pools = db.scalars(stmt).all()
    for p in pools:
        db.delete(p)
    db.delete(b)
    db.commit()
    return {"removed_pools": len(pools), "batch_id": batch_id}


def import_path(db: Session, raw_path: str, *, kind: str = "auto",
                pool_slug: str = "") -> dict:
    """供 /api/pools/import 使用；路径只允许项目根目录内，防越权读取。"""
    from ..config import get_settings
    root = get_settings().root.resolve()
    p = Path(raw_path)
    p = (p if p.is_absolute() else root / p).resolve()
    if root not in p.parents and p != root:
        raise ConflictError("导入路径必须位于项目目录内")
    if not p.exists():
        raise NotFoundError(f"路径不存在: {p}")
    if p.is_dir():
        return import_wildcards(db, p)
    suffix = p.suffix.lower()
    if suffix == ".csv":
        return import_csv_file(db, p)
    if suffix == ".json":
        if kind == "artists" or p.name == "noobai_data.json":
            return import_artists(db, p)
        return import_json_file(db, p)
    raise ConflictError(f"不支持的文件类型: {suffix}")
