# -*- coding: utf-8 -*-
"""给池打「切片」（facet）：把一个混装多维度的大池按维度切成可选的档。

  python scripts/build_facets.py                 只算不写，打印每池每组的分布
  python scripts/build_facets.py --apply         写库（幂等，可重复跑）
  python scripts/build_facets.py --pool 人物-头发 --verbose
  python scripts/build_facets.py --apply --absorb 同时收编 danbooru 细分池

为什么不是拆池：`人物-头发` 212 条混着长度 / 束法 / 质地 / 刘海 / 性别向 / 适格，
拆成 6 个池会把池数从 568 推到 2000+、不可逆，而且下个切面还得再拆一次。
facet 让池与条目一个字不改，只在上面挂正交维度，抽卡时按选中的档收窄。

规则在 backend/app/core/facet_rules.json，改完重跑本脚本即可。
手册见 docs/架构_总览.md「池内切片」小节。
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.app.db import SessionLocal, init_db          # noqa: E402
from backend.app.services import facets as facet_svc      # noqa: E402


def _print_stats(stats: list[dict], verbose: bool) -> None:
    for s in stats:
        pct = (s["assigned"] / s["items"] * 100) if s["items"] else 0
        print(f"\n{s['pool']}（{s['items']} 条，已归类 {s['assigned']} = {pct:.0f}%）")
        for g in s["groups"]:
            opts = " · ".join(f"{o['name']} {o['count']}" for o in g["options"])
            print(f"  {g['name']:<6} {opts}")
        if verbose and s["unassigned"]:
            print(f"  未归类 {s['unassigned']} 条")


def main() -> int:
    ap = argparse.ArgumentParser(description="按规则给池打切片（facet）")
    ap.add_argument("--apply", action="store_true", help="写库（默认只算不写）")
    ap.add_argument("--pool", default="", help="只处理名字或 slug 含该片段的池")
    ap.add_argument("--absorb", action="store_true", help="同时标记细分类池为已收编")
    ap.add_argument("--verbose", "-v", action="store_true")
    args = ap.parse_args()

    init_db()
    db = SessionLocal()
    try:
        # 收编必须在打切片之前：细池里粗池没有的那几条（hair up / hair down）
        # 要先插进粗池，才有机会在这一轮被分到切片里。
        if args.absorb:
            rows = facet_svc.absorb_fine_pools(db, apply=args.apply)
            print(f"细分类池收编（{'已写入' if args.apply else '预览'}）：")
            for r in rows:
                extra = f"，补入粗池 {r['moved']} 条" if r["moved"] else ""
                print(f"  {r['pool']}（{r['items']} 条，重复 {r['dupe']}）→ {r['into']}{extra}")

        only = [args.pool.strip()] if args.pool.strip() else None
        stats = [s for s in facet_svc.sync_all(db, apply=args.apply)
                 if not only or any(args.pool.strip() in str(s[k])
                                    for k in ("pool", "slug"))]
        if not stats:
            print("没有匹配的池：检查 backend/app/core/facet_rules.json 里的 pool slug")
            return 1
        _print_stats(stats, args.verbose)

        print(f"\n{'已写入数据库' if args.apply else '未写库：加 --apply 生效'}")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
