"""Probe whether ComfyUI is reachable.

Used by ``scripts/start.bat`` to decide between real generation and mock mode,
and by ``scripts/start.bat``'s autostart wait loop. Kept as a script (not an
inline ``python -c``) because the URL lookup needs the backend config, and an
inline command with parentheses inside a ``for /f`` block gets cut in half by
cmd's parser.

Order of URLs: ``GACHA_COMFY_URL`` from env / .env, then the default
``http://127.0.0.1:8188``. The fallback exists so a broken config cannot make
start.bat think ComfyUI is down and launch a second copy on the same port.

Exit code 0 = reachable, 1 = down. Never prints a traceback: the caller only
reads the exit code. ``--url`` prints the address that answered.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

DEFAULT_URL = "http://127.0.0.1:8188"


def candidate_urls() -> list[str]:
    urls: list[str] = []
    try:
        from backend.app.config import get_settings

        urls.append(get_settings().comfy_url.rstrip("/"))
    except Exception:
        # Broken .env or config validation error: still try the default below.
        pass
    if DEFAULT_URL not in urls:
        urls.append(DEFAULT_URL)
    return urls


def main(argv: list[str]) -> int:
    try:
        import httpx
    except Exception:
        return 1

    for url in candidate_urls():
        try:
            resp = httpx.get(f"{url}/system_stats", timeout=3)
        except Exception:
            continue
        if resp.status_code == 200:
            if "--url" in argv:
                print(url)
            return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
