# -*- coding: utf-8 -*-
"""提示词双语补全接口：意群自由输入的中英对照数据源。"""
from __future__ import annotations

from fastapi import APIRouter, Query

from ..core import vocab
from ..errors import AppError, ok

router = APIRouter(prefix="/api/vocab", tags=["vocab"])


def _unavailable(exc: vocab.VocabUnavailable) -> AppError:
    return AppError(str(exc), code="vocab_unavailable", status=503)


@router.get("/status")
def status():
    """词表是否就绪；前端据此显示补全还是降级提示。"""
    return ok(vocab.status())


@router.get("/suggest")
def suggest(q: str = "", limit: int = Query(12, ge=1, le=30)):
    """双语补全：中文输入命中译名、英文输入命中 tag，候选都带 en/zh/display。"""
    try:
        return ok(vocab.suggest(q, limit=limit))
    except vocab.VocabUnavailable as exc:
        raise _unavailable(exc) from exc


@router.get("/translate")
def translate(text: str = Query("", min_length=0)):
    """整段中文 → 英文 tag 串；未命中的词原样保留并在 missing 里列出。"""
    try:
        return ok(vocab.translate(text))
    except vocab.VocabUnavailable as exc:
        raise _unavailable(exc) from exc
