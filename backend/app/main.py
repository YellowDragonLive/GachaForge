# -*- coding: utf-8 -*-
"""应用装配：配置校验、全局错误、请求 ID、Worker 生命周期、静态前端托管。"""
from __future__ import annotations

from contextlib import asynccontextmanager
from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.types import Scope

from .api import concepts, draws, images, jobs, pools, recipes, semantics, system, vocab
from .config import get_settings
from .db import SessionLocal, init_db
from .errors import AppError, fail_payload
from .logging import configure, emit, new_request_id
from .services.draws import ensure_default_profile
from .worker import GenerationWorker


@asynccontextmanager
async def lifespan(app: FastAPI):
    s = get_settings()
    configure(s.log_level)
    s.validate()                       # 环境变量集中校验，失败即退出
    init_db()                          # 兜底建表；正式迁移走 scripts/init_db.py
    db = SessionLocal()
    try:
        ensure_default_profile(db)
    finally:
        db.close()
    worker = GenerationWorker(s)
    worker.start()
    app.state.worker = worker
    emit("INFO", "app", "GachaForge 已启动", host=s.host, port=s.port,
         mock=s.comfy_mock)
    try:
        yield
    finally:
        worker.stop()
        emit("INFO", "app", "GachaForge 已停止")


def create_app() -> FastAPI:
    s = get_settings()
    app = FastAPI(title="GachaForge", version="1.0.0",
                  description="本地 ComfyUI 抽卡生图工具（FastAPI + SQLite + 原生前端）",
                  lifespan=lifespan)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=[f"http://127.0.0.1:{s.port}", f"http://localhost:{s.port}"],
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Content-Type", "X-Request-Id", "X-Gacha-Token"],
    )

    @app.middleware("http")
    async def request_context(request: Request, call_next):
        # 本机若设置了 HTTP_PROXY 且未排除 127.0.0.1，代理会用 absolute-form
        # 请求行（GET http://host/path）转发，这里归一化成 origin-form，避免路由 404。
        raw_path = request.scope.get("path", "")
        if raw_path.startswith(("http://", "https://")):
            parts = urlsplit(raw_path)
            rel = parts.path or "/"
            request.scope["path"] = rel
            request.scope["raw_path"] = rel.encode("utf-8")
            request.scope["query_string"] = parts.query.encode("utf-8")
        rid = request.headers.get("X-Request-Id") or new_request_id()
        request.state.request_id = rid
        if (s.token and request.scope.get("path", "").startswith("/api/")
                and request.headers.get("X-Gacha-Token") != s.token):
            err = AppError("令牌无效", code="unauthorized", status=401)
            return JSONResponse(fail_payload(err, rid), status_code=401)
        response = await call_next(request)
        response.headers["X-Request-Id"] = rid
        return response

    @app.exception_handler(AppError)
    async def app_error_handler(request: Request, exc: AppError):
        rid = getattr(request.state, "request_id", "-")
        emit("WARNING", "api", exc.message, request_id=rid, code=exc.code)
        return JSONResponse(fail_payload(exc, rid), status_code=exc.status)

    @app.exception_handler(RequestValidationError)
    async def validation_handler(request: Request, exc: RequestValidationError):
        rid = getattr(request.state, "request_id", "-")
        err = AppError("请求参数不合法", code="bad_request", status=400,
                       details=[{"loc": list(e["loc"]), "msg": e["msg"]}
                                for e in exc.errors()[:8]])
        return JSONResponse(fail_payload(err, rid), status_code=400)

    @app.exception_handler(Exception)
    async def unknown_handler(request: Request, exc: Exception):
        rid = getattr(request.state, "request_id", "-")
        emit("ERROR", "api", f"未处理异常: {exc}", request_id=rid)
        err = AppError("服务内部错误，请查看日志", code="internal_error", status=500)
        return JSONResponse(fail_payload(err, rid), status_code=500)

    for module in (system, pools, recipes, draws, jobs, images, semantics, concepts, vocab):
        app.include_router(module.router)

    # 前端是零框架静态页，由同一个进程托管，不需要第二个服务。
    # 开发期前后端同进程、改 JS 不重启：必须 no-cache（浏览器每次带 ETag 回源校验，
    # 未变仍是 304，代价可忽略），否则用户刷新拿到的可能是上一版 JS——
    # 「点了没反应 / 一直加载中」多半是这个，而不是真 bug。
    class NoCacheStaticFiles(StaticFiles):
        async def get_response(self, path: str, scope: Scope):
            res = await super().get_response(path, scope)
            res.headers["Cache-Control"] = "no-cache"
            return res

    app.mount("/", NoCacheStaticFiles(directory=str(s.frontend_dir), html=True),
              name="frontend")
    return app


app = create_app()
