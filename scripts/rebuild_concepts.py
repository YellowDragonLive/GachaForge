# -*- coding: utf-8 -*-
"""从关系表全量重建概念物化索引（幂等，随时可跑）。

固定入口：python scripts/rebuild_concepts.py
正常出图时由 save_result() 增量维护；只有手工修过库、批量归档恢复、
或升级索引规则后需要全量重建时才用本脚本。
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.app.db import SessionLocal  # noqa: E402
from backend.app.services import concepts as concept_svc  # noqa: E402


def main() -> int:
    db = SessionLocal()
    try:
        before = concept_svc.status(db)
        result = concept_svc.rebuild(db)
        after = concept_svc.status(db)
        print(f"[rebuild] 处理 {result['images']} 张 active 图，"
              f"写入 {result['links']} 条概念关联，"
              f"得到 {result['concepts']} 个概念")
        print(f"[rebuild] 重建前 {before['concept_count']} 个概念 → "
              f"重建后 {after['concept_count']} 个；类别 "
              f"{len(after['kinds'])} 种")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
