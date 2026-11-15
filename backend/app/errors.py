# -*- coding: utf-8 -*-
"""类型化错误 + 统一响应结构。客户端永远只看到 {ok,data,error}。"""
from __future__ import annotations

from typing import Any


class AppError(Exception):
    status = 500
    code = "internal_error"

    def __init__(self, message: str, *, code: str | None = None,
                 status: int | None = None, details: Any = None):
        super().__init__(message)
        self.message = message
        if code:
            self.code = code
        if status:
            self.status = status
        self.details = details


class BadRequestError(AppError):
    status = 400
    code = "bad_request"


class NotFoundError(AppError):
    status = 404
    code = "not_found"


class ConflictError(AppError):
    status = 409
    code = "conflict"


class ComfyUnavailableError(AppError):
    status = 503
    code = "comfy_unavailable"


class JobStateError(AppError):
    status = 409
    code = "invalid_job_state"


def ok(data: Any = None) -> dict:
    return {"ok": True, "data": data}


def fail_payload(err: AppError, request_id: str) -> dict:
    body: dict[str, Any] = {
        "ok": False,
        "error": {"code": err.code, "message": err.message, "request_id": request_id},
    }
    if err.details is not None:
        body["error"]["details"] = err.details
    return body
