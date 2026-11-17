# -*- coding: utf-8 -*-
"""探测抽卡服务是否已经在监听（双击 start.bat 时防重复启动）。

根因：服务已在 8765 跑着时再双击 start.bat，uvicorn 绑不上端口会直接退出，
bat 又直接 goto :eof —— 用户看到的就是「窗口一闪而过」，连错误都看不清。
start.bat 在真正起服务前先调用本脚本：已运行就提示并停下，没运行才继续。

退出码：0 = 已在运行（--open 时顺手打开浏览器）；1 = 没在跑 / 配置不可用。
不打印 traceback：调用方只看退出码，详细错误交给 run_server.py 去报。
"""
from __future__ import annotations

import socket
import sys
import threading
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def main(argv: list[str]) -> int:
    try:
        from backend.app.config import get_settings

        s = get_settings()
        port = int(s.port)
    except Exception:
        return 1
    # 0.0.0.0 / :: 是监听地址，不是可连接地址
    host = "127.0.0.1" if s.host in ("0.0.0.0", "::") else s.host
    try:
        with socket.create_connection((host, port), timeout=1.5):
            pass
    except OSError:
        return 1
    url = f"http://{s.host}:{port}/"
    print(url)
    if "--open" in argv:
        threading.Timer(0.2, lambda: webbrowser.open(url)).start()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
