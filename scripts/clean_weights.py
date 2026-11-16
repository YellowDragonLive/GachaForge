# -*- coding: utf-8 -*-
"""审计卡池条目里的超重权重（`(a:1.2)` / `(a, b:1.3)` / `a:1.2`）。

**标准口径：出图时剥，池子不动。** 组装 prompt 的出口（`core/recipes.py: run_recipe`
与 `core/pools.py: build_prompt`）已经在写进 prompt 前调 `strip_weights`，所以池子里的
原文保持导入时的样子（卡池页、选择器、重新导出都不变），出图 prompt 永远是干净的。
这个脚本默认只**审计**：看看污染有多少、长什么样，不写库。

    python scripts/clean_weights.py                 # 审计：清单 + 样例，绝不写库
    python scripts/clean_weights.py --prompt "(a:1.2), b"   # 预览一段文本清完长什么样
    python scripts/clean_weights.py --self-test     # 只跑内置用例，验规则没写坏
    python scripts/clean_weights.py --apply         # 真改池子文本（非标准做法，见下）

`--apply` 只在「确实要净库」时用（例如把库导给别的工具、或想让卡池页也看不到权重）：
它会**改写 pool_items.label/tags**，是不可逆的数据变更，务必先看 dry-run 清单。

口径（细节见 backend/app/core/weights.py 的模块注释）：
  * `<lora:name:0.7>` 整体跳过，里面的数字是 LoRA 权重；
  * `(a:1.2)` → `a`（括号一起去掉，留着仍是 1.1 倍强调 = 没清干净）；
  * `a:1.2` → `a`；`reverse:1999`、`(重返未來:1999)` 这类「冒号+年份」不碰；
  * 只清 [--min, --max] 区间（默认 1.1~5.0），0.5/0.8 的降权保持原样。

安全口径（与 clean_db / reset_db 一致）：
  * 默认只读；`--apply` 才写；
  * 写库前先用 SQLite backup API 备份到 data/backups/gacha-weight-<时间戳>.db（WAL 一致快照）；
  * 单事务提交，出错整体回滚；
  * 幂等：清完再跑一遍命中数为 0。

手册见 docs/运维_清理权重.md。
"""
from __future__ import annotations

import argparse
import re
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.app.core.weights import strip_weights  # noqa: E402

NUM = r"[0-9]+(?:\.[0-9]+)?"

SELF_TEST_CASES = [
    # (输入, 期望)
    ("(standing:1.2)", "standing"),
    ("(bottomless, lying:2)", "bottomless, lying"),
    ("anal beads:1.2,anal beads inside", "anal beads, anal beads inside"),
    ("(volumey pannier under a (long petticoat:1.2):1.3)",
     "volumey pannier under a long petticoat"),
    # 缺开括号的坏数据也能清干净（孤立权重兜底）
    ("volumey pannier under a (long petticoat:1.2):1.3)",
     "volumey pannier under a long petticoat"),
    ("<lora:cuminass-000015:1>,asscum,(standing:1.2)",
     "<lora:cuminass-000015:1>, asscum, standing"),
    # 没有超重权重就一字不改（不顺手重排逗号空格，diff 才不会漫天飞）
    ("<lora:X:0.7>,1girl,(bloom:0.5)", "<lora:X:0.7>,1girl,(bloom:0.5)"),
    ("reverse:1999, 維爾汀 (重返未來:1999)", "reverse:1999, 維爾汀 (重返未來:1999)"),
    ("((full body))", "((full body))"),
    ("(cum, cumdrip:1.2),cum in pussy", "cum, cumdrip, cum in pussy"),
    # 导入时丢了开括号：`:1.2)` 是孤立权重，连多余的后括号一起清
    ("a, an aesthetic dress ribbons:1.2), (a pannier, lace socks",
     "a, an aesthetic dress ribbons, (a pannier, lace socks"),
    ("", ""),
]


def self_test() -> int:
    bad = 0
    for src, want in SELF_TEST_CASES:
        got = strip_weights(src)
        flag = "OK " if got == want else "FAIL"
        if got != want:
            bad += 1
            print(f"[{flag}] {src!r}\n       得到 {got!r}\n       期望 {want!r}")
        else:
            print(f"[{flag}] {src!r} -> {got!r}")
    print(f"\n自测 {len(SELF_TEST_CASES) - bad}/{len(SELF_TEST_CASES)} 通过")
    return 0 if bad == 0 else 1


def backup(db: Path, tag: str = "weight") -> Path:
    """SQLite backup API：WAL 里未落盘的页也能拿到一致快照。"""
    out_dir = ROOT / "data" / "backups"
    out_dir.mkdir(parents=True, exist_ok=True)
    dst = out_dir / f"gacha-{tag}-{datetime.now():%Y%m%d-%H%M%S}.db"
    src = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=20)
    tgt = sqlite3.connect(str(dst))
    with tgt:
        src.backup(tgt)
    src.close()
    tgt.close()
    return dst


def restore_from(db: Path, src_db: Path) -> int:
    """把 pool_items 的 label/tags/content_hash 恢复成备份里的样子（只写有差异的行）。

    `--apply` 是不可逆的池子文本改写，这是它的回滚口：按 id 逐行比对，只把真被改过的
    行写回去，其它表（池、配方、历史抽卡、图片记录）一概不碰。
    """
    if not src_db.is_file():
        print(f"找不到备份：{src_db}")
        return 2
    old = sqlite3.connect(f"file:{src_db}?mode=ro", uri=True, timeout=20)
    tables = {r[0] for r in old.execute(
        "select name from sqlite_master where type='table'")}
    if "pool_items" not in tables:
        old.close()
        print(f"{src_db} 不像抽卡库备份（没有 pool_items 表）")
        return 2
    bk = backup(db, "before-restore")
    print(f"恢复前已备份当前库：{bk}")
    new = sqlite3.connect(f"file:{db}?mode=rw", uri=True, timeout=20)
    try:
        pairs = old.execute(
            "select id, label, tags, content_hash from pool_items").fetchall()
        current = {r[0]: (r[1], r[2], r[3]) for r in new.execute(
            "select id, label, tags, content_hash from pool_items")}
        diff = [(lab, tags, h, i) for i, lab, tags, h in pairs
                if i in current and current[i] != (lab, tags, h)]
        with new:
            new.executemany(
                "update pool_items set label=?, tags=?, content_hash=? where id=?", diff)
        print(f"已恢复 {len(diff)} 行（备份共 {len(pairs)} 行，只写有差异的）")
        return 0
    finally:
        old.close()
        new.close()


def main() -> int:
    ap = argparse.ArgumentParser(description="审计卡池条目里的超重权重（默认只读）")
    ap.add_argument("--db", default=str(ROOT / "data" / "gacha.db"))
    ap.add_argument("--min", type=float, default=1.1, help="权重下限（含），默认 1.1")
    ap.add_argument("--max", type=float, default=5.0, help="权重上限（含），默认 5.0")
    ap.add_argument("--keep-brackets", action="store_true", help="只删权重，保留括号")
    ap.add_argument("--no-label", action="store_true", help="只清 tags")
    ap.add_argument("--apply", action="store_true",
                    help="真的改写池子文本（非标准做法：出图时已自动净化）")
    ap.add_argument("--yes", action="store_true", help="--apply 的旧别名，保留兼容")
    ap.add_argument("--prompt", default="", help="只预览一段文本清理后的结果")
    ap.add_argument("--restore", default="",
                    help="用指定备份恢复 pool_items 文本（回滚 --apply）")
    ap.add_argument("--limit", type=int, default=8, help="打印样例条数")
    ap.add_argument("--self-test", action="store_true", help="只跑内置用例")
    args = ap.parse_args()

    if args.self_test:
        return self_test()
    if args.prompt:
        print(strip_weights(args.prompt, min_w=args.min, max_w=args.max,
                            unwrap=not args.keep_brackets))
        return 0
    write = args.apply or args.yes

    db = Path(args.db).resolve()
    if not db.is_file():
        print(f"找不到库：{db}")
        return 2
    if args.restore:
        return restore_from(db, Path(args.restore).resolve())
    con = sqlite3.connect(f"file:{db}?mode=rw", uri=True, timeout=20)
    con.row_factory = sqlite3.Row
    cur = con.cursor()
    try:
        tables = {r[0] for r in cur.execute(
            "select name from sqlite_master where type='table'")}
        if "pool_items" not in tables:
            print(f"{db} 不像抽卡库（没有 pool_items 表），不会动它")
            return 2

        kw = {"min_w": args.min, "max_w": args.max,
              "unwrap": not args.keep_brackets}
        rows = cur.execute(
            "select i.id, i.label, i.tags, p.name as pool from pool_items i "
            "left join pools p on p.id = i.pool_id order by i.id").fetchall()

        hits = []
        for r in rows:
            label = r["label"] or ""
            tags = r["tags"] or ""
            new_label = label if args.no_label else strip_weights(label, **kw)
            new_tags = strip_weights(tags, **kw)
            if new_label != label or new_tags != tags:
                hits.append((r["id"], r["pool"] or "?", label, tags, new_label, new_tags))

        total = len(rows)
        by_pool: dict[str, int] = {}
        for h in hits:
            by_pool[h[1]] = by_pool.get(h[1], 0) + 1
        # 清完仍残留的（括号不配对之类），只能人工看
        leftovers = []
        for h in hits:
            for m in re.finditer(rf":\s*({NUM})\s*[)\]}}]", h[5]):
                if args.min <= float(m.group(1)) <= args.max:
                    leftovers.append((h[0], h[1], h[5]))
                    break

        print(f"库：{db}")
        print(f"条目总数 {total} · 命中 {len(hits)} 条 · 涉及 {len(by_pool)} 个池"
              f" · 权重区间 {args.min}~{args.max}"
              f" · {'保留括号' if args.keep_brackets else '连括号一起删'}"
              f" · label {'不动' if args.no_label else '一起清'}")
        print("口径：只审计池子，不动数据；这些条目出图时会在组装 prompt 那一步自动净化。")
        if by_pool:
            print("\n按池（前 12）：")
            for name, n in sorted(by_pool.items(), key=lambda x: -x[1])[:12]:
                print(f"  {n:5d}  {name}")
        if leftovers:
            print(f"\n注意：{len(leftovers)} 条的括号不配对，权重没能自动清干净"
                  f"（括号数不对称，脚本不敢猜），需要人工看：")
            for lid, lpool, rest in leftovers[:5]:
                print(f"  #{lid} | {lpool} | {rest[:96]}")
        if hits and args.limit:
            print(f"\n样例（前 {min(args.limit, len(hits))} 条，id | 池）：")
            for h in hits[:args.limit]:
                print(f"  #{h[0]} | {h[1]}")
                if h[2] != h[4]:
                    print(f"    label: {h[2][:110]}\n        -> {h[4][:110]}")
                print(f"    tags : {h[3][:110]}\n        -> {h[5][:110]}")

        if not hits:
            print("\n没有需要清理的条目（池子本身就是干净的）。")
            return 0
        if not write:
            print(f"\n[审计] 没有写库，也不需要写库：这 {len(hits)} 条出图时会在组装 prompt 的"
                  f"那一步自动剥掉权重（core/recipes.py: run_recipe），池子文本保持原样。")
            print("       确实要把库里也改干净，才加 --apply（不可逆，会先自动备份）。")
            return 0

        print(f"\n警告：--apply 会改写 {len(hits)} 条 pool_items.label/tags（不可逆，仅备份可回滚）。")
        bk = backup(db)
        print(f"\n已备份：{bk}")
        # content_hash 是导入去重用的 (label, tags) 指纹，清完必须一起刷新
        import hashlib

        def digest(label: str, tags: str) -> str:
            return hashlib.sha256(f"{label}\x1f{tags}".encode("utf-8")).hexdigest()[:32]

        cur.execute("BEGIN IMMEDIATE")
        try:
            cur.executemany(
                "update pool_items set label=?, tags=?, content_hash=? where id=?",
                [(it[4], it[5], digest(it[4], it[5]), it[0]) for it in hits])
            con.commit()
        except Exception:
            con.rollback()
            raise

        # 复查：重扫一遍，必须 0 命中（幂等），否则说明规则有洞
        again = 0
        for r in cur.execute("select label, tags from pool_items"):
            if strip_weights(r[0] or "", **kw) != (r[0] or ""):
                again += 1
            elif strip_weights(r[1] or "", **kw) != (r[1] or ""):
                again += 1
        print(f"已更新 {len(hits)} 条；复查残留 {again} 条"
              f"{'（幂等 OK）' if again == 0 else '（还有洞，看上面 leftover 提示）'}")
        return 0
    finally:
        con.close()


if __name__ == "__main__":
    raise SystemExit(main())
