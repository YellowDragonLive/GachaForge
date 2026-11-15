# -*- coding: utf-8 -*-
"""图片资产：落盘、缩略图、画廊查询、外部图鉴目录注册、元数据导出。

v2：业务元数据写入 image_assets 关系表，不再塞 images.meta_json；
出图落库同时增量维护概念索引；评分 / 收藏变化后重算受影响概念的封面。
"""
from __future__ import annotations

import hashlib
from datetime import datetime
from pathlib import Path

from PIL import Image
from sqlalchemy import select
from sqlalchemy.orm import Session, object_session

from ..config import get_settings
from ..errors import NotFoundError
from ..models import Draw, GenerationJob, Image as ImageRow, ImageAsset
from . import concepts as concept_svc

IMG_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".gif")
THUMB_MAX = 360


def _thumb(data: bytes, dest: Path) -> tuple[int, int]:
    import io
    img = Image.open(io.BytesIO(data))
    img.load()
    width, height = img.size
    thumb = img.convert("RGB")
    thumb.thumbnail((THUMB_MAX, THUMB_MAX), Image.LANCZOS)
    dest.parent.mkdir(parents=True, exist_ok=True)
    thumb.save(dest, format="JPEG", quality=82)
    return width, height


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def save_result(db: Session, job: GenerationJob, data: bytes,
                *, index: int = 0) -> dict:
    """把 ComfyUI 返回的图片字节写入 data/outputs/ 并注册到 images 表。"""
    s = get_settings()
    draw = db.get(Draw, job.draw_id)
    day = datetime.now().strftime("%Y%m%d")
    outdir = s.outputs_dir / day / f"session_{draw.session_id if draw else 0}"
    outdir.mkdir(parents=True, exist_ok=True)
    digest = _sha(data)
    fname = f"draw{draw.id if draw else 0}_{job.id}_{index}_{digest[:10]}.png"
    fpath = outdir / fname
    fpath.write_bytes(data)
    tpath = s.thumbs_dir / f"{digest[:24]}.jpg"
    try:
        width, height = _thumb(data, tpath)
        thumb_str = str(tpath)
    except Exception:
        width, height, thumb_str = 0, 0, ""
    row = ImageRow(
        job_id=job.id, origin="generated", status="active", file_path=str(fpath),
        thumb_path=thumb_str, width=width, height=height,
        file_size=len(data), sha256=digest)
    db.add(row)
    db.flush()
    db.add(ImageAsset(
        image_id=row.id, job_id=job.id,
        draw_id=draw.id if draw else None,
        session_id=draw.session_id if draw else None,
        prompt=draw.prompt if draw else "", seed=draw.seed if draw else None,
        comfy_prompt_id=job.comfy_prompt_id, source=str(fpath), name=fname))
    db.flush()
    try:
        concept_svc.index_image(db, row.id)
    except Exception as exc:  # 概念索引是增强能力，绝不拖垮出图主流程
        from ..logging import emit
        emit("WARNING", "concepts", f"图 {row.id} 概念索引写入失败: {exc}")
    return image_out(row)


def image_out(row: ImageRow) -> dict:
    asset = _asset(row)
    meta = {"job_id": row.job_id,
            "draw_id": asset.draw_id if asset else None,
            "session_id": asset.session_id if asset else None,
            "prompt": asset.prompt if asset else "",
            "seed": asset.seed if asset else None,
            "comfy_prompt_id": asset.comfy_prompt_id if asset else ""}
    if asset and asset.source:
        meta["source"] = asset.source
        meta["name"] = asset.name
    return {"id": row.id, "job_id": row.job_id, "origin": row.origin,
            "status": row.status,
            "width": row.width, "height": row.height, "file_size": row.file_size,
            "sha256": row.sha256, "rating": row.rating,
            "favorite": row.favorite, "note": row.note,
            "created_at": row.created_at.isoformat(timespec="seconds"),
            "meta": meta}


def _asset(row: ImageRow) -> ImageAsset | None:
    """从 ORM 对象所属的 session 里取关系化的业务元数据。"""
    db = object_session(row)
    if db is None or row.id is None:
        return None
    return db.scalar(select(ImageAsset).where(ImageAsset.image_id == row.id))


def list_images(db: Session, *, favorite: bool | None = None,
                min_rating: int = 0, origin: str = "",
                q: str = "", limit: int = 120, offset: int = 0) -> dict:
    stmt = select(ImageRow).order_by(ImageRow.id.desc())
    if favorite is not None:
        stmt = stmt.where(ImageRow.favorite.is_(favorite))
    if min_rating:
        stmt = stmt.where(ImageRow.rating >= min_rating)
    if origin:
        stmt = stmt.where(ImageRow.origin == origin)
    if q:
        ids = db.scalars(select(ImageAsset.image_id).where(
            ImageAsset.prompt.like(f"%{q}%") | ImageAsset.name.like(f"%{q}%"))).all()
        stmt = stmt.where(ImageRow.id.in_(list(ids) or [-1]))
    total = len(db.scalars(stmt).all())
    rows = db.scalars(stmt.limit(min(300, limit)).offset(offset)).all()
    return {"total": total, "items": [image_out(r) for r in rows]}


def get_image(db: Session, image_id: int) -> ImageRow:
    row = db.get(ImageRow, image_id)
    if not row:
        raise NotFoundError(f"图片不存在: id={image_id}")
    return row


def patch_image(db: Session, image_id: int, data: dict) -> dict:
    row = get_image(db, image_id)
    for key in ("rating", "favorite", "note"):
        if data.get(key) is not None:
            setattr(row, key, data[key])
    db.flush()
    try:
        concept_svc.refresh_covers(db, image_id)
    except Exception as exc:  # 封面重算失败不影响评分/收藏本身
        from ..logging import emit
        emit("WARNING", "concepts", f"图 {image_id} 封面重算失败: {exc}")
    db.commit()
    return image_out(row)


def register_dir(db: Session, raw_path: str, *, limit: int = 2000) -> dict:
    """把历史画师图鉴等外部图片目录注册进画廊（只读扫描，不移动原图）。"""
    root = get_settings().root.resolve()
    p = Path(raw_path)
    p = (p if p.is_absolute() else root / p).resolve()
    if root not in p.parents and p != root:
        raise NotFoundError("图片目录必须位于项目目录内")
    if not p.is_dir():
        raise NotFoundError(f"目录不存在: {p}")
    existing = {r[0] for r in db.execute(select(ImageRow.file_path)).all()}
    added = 0
    for fp in sorted(p.rglob("*")):
        if added >= limit:
            break
        if fp.suffix.lower() not in IMG_EXTS or not fp.is_file():
            continue
        sp = str(fp)
        if sp in existing:
            continue
        try:
            data = fp.read_bytes()
            digest = _sha(data)
            tpath = get_settings().thumbs_dir / f"gallery_{digest[:24]}.jpg"
            width, height = _thumb(data, tpath)
            thumb_str = str(tpath)
        except Exception:
            width, height, digest, thumb_str = 0, 0, "", ""
        row = ImageRow(origin="gallery", status="active", file_path=sp,
                       thumb_path=thumb_str, width=width, height=height,
                       file_size=fp.stat().st_size, sha256=digest)
        db.add(row)
        db.flush()
        db.add(ImageAsset(image_id=row.id, source=sp, name=fp.name))
        added += 1
    db.commit()
    return {"dir": str(p), "added": added}


def export_meta(db: Session, ids: list[int]) -> list[dict]:
    out = []
    for iid in ids:
        try:
            out.append(image_out(get_image(db, iid)))
        except NotFoundError:
            continue
    return out
