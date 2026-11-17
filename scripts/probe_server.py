# -*- coding: utf-8 -*-
"""探测 / 清理抽卡服务占用的端口。

两种用法：
  probe_server.py            探测：0 = 已在运行（--open 顺手开浏览器）；1 = 没在跑。
  probe_server.py --kill     清理：杀掉占着本服务端口的旧进程，0 = 端口空闲可启动。

--kill 存在的原因：双击 start.bat 时若上一次的进程（或后台任务）还占着端口，
uvicorn 报 [Errno 10048] 立刻退出，bat 又把窗口关掉 —— 用户只看到一闪。
与其提示「先手动关掉旧窗口」，不如启动前直接把占端口的旧进程清掉。
只杀命令行含 run_server.py / uvicorn 的进程，绝不误伤同机的 ComfyUI。

不打印 traceback：调用方只看退出码，详细错误交给 run_server.py 去报。
"""
from __future__ import annotations

import subprocess
import socket
import sys
import threading
import time
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def get_addr():
    try:
        from backend.app.config import get_settings
        s = get_settings()
        return s.host, int(s.port)
    except Exception:
        return "127.0.0.1", 8765


def connect_host(host: str) -> str:
    # 0.0.0.0 / :: 是监听地址，不是可连接地址
    return "127.0.0.1" if host in ("0.0.0.0", "::") else host


def is_up(host: str, port: int, timeout: float = 1.5) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def listeners(port: int) -> list[int]:
    """netstat -ano 解析 LISTENING 行；不依赖 psutil。

    netstat 在中文 Windows 输出本地编码，必须防御式解码——字段是 ASCII，
    个别字节解不出不影响解析。之前用 text=True 在这台机器上直接抛 UnicodeDecodeError。
    """
    try:
        out = subprocess.run(
            ["netstat", "-ano", "-p", "tcp"],
            capture_output=True, timeout=15,
        ).stdout or b""
    except Exception:
        return []
    text = out.decode("utf-8", errors="replace")
    pids: set[int] = set()
    for line in text.splitlines():
        parts = line.split()
        if len(parts) >= 5 and parts[3].upper() == "LISTENING" and parts[1].endswith(f":{port}"):
            try:
                pids.add(int(parts[4]))
            except ValueError:
                pass
    return sorted(pids)


def proc_command(pid: int) -> str:
    """只取命令行做归属校验；拿不到就返回空串（宁可跳过，不可误杀）。"""
    ps = (
        '$p=Get-CimInstance Win32_Process -Filter "ProcessId = %d";'
        'if($p){$p.CommandLine}' % pid
    )
    try:
        r = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
            capture_output=True, timeout=15,
        )
        return (r.stdout or b"").decode("utf-8", errors="replace").strip()
    except Exception:
        return ""


def kill_stale(host: str, port: int) -> int:
    pids = listeners(port)
    if not pids:
        print(f"[kill] port {port} free")
        return 0
    killed = False
    for pid in pids:
        cmd = proc_command(pid)
        ours = "run_server.py" in cmd or "uvicorn" in cmd.lower()
        if not ours:
            # 端口恰好被别的程序占了：不替用户做主，报出来让他处理。
            print(f"[kill] SKIP pid {pid} - not the gacha server ({cmd[:120] or 'unknown'})")
            print(f"[kill] port {port} is held by another program; free it manually")
            return 1
        r = subprocess.run(
            ["taskkill", "/PID", str(pid), "/F"],
            capture_output=True, timeout=15,
        )
        msg = ((r.stdout or b"") + (r.stderr or b"")).decode("utf-8", errors="replace").strip()
        print(f"[kill] stopped old server pid {pid}: {msg[:120]}")
        killed = True
    if killed:
        # 等端口真正释放，否则紧接着 uvicorn bind 仍会撞上。
        for _ in range(20):
            if not is_up(connect_host(host), port, 0.3):
                break
            time.sleep(0.25)
    if is_up(connect_host(host), port, 0.5):
        print(f"[kill] port {port} still busy after cleanup")
        return 1
    print(f"[kill] port {port} free - ready to start")
    return 0


def main(argv: list[str]) -> int:
    host, port = get_addr()
    connect = connect_host(host)
    if "--kill" in argv:
        return kill_stale(connect, port)
    if not is_up(connect, port):
        return 1
    url = f"http://{host}:{port}/"
    print(url)
    if "--open" in argv:
        threading.Timer(0.2, lambda: webbrowser.open(url)).start()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
