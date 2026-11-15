# -*- coding: utf-8 -*-
"""抽卡会话接口。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from ..db import get_db
from ..errors import ok
from ..schemas import DrawSessionIn
from ..services import draws as svc

router = APIRouter(prefix="/api", tags=["draws"])


@router.post("/draw-sessions")
def create_session(body: DrawSessionIn, db: Session = Depends(get_db)):
    return ok(svc.create_session(db, body.model_dump()))


@router.get("/draw-sessions/{session_id}")
def get_session(session_id: int, db: Session = Depends(get_db)):
    return ok(svc.get_session(db, session_id))


@router.get("/draws")
def list_draws(session_id: int | None = None,
               limit: int = Query(200, le=500), db: Session = Depends(get_db)):
    return ok(svc.list_draws(db, session_id=session_id, limit=limit))


@router.get("/draws/status")
def draw_states(draw_ids: str = Query("", description="逗号分隔的 draw id"),
                db: Session = Depends(get_db)):
    """结果卡片内联状态：一次拿回每抽的最新任务与已出图片。"""
    return ok(svc.draw_states(db, [x for x in draw_ids.split(",") if x.strip()]))
