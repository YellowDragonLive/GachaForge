# -*- coding: utf-8 -*-
"""Uvicorn 启动器：端口/地址统一从 .env 读取，并自动打开浏览器。

由 scripts/start.bat 调用；不要手工拼 uvicorn 命令。
"""
from __future__ import annotations

import sys
import threading
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import uvicorn  # noqa: E402

from backend.app.config import get_settings  # noqa: E402
from backend.app.main import app  # noqa: E402


def main() -> int:
    s = get_settings()
    s.validate()
    url = f"http://{s.host}:{s.port}/"
    print(f"[run] {url}  (comfy_mock={s.comfy_mock}, comfy={s.comfy_url})")
    threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    uvicorn.run(app, host=s.host, port=s.port, log_level="warning")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
