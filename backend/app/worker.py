# -*- coding: utf-8 -*-
"""后台生成 Worker：串行消费任务队列，进度经 EventBus 推给 SSE 订阅者。

任务状态机：queued → submitted → running → succeeded / cancelled / dead
网络/执行错误自动重试 ≤3 次（指数退避），超限进死信并保留错误信息。
"""
from __future__ import annotations

import json
import queue
import threading
import time
import traceback

from sqlalchemy import select

from .config import get_settings
from .db import SessionLocal
from .logging import emit
from .models import Draw, EventLog, GenerationJob
from .services import draws as draw_svc
from .services import generation as job_svc
from .services import images as image_svc
from .services.comfy import CancelledError, ComfyClient, ComfyError


class EventBus:
    def __init__(self) -> None:
        self._subs: list[queue.Queue] = []
        self._lock = threading.Lock()

    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=200)
        with self._lock:
            self._subs.append(q)
        return q

    def unsubscribe(self, q: queue.Queue) -> None:
        with self._lock:
            if q in self._subs:
                self._subs.remove(q)

    def publish(self, event: dict) -> None:
        with self._lock:
            subs = list(self._subs)
        for q in subs:
            try:
                q.put_nowait(event)
            except queue.Full:
                pass


bus = EventBus()


class GenerationWorker(threading.Thread):
    def __init__(self, settings=None):
        super().__init__(name="gacha-worker", daemon=True)
        self.s = settings or get_settings()
        self._stop = threading.Event()

    def stop(self) -> None:
        self._stop.set()

    def run(self) -> None:
        db = SessionLocal()
        try:
            n = job_svc.recover_jobs(db)
            if n:
                emit("INFO", "worker", f"恢复未完成任务 {n} 个")
        finally:
            db.close()
        emit("INFO", "worker", "后台生成 Worker 已启动",
             mock=self.s.comfy_mock, comfy_url=self.s.comfy_url)
        while not self._stop.is_set():
            db = SessionLocal()
            try:
                row = db.scalar(select(GenerationJob)
                                .where(GenerationJob.status == "queued")
                                .order_by(GenerationJob.id).limit(1))
                job_id = row.id if row else None
            finally:
                db.close()
            if job_id is None:
                self._stop.wait(self.s.worker_poll)
                continue
            try:
                self._process(job_id)
            except Exception as exc:  # 兜底，避免 Worker 线程意外退出
                emit("ERROR", "worker", f"任务 {job_id} 处理异常: {exc}",
                     trace=traceback.format_exc()[-600:])

    # ---------- 状态与事件 ----------
    @staticmethod
    def _set(db, row: GenerationJob, status: str, **fields) -> None:
        row.status = status
        for k, v in fields.items():
            setattr(row, k, v)
        if status in ("succeeded", "failed", "cancelled", "dead"):
            from .models import now
            row.finished_at = now()
        db.add(EventLog(level="ERROR" if status in ("failed", "dead") else "INFO",
                        feature="job",
                        message_json=json.dumps({"job_id": row.id, "status": status,
                                                 "progress": row.progress},
                                                ensure_ascii=False)))
        db.commit()
        bus.publish({"type": "job", "job_id": row.id, "status": status,
                     "progress": row.progress, "step": row.step,
                     "steps_total": row.steps_total,
                     "retry_count": row.retry_count,
                     "error": row.error_message})

    def _process(self, job_id: int) -> None:
        db = SessionLocal()
        client = ComfyClient(self.s)
        try:
            row = db.get(GenerationJob, job_id)
            if row is None or row.status != "queued":
                return
            from .models import now
            row.started_at = now()
            self._set(db, row, "submitted", progress=0)

            draw = db.get(Draw, row.draw_id)
            if draw is None:
                raise ComfyError("关联的抽卡结果已不存在")
            profile = draw_svc.session_profile_dict(db, draw.session_id)
            seed = draw.seed if draw.seed is not None else (row.id * 7919)
            prefix = f"gacha_s{draw.session_id}_d{draw.id}"

            workflow = client.build_workflow(
                profile=profile, prompt=draw.prompt, negative=draw.negative,
                seed=seed, workflow_name=profile.get("workflow") or "sdxl_minimal.json",
                prefix=prefix)
            prompt_id = client.submit(workflow)
            row.comfy_prompt_id = prompt_id
            self._set(db, row, "running", progress=1)
            emit("INFO", "job", f"任务 {job_id} 已提交 ComfyUI",
                 prompt_id=prompt_id, seed=seed,
                 workflow=profile.get("workflow", ""))

            def on_progress(step: int, total: int, phase: str) -> None:
                pct = int(step / total * 100) if total else 0
                row.step, row.steps_total, row.progress = step, total, min(99, pct)
                db.commit()
                bus.publish({"type": "progress", "job_id": job_id,
                             "status": "running", "progress": row.progress,
                             "step": step, "steps_total": total, "phase": phase,
                             "retry_count": row.retry_count, "error": ""})

            def cancel_check() -> bool:
                db.refresh(row)
                return row.status in ("cancelling", "cancelled")

            results = client.wait_result(
                prompt_id, on_progress=on_progress, cancel_check=cancel_check,
                timeout=self.s.comfy_timeout)
            image_ids = []
            for i, data in enumerate(results):
                img = image_svc.save_result(db, row, data, index=i)
                image_ids.append(img["id"])
            db.commit()
            self._set(db, row, "succeeded", progress=100)
            bus.publish({"type": "job", "job_id": job_id, "status": "succeeded",
                         "progress": 100, "step": row.steps_total,
                         "steps_total": row.steps_total, "image_ids": image_ids,
                         "retry_count": row.retry_count, "error": ""})
            emit("INFO", "job", f"任务 {job_id} 完成，产出 {len(image_ids)} 张图")

        except CancelledError:
            self._set(db, row, "cancelled")
            emit("INFO", "job", f"任务 {job_id} 已取消")
        except Exception as exc:
            retries = (row.retry_count or 0) + 1
            row.retry_count = retries
            row.error_code = "comfy_error" if isinstance(exc, ComfyError) else "worker_error"
            row.error_message = str(exc)[:500]
            if retries < 3:
                self._set(db, row, "queued", progress=0)
                emit("WARNING", "job",
                     f"任务 {job_id} 第 {retries} 次失败，将重试: {str(exc)[:160]}")
                time.sleep(min(6, 2 ** retries))
            else:
                self._set(db, row, "dead")
                emit("ERROR", "job", f"任务 {job_id} 进入死信: {str(exc)[:200]}")
        finally:
            db.close()
