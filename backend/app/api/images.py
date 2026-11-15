# -*- coding: utf-8 -*-
"""画廊接口：查询、原图/缩略图、标注、外部目录注册、导出。"""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..errors import ok
from ..schemas import ImagePatch, ScanDirIn
from ..services import images as svc

router = APIRouter(prefix="/api/images", tags=["images"])


def _safe_file(raw: str) -> Path:
    """只允许读取项目目录、配置的输出目录与缩略图目录下的文件。

    输出目录由用户配置，可能在项目之外（例如大图放别的盘），
    因此不能只校验项目根；但也不能放行任意路径，避免路径穿越读文件。
    """
    s = get_settings()
    p = Path(raw).resolve()
    allowed = (s.root.resolve(), s.outputs_dir.resolve(), s.thumbs_dir.resolve())
    if not p.is_file() or not any(base == p or base in p.parents for base in allowed):
        raise HTTPException(status_code=404, detail="image not found")
    return p


@router.get("")
def list_images(favorite: bool | None = None, min_rating: int = 0,
                origin: str = "", q: str = "",
                limit: int = Query(120, le=300), offset: int = 0,
                db: Session = Depends(get_db)):
    return ok(svc.list_images(db, favorite=favorite, min_rating=min_rating,
                              origin=origin, q=q, limit=limit, offset=offset))


@router.post("/register-dir")
def register_dir(body: ScanDirIn, db: Session = Depends(get_db)):
    return ok(svc.register_dir(db, body.path))


@router.get("/export")
def export(ids: str = "", db: Session = Depends(get_db)):
    parsed = [int(x) for x in ids.split(",") if x.strip().isdigit()]
    return ok(svc.export_meta(db, parsed))


@router.get("/{image_id}")
def get_image(image_id: int, db: Session = Depends(get_db)):
    return ok(svc.image_out(svc.get_image(db, image_id)))


@router.patch("/{image_id}")
def patch_image(image_id: int, body: ImagePatch, db: Session = Depends(get_db)):
    return ok(svc.patch_image(db, image_id, body.model_dump(exclude_none=True)))


@router.get("/{image_id}/file")
def image_file(image_id: int, db: Session = Depends(get_db)):
    row = svc.get_image(db, image_id)
    return FileResponse(_safe_file(row.file_path))


@router.get("/{image_id}/thumb")
def image_thumb(image_id: int, db: Session = Depends(get_db)):
    row = svc.get_image(db, image_id)
    path = row.thumb_path or row.file_path
    return FileResponse(_safe_file(path))
