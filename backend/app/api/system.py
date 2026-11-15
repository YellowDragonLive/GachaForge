# -*- coding: utf-8 -*-
"""健康检查、配置、ComfyUI 状态与日志。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..errors import ok
from ..logging import recent
from ..models import EventLog, Pool, Recipe
from ..services.comfy import ComfyClient

router = APIRouter(tags=["system"])


@router.get("/health")
def health():
    return ok({"status": "ok", "service": "gacha-studio"})


@router.get("/ready")
def ready(db: Session = Depends(get_db)):
    s = get_settings()
    comfy = ComfyClient(s).status()
    return ok({"db": s.db_path.is_file(), "workflows": len(list(s.workflow_dir.glob("*.json"))),
               "comfy": comfy,
               "counts": {"pools": len(db.scalars(select(Pool)).all()),
                          "recipes": len(db.scalars(select(Recipe)).all())}})


@router.get("/api/config")
def config():
    return ok(get_settings().public())


@router.get("/api/comfy/status")
def comfy_status():
    return ok(ComfyClient().status())


@router.get("/api/comfy/models")
def comfy_models():
    return ok(ComfyClient().models())


@router.get("/api/logs")
def logs(n: int = Query(200, ge=1, le=400), db: Session = Depends(get_db)):
    rows = db.scalars(select(EventLog).order_by(EventLog.id.desc()).limit(50)).all()
    persisted = [{"ts": r.created_at.isoformat(timespec="seconds"), "level": r.level,
                  "feature": r.feature, "message": r.message_json} for r in rows]
    return ok({"recent": recent(n), "persisted": persisted})
