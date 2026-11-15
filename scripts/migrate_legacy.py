# -*- coding: utf-8 -*-
"""旧数据 → SQLite 的固定入口。

用法：
  python scripts/migrate_legacy.py --dry-run          # 只看计划
  python scripts/migrate_legacy.py                    # 执行导入（重复运行安全）
  python scripts/migrate_legacy.py --if-empty         # 已有卡池则跳过（start.bat 用）
  python scripts/migrate_legacy.py --rollback 3       # 回滚第 3 号导入批次
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from sqlalchemy import select  # noqa: E402

from backend.app.config import get_settings  # noqa: E402
from backend.app.db import SessionLocal  # noqa: E402
from backend.app.models import Pool  # noqa: E402
from backend.app.services import draws as draw_svc  # noqa: E402
from backend.app.services import pools as pool_svc  # noqa: E402

BUILTIN_RECIPES = [
    {"name": "角色 × 风格 × 背景", "is_builtin": True,
     "definition": {"fixed_head": "masterpiece, best quality, 1girl",
                    "slots": [{"pool": "zh_TW", "count": 1, "weight": 1.0},
                              {"pool": "风格", "count": 1, "weight": 1.0},
                              {"pool": "背景", "count": 1, "weight": 0.8}],
                    "fixed_tail": "detailed, sharp focus"}},
    {"name": "画师图鉴探索", "is_builtin": True,
     "definition": {"fixed_head": "masterpiece, best quality",
                    "slots": [{"pool": "画师", "count": 1, "weight": 1.0},
                              {"pool": "角色", "count": 1, "weight": 0.9}],
                    "template": "__构图~__, __颜色~__"}},
    {"name": "词卡自由模板", "is_builtin": True,
     "definition": {"fixed_head": "masterpiece, best quality, 1girl",
                    "template": "__风格__, __背景~__",
                    "fixed_tail": "highres"}},
]


def plan() -> list[tuple[str, Path, bool]]:
    s = get_settings()
    return [
        ("json", ROOT / "action.json", False),
        ("json", ROOT / "zh_TW.json", True),
        ("csv", ROOT / "wai_characters.csv", True),
        ("artists", ROOT / "noobai_data.json", True),
        ("json", ROOT / "wai_tag_assist.json", False),
        ("wildcards", s.wildcards_dir, True),
    ]


def main() -> int:
    ap = argparse.ArgumentParser(description="导入旧抽卡数据到 SQLite")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--if-empty", action="store_true")
    ap.add_argument("--rollback", type=int, default=0)
    args = ap.parse_args()

    db = SessionLocal()
    try:
        if args.rollback:
            print(pool_svc.rollback_batch(db, args.rollback))
            return 0
        if args.if_empty and db.scalar(select(Pool).limit(1)):
            print("[migrate] 已有卡池，跳过导入")
            return 0
        if args.dry_run:
            for kind, path, enabled in plan():
                print(f"  [{kind:9}] {'启用' if enabled else '冷存'}  "
                      f"{'存在' if path.exists() else '缺失'}  {path}")
            print(f"  [recipes  ] 内置配方 {len(BUILTIN_RECIPES)} 个")
            return 0

        for kind, path, enabled in plan():
            if not path.exists():
                print(f"[migrate] WARN 跳过（不存在）: {path}")
                continue
            if kind == "csv":
                res = pool_svc.import_csv_file(db, path, enabled=enabled)
            elif kind == "artists":
                res = pool_svc.import_artists(db, path)
            elif kind == "wildcards":
                res = pool_svc.import_wildcards(db, path)
            else:
                res = pool_svc.import_json_file(db, path, enabled=enabled)
            print(f"[migrate] {kind:9} 池 {res.get('pools', 0):4} / "
                  f"条目 {res.get('items', 0):6}  {path.name}")

        combo_dir = ROOT / "combos"
        legacy = pool_svc.import_combos(db, combo_dir)
        for recipe in legacy.get("items", []):
            name = str(recipe.get("name") or "").strip()
            if not name:
                continue
            definition = {k: recipe[k] for k in
                          ("fixed_head", "fixed_tail", "template", "slots")
                          if k in recipe}
            try:
                draw_svc.upsert_recipe(db, {"name": f"旧配方·{name}",
                                            "definition": definition})
            except Exception as exc:
                print(f"[migrate] WARN 旧配方 {name} 导入失败: {exc}")
        for r in BUILTIN_RECIPES:
            try:
                draw_svc.upsert_recipe(db, r)
            except Exception:
                pass
        draw_svc.ensure_default_profile(db)
        print(f"[migrate] 完成：卡池 {len(pool_svc.list_pools(db))} 个，"
              f"配方 {len(draw_svc.list_recipes(db))} 个")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
