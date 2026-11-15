# -*- coding: utf-8 -*-
"""数据库备份 / 恢复的固定入口（用 SQLite backup API，保证 WAL 一致性）。

  python scripts/backup_db.py                    备份
  python scripts/backup_db.py --list            列出备份
  python scripts/backup_db.py --restore <路径>  恢复
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.app.config import get_settings  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description="备份/恢复 gacha.db")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--restore", default="")
    args = ap.parse_args()

    s = get_settings()
    src = s.db_path
    backup_dir = s.root / "data" / "backups"
    backup_dir.mkdir(parents=True, exist_ok=True)

    if args.list:
        for fp in sorted(backup_dir.glob("*.db")):
            print(f"{fp.name:44} {fp.stat().st_size / 1024:.0f} KB")
        return 0
    if args.restore:
        rp = Path(args.restore)
        rp = rp if rp.is_absolute() else backup_dir / rp
        if not rp.is_file():
            print(f"[backup] 备份不存在: {rp}")
            return 2
        with sqlite3.connect(rp) as con:
            con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        src.parent.mkdir(parents=True, exist_ok=True)
        import shutil
        shutil.copy2(rp, src)
        print(f"[backup] 已恢复: {rp} -> {src}")
        return 0
    if not src.is_file():
        print("[backup] 数据库尚不存在，请先运行 scripts/init_db.py")
        return 2
    dest = backup_dir / f"gacha_{datetime.now().strftime('%Y%m%d_%H%M%S')}.db"
    with sqlite3.connect(src) as con, sqlite3.connect(dest) as out:
        con.backup(out)
    print(f"[backup] 备份完成: {dest} ({dest.stat().st_size / 1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
