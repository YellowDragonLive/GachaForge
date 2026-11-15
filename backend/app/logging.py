# -*- coding: utf-8 -*-
"""结构化 JSON 日志 + 内存环形缓冲（供 /api/logs 查看）。

日志不记录令牌、密钥与提示词全文；只记长度与摘要。
"""
from __future__ import annotations

import collections
import datetime
import json
import logging
import sys
import threading
import uuid

_RING: collections.deque[dict] = collections.deque(maxlen=400)
_LOCK = threading.Lock()
_CONFIGURED = False

_LEVEL_MAP = {"DEBUG": logging.DEBUG, "INFO": logging.INFO,
              "WARNING": logging.WARNING, "ERROR": logging.ERROR}


def configure(level: str = "INFO") -> None:
    global _CONFIGURED
    if _CONFIGURED:
        return
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter("%(message)s"))
    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(_LEVEL_MAP.get(level.upper(), logging.INFO))
    _CONFIGURED = True


def new_request_id() -> str:
    return uuid.uuid4().hex[:12]


def emit(level: str, feature: str, message: str, *,
         request_id: str = "-", **fields) -> dict:
    entry = {
        "ts": datetime.datetime.now().isoformat(timespec="seconds"),
        "level": level.upper(),
        "feature": feature,
        "message": str(message)[:600],
        "request_id": request_id,
    }
    for k, v in fields.items():
        if k not in ("token", "password", "secret"):
            entry[k] = v
    with _LOCK:
        _RING.append(entry)
    logging.getLogger("gacha").log(
        _LEVEL_MAP.get(level.upper(), logging.INFO),
        json.dumps(entry, ensure_ascii=False))
    return entry


def recent(n: int = 200) -> list[dict]:
    n = max(1, min(400, int(n)))
    with _LOCK:
        return list(_RING)[-n:]
