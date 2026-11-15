# -*- coding: utf-8 -*-
"""建库 / 升级：固定入口 `python scripts/init_db.py`。

用 Alembic 管理版本；表结构以 ORM metadata 为准。
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from alembic import command  # noqa: E402
from alembic.config import Config  # noqa: E402

from backend.app.config import get_settings  # noqa: E402


def main() -> int:
    s = get_settings()
    s.db_path.parent.mkdir(parents=True, exist_ok=True)
    cfg = Config()
    cfg.set_main_option("script_location", str(ROOT / "backend" / "migrations"))
    cfg.set_main_option("sqlalchemy.url", s.db_url)
    command.upgrade(cfg, "head")
    print(f"[init_db] 迁移完成: {s.db_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
