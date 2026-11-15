# -*- coding: utf-8 -*-
"""生成任务接口 + SSE 进度流。"""
from __future__ import annotations

import json

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..errors import ComfyUnavailableError, ok
from ..schemas import JobsIn
from ..services import generation as svc
from ..services.comfy import ComfyClient
from ..worker import bus

router = APIRouter(prefix="/api/jobs", tags=["jobs"])


@router.get("")
def list_jobs(db: Session = Depends(get_db)):
    return ok(svc.list_jobs(db))


@router.post("")
def submit_jobs(body: JobsIn, db: Session = Depends(get_db)):
    s = get_settings()
    if not s.comfy_mock and not ComfyClient(s).status().get("online"):
        raise ComfyUnavailableError("ComfyUI 未运行，无法提交生图任务；可先只抽卡，或启用 mock 模式")
    return ok(svc.submit_jobs(db, body.draw_ids,
                              gen_profile_id=body.gen_profile_id,
                              force=body.force))


@router.get("/stream")
def stream():
    """SSE：任务状态与进度；15 秒心跳，浏览器断线自动重连。"""
    def gen():
        q = bus.subscribe()
        try:
            yield "event: hello\ndata: {\"ok\":true}\n\n"
            while True:
                try:
                    event = q.get(timeout=15)
                    yield "data: " + json.dumps(event, ensure_ascii=False) + "\n\n"
                except Exception:
                    yield ": ping\n\n"
        finally:
            bus.unsubscribe(q)
    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "Connection": "keep-alive",
                                      "X-Accel-Buffering": "no"})


@router.get("/{job_id}")
def get_job(job_id: int, db: Session = Depends(get_db)):
    return ok(svc.job_out(svc.get_job(db, job_id)))


@router.post("/{job_id}/cancel")
def cancel_job(job_id: int, db: Session = Depends(get_db)):
    return ok(svc.cancel_job(db, job_id))


@router.post("/{job_id}/retry")
def retry_job(job_id: int, db: Session = Depends(get_db)):
    return ok(svc.retry_job(db, job_id))
