# -*- coding: utf-8 -*-
"""生成任务编排：幂等提交、取消、重试、重启恢复。"""
from __future__ import annotations

import json
import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..errors import JobStateError, NotFoundError
from ..models import Draw, GenerationJob, JobSnapshot
from . import draws as draw_svc

ACTIVE = ("queued", "submitted", "running", "cancelling")
TERMINAL = ("succeeded", "failed", "cancelled", "dead")


def job_out(row: GenerationJob) -> dict:
    return {"id": row.id, "draw_id": row.draw_id,
            "comfy_prompt_id": row.comfy_prompt_id, "status": row.status,
            "progress": row.progress, "step": row.step,
            "steps_total": row.steps_total, "retry_count": row.retry_count,
            "error_code": row.error_code, "error_message": row.error_message,
            "created_at": row.created_at.isoformat(timespec="seconds"),
            "started_at": row.started_at.isoformat(timespec="seconds") if row.started_at else None,
            "finished_at": row.finished_at.isoformat(timespec="seconds") if row.finished_at else None}


def get_job(db: Session, job_id: int) -> GenerationJob:
    row = db.get(GenerationJob, job_id)
    if not row:
        raise NotFoundError(f"任务不存在: id={job_id}")
    return row


def list_jobs(db: Session, *, limit: int = 100) -> list[dict]:
    rows = db.scalars(select(GenerationJob).order_by(GenerationJob.id.desc())
                      .limit(min(300, limit))).all()
    return [job_out(r) for r in rows]


def submit_jobs(db: Session, draw_ids: list[int], *,
                gen_profile_id: int | None = None, force: bool = False) -> dict:
    """每个 draw 一个任务；相同 draw+参数 默认复用（幂等），force=True 才重开。"""
    created, reused = [], []
    for did in draw_ids:
        draw = db.get(Draw, did)
        if not draw:
            raise NotFoundError(f"抽卡结果不存在: id={did}")
        profile = draw_svc.resolve_profile(db, gen_profile_id)
        key = f"d{did}:p{profile['id']}:{profile.get('workflow', '')}"
        if not force:
            existing = db.scalar(select(GenerationJob).where(
                GenerationJob.idempotency_key == key))
            if existing:
                reused.append(existing.id)
                continue
        if force:
            key = f"{key}:r{uuid.uuid4().hex[:8]}"
        row = GenerationJob(draw_id=did, status="queued", idempotency_key=key)
        db.add(row)
        db.flush()
        # 参数快照写在这个 Job 上，而不是 session 上——这样同一 Draw 用不同
        # workflow 重跑时，每个 Job 都带着自己当时的真实参数（修复假覆盖）。
        db.add(JobSnapshot(
            job_id=row.id,
            workflow=str(profile.get("workflow") or "sdxl_minimal.json"),
            profile_json=json.dumps(profile, ensure_ascii=False),
            prompt=draw.prompt, negative=draw.negative, seed=draw.seed))
        created.append(row.id)
    db.commit()
    return {"created": created, "reused": reused,
            "job_ids": created + reused}


def cancel_job(db: Session, job_id: int) -> dict:
    row = get_job(db, job_id)
    if row.status in TERMINAL:
        raise JobStateError(f"任务已结束，无法取消: {row.status}")
    row.status = "cancelling" if row.status in ("running", "submitted") else "cancelled"
    db.commit()
    return job_out(row)


def retry_job(db: Session, job_id: int) -> dict:
    row = get_job(db, job_id)
    if row.status in ACTIVE:
        raise JobStateError("任务进行中，无需重试")
    row.status = "queued"
    row.retry_count = 0
    row.progress = 0
    row.error_code = ""
    row.error_message = ""
    row.finished_at = None
    db.commit()
    return job_out(row)


def recover_jobs(db: Session) -> int:
    """进程重启后，把未完成的任务放回队列（幂等，由 Worker 重新处理）。"""
    rows = db.scalars(select(GenerationJob).where(
        GenerationJob.status.in_(("submitted", "running", "cancelling")))).all()
    for row in rows:
        row.status = "queued"
        row.started_at = None
        row.progress = 0
    db.commit()
    return len(rows)
