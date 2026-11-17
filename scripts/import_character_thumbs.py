# -*- coding: utf-8 -*-
"""把外部「角色选择器」里内嵌的角色缩略图解出来，作为角色冷启动立绘。

源数据：`X:/game/noobaiStyleCollection_v12/WAI-NSFW-illustrious-character-select/output_*.json`
每个文件是 `[{"作品, 角色, 作品": "data:image/webp;base64,..."}, ...]`，
key 中间段就是 danbooru 英文角色 tag，和项目角色池条目的 tags 格式天然一致。

    python scripts/import_character_thumbs.py                 # 只看清单，不写
    python scripts/import_character_thumbs.py --yes           # 解码落盘 + 建索引
    python scripts/import_character_thumbs.py --source <dir>  # 换一批源图

落盘到 data/char_thumbs/：
  * 文件用序号命名（0000.webp …），避开中文/特殊字符文件名；
  * index.json 存 {"version","source","count","entries":[{file,full,name}]}，
    full = 归一后的完整 key，name = 归一后的角色名（中间段），供运行期查。

为什么不搬原图：这些本来就是 200px 级的 webp 缩略图（2145 张共 30MB），
不是 3.2GB 训练原图。整目录 gitignore、不进库、不常驻服务，能随脚本重建。
运行期由 backend/app/core/char_thumbs.py 只读分发，查不到返回 None（不抛错）。
"""
from __future__ import annotations

import argparse
import base64
import json
import re
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = Path(r"X:/game/noobaiStyleCollection_v12/WAI-NSFW-illustrious-character-select")
OUT = ROOT / "data" / "char_thumbs"
INDEX = OUT / "index.json"
DATA_URI = re.compile(r"^data:image/(\w+);base64,(.*)$", re.S)
EXT = {"webp": ".webp", "jpeg": ".jpg", "jpg": ".jpg", "png": ".png"}


def norm(s: str) -> str:
    """与前端 conceptKeyOf 同一套语义：去反斜杠、压空白、转小写。"""
    return re.sub(r"\s+", " ", str(s or "").replace("\\", "").replace("_", " ")).strip().lower()


def split_key(key: str) -> tuple[str, str]:
    """`作品, 角色, 作品` → (完整归一, 角色名归一)。"""
    parts = [p.strip() for p in str(key).split(",")]
    full = norm(", ".join(parts))
    name = norm(parts[1]) if len(parts) >= 2 else full
    return full, name


def load_source(source: Path) -> list[dict]:
    rows: list[dict] = []
    files = sorted(source.glob("output_*.json"),
                   key=lambda p: (int(re.search(r"(\d+)", p.stem).group(1))
                                  if re.search(r"(\d+)", p.stem) else 0))
    for f in files:
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            print(f"[char-thumb] 跳过 {f.name}: {exc}")
            continue
        for entry in data:
            if not isinstance(entry, dict):
                continue
            for key, uri in entry.items():
                m = DATA_URI.match(str(uri))
                if not m:
                    continue
                full, name = split_key(key)
                if not name:
                    continue
                rows.append({"src": f.name, "full": full, "name": name,
                             "mime": m.group(1).lower(),
                             "blob": base64.b64decode(m.group(2))})
    return rows


def coverage(rows: list[dict]) -> None:
    """打一份和正式库的配对率，确认这批图真能用在角色池上。"""
    db = ROOT / "data" / "gacha.db"
    if not db.is_file():
        return
    try:
        con = sqlite3.connect(db)
        tags = [t for (t,) in con.execute(
            "select i.tags from pool_items i join pools p on p.id=i.pool_id "
            "where p.kind='角色'")]
        con.close()
    except sqlite3.Error:
        return
    db_full = {norm(t) for t in tags}
    db_name = set()
    for t in tags:
        parts = [p.strip() for p in str(t).split(",")]
        if len(parts) >= 2:
            db_name.add(norm(parts[1]))
    hit_full = sum(1 for r in rows if r["full"] in db_full)
    hit_name = sum(1 for r in rows if r["name"] in db_name)
    print(f"[char-thumb] 与角色池配对：完整 key {hit_full}/{len(rows)}，"
          f"角色名 {hit_name}/{len(rows)}")


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="导入角色缩略图作为冷启动立绘")
    ap.add_argument("--source", default=str(DEFAULT_SOURCE), help="源 JSON 目录")
    ap.add_argument("--yes", action="store_true", help="真的落盘（默认只看清单）")
    ap.add_argument("--force", action="store_true", help="已有索引也重新解码覆盖")
    args = ap.parse_args()

    source = Path(args.source)
    if not source.is_dir():
        print(f"[char-thumb] 源目录不存在：{source}")
        return 2
    rows = load_source(source)
    if not rows:
        print(f"[char-thumb] {source} 里没有可用的 output_*.json")
        return 2

    total_mb = sum(len(r["blob"]) for r in rows) / 1048576
    print(f"[char-thumb] 源目录  : {source}")
    print(f"[char-thumb] 落盘目录: {OUT}")
    print(f"[char-thumb] 缩略图  : {len(rows)} 张 / {total_mb:.1f} MB")
    coverage(rows)
    # 角色名重复的只保留第一张（同一角色多来源时用先扫到的）
    seen: set[str] = set()
    uniq = []
    for r in rows:
        if r["name"] in seen:
            continue
        seen.add(r["name"])
        uniq.append(r)
    print(f"[char-thumb] 去重后  : {len(uniq)} 张（按角色名）")
    if not args.yes:
        print("\n[char-thumb] dry-run：什么都没写。确认后加 --yes。")
        return 0
    if INDEX.is_file() and not args.force:
        print(f"[char-thumb] {INDEX} 已存在。要重建请加 --force。")
        return 1

    OUT.mkdir(parents=True, exist_ok=True)
    entries = []
    for i, r in enumerate(uniq):
        ext = EXT.get(r["mime"], ".bin")
        fname = f"{i:04d}{ext}"
        (OUT / fname).write_bytes(r["blob"])
        entries.append({"file": fname, "full": r["full"], "name": r["name"]})
    index = {"version": 1, "source": str(source), "count": len(entries),
             "entries": entries}
    INDEX.write_text(json.dumps(index, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"[char-thumb] 已写入 {len(entries)} 张 + {INDEX.name}")
    print("[char-thumb] 回滚：删掉整个 data/char_thumbs/ 即可（不影响主库）。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
