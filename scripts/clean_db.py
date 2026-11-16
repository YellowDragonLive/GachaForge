# -*- coding: utf-8 -*-
"""清掉运行数据，保留字典与配置 —— 开发期反复测试的固定入口。

    python scripts/clean_db.py                 # 只看清单，绝不改动（默认 dry-run）
    python scripts/clean_db.py --yes           # 执行
    python scripts/clean_db.py --yes --keep-images   # 只清库，图片留在原地
    python scripts/clean_db.py --db X:/tmp/t.db --yes  # 清指定的库（测脚本本身用）

与 scripts/reset_db.py 的分工：
  * reset_db  = 换库/换模型后重建：新空库 + 重新导入 568 池 32490 词条 + 回迁配置，
                几十秒起，只该在架构变更时用。
  * clean_db  = 只把「跑出来的东西」清掉：抽卡 / 任务 / 图片 / 概念 / 事件，
                字典（pools / pool_items）、配方（recipes）、参数预设（gen_profiles）一律不动。
                开发期每轮测试前都跑它，几秒完成，库回到刚导入完的样子。

安全口径（与项目其它清理脚本一致）：
  * 默认 dry-run，必须显式 --yes 才写；
  * 先把整库备份到 data/archive/clean-<时间戳>/gacha.db（SQLite backup API，
    WAL 未落盘也能拿到一致快照），再动数据；
  * 图片**移动**到同一归档目录下，不物理删除，可整目录搬回；
  * 库不对（没有 pools 表 / pools 是空的）直接拒绝，避免指错文件把别的库清了。

手册见 docs/运维_启动与验收.md「清洗运行数据」。
"""
from __future__ import annotations

import argparse
import shutil
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

IMG_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}

# 子表在前、父表在后：SQLite 即使没开 foreign_keys，顺序对也不会有悬挂引用。
CLEAR_TABLES = [
    ("concept_images", "概念↔图"),
    ("concepts", "概念（从图反查出来的索引）"),
    ("image_assets", "图片产出记录"),
    ("images", "图片"),
    ("generation_jobs", "生成任务"),
    ("draw_slot_tags", "抽卡槽位词条"),
    ("draw_slots", "抽卡槽位"),
    ("draws", "抽卡"),
    ("session_recipe_slots", "会话配方快照槽位"),
    ("session_recipes", "会话配方快照"),
    ("draw_profiles", "会话参数快照"),
    ("draw_sessions", "抽卡会话"),
    ("event_logs", "事件日志"),
]

# 显式列出「不会被清」的东西：用户看输出就知道配置还在，不用去翻代码。
KEEP_TABLES = [
    ("pools", "池定义"),
    ("pool_items", "池内词条（字典，重建要几十秒，绝不能丢）"),
    ("recipes", "配方（含自建）"),
    ("gen_profiles", "参数预设：checkpoint / LoRA / 采样参数"),
    ("import_batches", "字典导入批次"),
    ("alembic_version", "迁移版本"),
]


def db_path_from_env() -> Path:
    try:
        from backend.app.config import get_settings, load_dotenv  # noqa: WPS433
        load_dotenv()
        p = Path(get_settings().db_path)
    except Exception:  # 配置还没建好时也要能用
        p = Path("data/gacha.db")
    return p if p.is_absolute() else ROOT / p


def image_dirs() -> list[Path]:
    out = [ROOT / "data" / "outputs", ROOT / "data" / "thumbs"]
    return [p for p in out if p.is_dir()]


def count_rows(con: sqlite3.Connection, table: str) -> int:
    try:
        return con.execute(f'select count(*) from "{table}"').fetchone()[0]
    except sqlite3.Error:
        return -1


def scan_images() -> list[Path]:
    """按目录扫，不按库里的记录：测试时手工扔进去的图也要一起归档。"""
    files: list[Path] = []
    for base in image_dirs():
        files.extend(sorted(p for p in base.rglob("*")
                            if p.is_file() and p.suffix.lower() in IMG_EXTS))
    return files


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    ap = argparse.ArgumentParser(description="清运行数据，保留字典与配置")
    ap.add_argument("--db", default="", help="库路径，默认取 GACHA_DB_PATH")
    ap.add_argument("--yes", action="store_true", help="真的执行（不加只打印清单）")
    ap.add_argument("--keep-images", action="store_true", help="只清库，图片留在原地")
    ap.add_argument("--no-vacuum", action="store_true", help="跳过 VACUUM（服务在跑时可跳过）")
    args = ap.parse_args()

    db = Path(args.db) if args.db else db_path_from_env()
    if not db.is_absolute():
        db = ROOT / db
    if not db.is_file():
        print(f"[clean] 库不存在：{db}")
        return 2

    con = sqlite3.connect(db)
    try:
        # 指错库的兜底：字典表必须存在且有内容，否则多半不是这个项目的库。
        names = {r[0] for r in con.execute(
            "select name from sqlite_master where type='table'")}
        if "pools" not in names or "pool_items" not in names:
            print(f"[clean] 拒绝执行：{db} 里没有 pools/pool_items，不像工作台的库")
            return 2
        if count_rows(con, "pool_items") <= 0:
            print(f"[clean] 拒绝执行：{db} 的 pool_items 是空的（字典没导入），"
                  "清完会变成一个没词可抽的库")
            return 2

        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        archive = ROOT / "data" / "archive" / f"clean-{stamp}"
        files = [] if args.keep_images else scan_images()

        print(f"[clean] 库        : {db}")
        print(f"[clean] 归档目录  : {archive}")
        print()
        print("将要清空（运行数据）：")
        total = 0
        for table, desc in CLEAR_TABLES:
            n = count_rows(con, table)
            if n:
                total += n
            print(f"  {n:>7} 行  {table:<22} {desc}")
        print(f"  {total:>7} 行  合计")
        print()
        print("保留不动（字典与配置）：")
        for table, desc in KEEP_TABLES:
            print(f"  {count_rows(con, table):>7} 行  {table:<22} {desc}")
        print()
        if args.keep_images:
            print("图片：保留原地（--keep-images）")
        else:
            print(f"图片：{len(files)} 个文件将移动到 {archive}/")

        if not args.yes:
            print("\n[clean] dry-run：什么都没改。确认无误后加 --yes 执行。")
            return 0

        # ---- 1. 先备份整库 ----
        archive.mkdir(parents=True, exist_ok=True)
        bak = archive / "gacha.db"
        out = sqlite3.connect(bak)
        try:
            con.backup(out)
        finally:
            out.close()
        print(f"\n[clean] 已备份整库 → {bak}（{bak.stat().st_size / 1048576:.1f} MB）")

        # ---- 2. 移走图片 ----
        moved = 0
        for src in files:
            try:
                rel = src.resolve().relative_to(ROOT.resolve())
            except ValueError:
                rel = Path("external") / src.name
            dest = archive / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(src), str(dest))
            moved += 1
        if not args.keep_images:
            print(f"[clean] 已归档图片 {moved}/{len(files)} 个")

        # ---- 3. 删行（一个事务，失败全回滚）----
        with con:
            for table, _ in CLEAR_TABLES:
                con.execute(f'delete from "{table}"')
        con.execute("pragma wal_checkpoint(truncate)")
        print("[clean] 运行数据已清空")

        # ---- 4. 压实 ----
        if not args.no_vacuum:
            try:
                con.execute("vacuum")
                print("[clean] VACUUM 完成")
            except sqlite3.Error as e:  # 服务在跑时会被锁，不影响结果
                print(f"[clean] VACUUM 跳过（{e}）")

        print()
        print("清空后：")
        for table, _ in CLEAR_TABLES[:4]:
            print(f"  {count_rows(con, table):>7} 行  {table}")
        print(f"  库体积 {db.stat().st_size / 1048576:.1f} MB")
        print(f"\n[clean] 完成。回滚：把 {archive} 下的文件按相对路径搬回原处。")
        return 0
    finally:
        con.close()


if __name__ == "__main__":
    sys.exit(main())
