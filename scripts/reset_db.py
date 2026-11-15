# -*- coding: utf-8 -*-
"""清空运行数据并重建 v2 关系库（方案 C 的固定入口）。

  python scripts/reset_db.py --dry-run    只打印将要做什么，绝不改动
  python scripts/reset_db.py              执行：备份 → 归档 → 新建空库 → 重建字典

口径：
  * 运行数据（会话 / 抽卡 / 任务 / 图片 / 事件）全部归档，不物理删除；
  * 原图与缩略图按原相对路径移动到 data/archive/<时间戳>/，可一键回滚；
  * 字典（568 池 / 32490 词条 / 内置配方）在新空库里由
    scripts/migrate_legacy.py --if-empty 重新导入，内容不变、id 重新分配；
  * 用户配置（参数预设里的 checkpoint / LoRA、自建配方）从归档库按名字
    迁回新库，不会因重建丢失；
  * 归档库只作只读备份，不提供从 0001_initial 升级到 v2 的路径。

手册见 docs/运维_启动与验收.md「清空重建」小节。
"""
from __future__ import annotations

import argparse
import shutil
import sqlite3
import subprocess
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.app.config import get_settings  # noqa: E402

IMG_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}


def collect_images(s) -> list[Path]:
    """目录扫描为准：库里没登记的孤儿测试图也一起归档。"""
    out: list[Path] = []
    for base in (s.outputs_dir, s.thumbs_dir):
        if not base.is_dir():
            continue
        for p in sorted(base.rglob("*")):
            if p.is_file() and p.suffix.lower() in IMG_EXTS:
                out.append(p)
    return out


def relative_dest(p: Path) -> Path:
    """项目内保留原相对路径；项目外配置的输出目录统一放到 external/ 下。"""
    try:
        return p.resolve().relative_to(ROOT.resolve())
    except ValueError:
        return Path("external") / p.resolve().drive.replace(":", "") / p.name


def restore_config(old_db: Path, new_db: Path) -> dict:
    """把「配置」从归档库迁回新库：不是运行数据，清空不该丢。

    参数预设按 name 更新（保留用户设置的 checkpoint / LoRA / 采样参数），
    自建配方按 name 补插；字典池与词条由 migrate_legacy 重建，不动。
    """
    if not old_db.is_file():
        return {"profiles": 0, "recipes": 0, "reason": f"归档库不存在: {old_db}"}
    conn = sqlite3.connect(new_db)
    try:
        stats = {"profiles": 0, "recipes": 0}
        p_cols = [r[1] for r in conn.execute("pragma table_info(gen_profiles)")]
        p_insert = [c for c in p_cols if c != "id"]
        p_update = [c for c in p_cols
                    if c not in ("id", "name", "created_at")]
        conn.execute("ATTACH DATABASE ? AS old", (str(old_db),))
        old_profiles = conn.execute(
            f'select {",".join(p_cols)} from old.gen_profiles').fetchall()
        for row in old_profiles:
            data = dict(zip(p_cols, row))
            found = conn.execute("select id from main.gen_profiles where name=?",
                                 (data["name"],)).fetchone()
            fields = {k: data[k] for k in p_update
                      if data[k] not in (None, "")}
            if found:
                if fields:
                    conn.execute(
                        "update main.gen_profiles set "
                        + ",".join(f"{k}=?" for k in fields)
                        + " where id=?", (*fields.values(), found[0]))
                stats["profiles"] += 1
            else:
                conn.execute(
                    f'insert into main.gen_profiles ({",".join(p_insert)}) values '
                    f'({",".join("?" for _ in p_insert)})',
                    tuple(data[c] for c in p_insert))
                stats["profiles"] += 1
        r_cols = [r[1] for r in conn.execute("pragma table_info(recipes)")]
        r_write = [c for c in r_cols if c != "id"]
        old_recipes = conn.execute(
            f'select {",".join(r_cols)} from old.recipes').fetchall()
        for row in old_recipes:
            data = dict(zip(r_cols, row))
            exists = conn.execute("select 1 from main.recipes where name=?",
                                  (data["name"],)).fetchone()
            if exists:
                continue
            conn.execute(
                f'insert into main.recipes ({",".join(r_write)}) values '
                f'({",".join("?" for _ in r_write)})',
                tuple(data[c] for c in r_write))
            stats["recipes"] += 1
        conn.commit()
        conn.execute("DETACH DATABASE old")
        return stats
    finally:
        conn.close()


def main() -> int:
    ap = argparse.ArgumentParser(description="清空运行数据并重建 v2 关系库")
    ap.add_argument("--dry-run", action="store_true", help="只打印清单，不改动任何文件")
    ap.add_argument("--no-dictionary", action="store_true",
                    help="新库不重新导入字典（仅调试用）")
    ap.add_argument("--restore-config-only", metavar="OLD_DB",
                    help="只把归档库里的参数预设 / 自建配方迁回当前库，不清库")
    args = ap.parse_args()

    s = get_settings()
    db: Path = s.db_path
    if args.restore_config_only:
        print("[reset] 仅回迁配置:", restore_config(
            Path(args.restore_config_only), db))
        return 0
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    archive = ROOT / "data" / "archive" / stamp
    backup = ROOT / "data" / "backups" / f"gacha_{stamp}.db"
    files = collect_images(s)

    print(f"数据库      : {db} ({db.stat().st_size / 2**20:.2f} MB)" if db.exists()
          else f"数据库      : {db} (不存在，将直接新建)")
    print(f"备份目标    : {backup}")
    print(f"归档目录    : {archive}")
    print(f"图片文件    : {len(files)} 个（原图 + 缩略图，移动到归档，不删除）")
    for p in files[:5]:
        print(f"  {p}")
    if len(files) > 5:
        print(f"  …另有 {len(files) - 5} 个")
    if db.exists():
        try:
            conn = sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True)
            for table in ("draw_sessions", "draws", "generation_jobs", "images",
                          "pools", "pool_items", "recipes", "gen_profiles"):
                try:
                    n = conn.execute(f'select count(*) from "{table}"').fetchone()[0]
                    print(f"  {table:<18} {n}")
                except sqlite3.Error:
                    pass
            conn.close()
        except sqlite3.Error as exc:
            print(f"  [WARN] 只读统计失败: {exc}")
    print("新库动作    : init_db（v2 基线）→ migrate_legacy --if-empty（重建字典）→ 回迁用户配置")

    if args.dry_run:
        print("\n[dry-run] 未改动任何文件。去掉 --dry-run 才会执行。")
        return 0

    # 1) 备份（先于任何移动，失败即停）
    backup.parent.mkdir(parents=True, exist_ok=True)
    if db.exists():
        shutil.copy2(db, backup)
        print(f"[reset] 已备份 {backup.name}")

    # 2) 归档图片（保持相对路径，可整目录移回）
    archive.mkdir(parents=True, exist_ok=True)
    moved = 0
    for p in files:
        dest = archive / relative_dest(p)
        dest.parent.mkdir(parents=True, exist_ok=True)
        try:
            shutil.move(str(p), str(dest))
            moved += 1
        except OSError as exc:
            print(f"[reset] WARN 图片归档失败 {p}: {exc}")
    print(f"[reset] 已归档图片 {moved}/{len(files)}")

    # 3) 归档旧库（含 WAL / SHM），不删除
    for suffix in ("", "-wal", "-shm"):
        src = Path(str(db) + suffix)
        if src.exists():
            shutil.move(str(src), str(archive / (db.name + suffix)))
    print(f"[reset] 旧库已归档到 {archive / db.name}")

    # 4) 用独立子进程重建，避免当前进程持有旧 engine / 连接缓存
    py = sys.executable
    subprocess.run([py, str(ROOT / "scripts" / "init_db.py")], check=True, cwd=str(ROOT))
    print("[reset] v2 空库已建立")
    if not args.no_dictionary:
        subprocess.run([py, str(ROOT / "scripts" / "migrate_legacy.py"), "--if-empty"],
                       check=True, cwd=str(ROOT))
        print("[reset] 字典已重建")

    # 5) 配置不是运行数据：把参数预设（含真实 checkpoint）与自建配方迁回来
    result = restore_config(archive / db.name, db)
    print(f"[reset] 配置回迁: 参数预设 {result.get('profiles', 0)} 个 / "
          f"自建配方 {result.get('recipes', 0)} 个 {result.get('reason', '')}")

    conn = sqlite3.connect(db)
    try:
        tables = {r[0] for r in conn.execute(
            "select name from sqlite_master where type='table'")}
        print("[reset] 新库表数:", len(tables))
        print("[reset] 池 / 条目:",
              conn.execute("select count(*) from pools").fetchone()[0], "/",
              conn.execute("select count(*) from pool_items").fetchone()[0])
        print("[reset] 运行数据:",
              conn.execute("select count(*) from draws").fetchone()[0], "抽卡 /",
              conn.execute("select count(*) from images").fetchone()[0], "图")
        for t in ("draw_slots", "draw_slot_tags", "draw_profiles", "session_loras",
                  "session_recipes", "image_assets", "concepts", "concept_images"):
            print(f"  {t:<20}", "OK" if t in tables else "MISSING")
    finally:
        conn.close()
    print(f"\n[reset] 完成。回滚：把 {archive} 里的文件移回原路径即可。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
