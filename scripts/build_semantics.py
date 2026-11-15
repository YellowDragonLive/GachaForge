# -*- coding: utf-8 -*-
"""构建画师语义索引（一次性、离线、可重复执行）。

数据源：X:/game/noobaiStyleCollection_v12/艺术家智能选择（可用 --source 覆盖）
  noobai_data.json                       1025 位画师 + 中英风格标签
  artist_profiles/artist_styles_collected.json  48 份深度档案
  select_artist.md                       精选 79 / 核心 17
  favorites.json                         收藏 109
  artist_style_test_20260526/thumbnails 1025 张风格样图（只记路径，不复制）

产物：data/semantics/{meta.json,vectors.npy,tags.json,tag_vectors.npy}
模型：data/models/minilm/（从本机 ~/.cache/chroma 复制，全程不联网）

用法：
  python scripts/build_semantics.py                 重建索引
  python scripts/build_semantics.py --if-missing   索引已存在则跳过（start.bat 用）
  python scripts/build_semantics.py --source DIR   指定画师资料目录
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import numpy as np  # noqa: E402
from backend.app.config import ROOT as APP_ROOT  # noqa: E402
from backend.app.core import embed  # noqa: E402

DEFAULT_SOURCE = Path("X:/game/noobaiStyleCollection_v12/艺术家智能选择")
INDEX_DIR = APP_ROOT / "data" / "semantics"
ENCODER_NAME = "all-MiniLM-L6-v2 ONNX (local CPU)"


def resolve_source(raw: str | None) -> Path:
    candidates = []
    if raw:
        candidates.append(Path(raw))
    import os
    if os.environ.get("GACHA_ARTIST_SOURCE"):
        candidates.append(Path(os.environ["GACHA_ARTIST_SOURCE"]))
    candidates.append(DEFAULT_SOURCE)
    for p in candidates:
        if (p / "noobai_data.json").is_file():
            return p
    raise RuntimeError(
        "找不到画师资料目录（需要 noobai_data.json）："
        + " / ".join(str(p) for p in candidates)
        + "；可用 --source 或 GACHA_ARTIST_SOURCE 指定")


def load_sources(src: Path) -> dict:
    artists = json.loads((src / "noobai_data.json").read_text(encoding="utf-8-sig"))["artists"]
    profiles_path = src / "artist_profiles" / "artist_styles_collected.json"
    profiles = {}
    if profiles_path.is_file():
        data = json.loads(profiles_path.read_text(encoding="utf-8-sig"))
        profiles = {int(a["index"]): a for a in data.get("artists", []) if a.get("index")}
    select_path = src / "select_artist.md"
    text = select_path.read_text(encoding="utf-8") if select_path.is_file() else ""
    selected = {int(x) for x in re.findall(r"★#(\d+)", text)}
    core = {int(x) for x in re.findall(r"🌟\s*核心\s*\n★#(\d+)", text)}
    fav_path = src / "favorites.json"
    favorites = set()
    if fav_path.is_file():
        favorites = {int(x) for x in json.loads(
            fav_path.read_text(encoding="utf-8-sig")).get("favorites", [])}
    thumbs = src / "artist_style_test_20260526" / "thumbnails"
    by_index = {}
    if thumbs.is_dir():
        for f in thumbs.iterdir():
            m = re.match(r"^(\d+)_", f.name)
            if m and f.is_file() and f.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp"):
                by_index[int(m.group(1))] = f.name
    return {"artists": artists, "profiles": profiles, "selected": selected,
            "core": core, "favorites": favorites, "thumbs_dir": thumbs,
            "thumbs": by_index}


def build_items(src: dict) -> list[dict]:
    artists = src["artists"]
    # 898 位画师被批量回填了同一组通用标签，它们没有区分度，会污染语义结果。
    common = Counter(tuple(a.get("styles") or []) for a in artists).most_common(1)[0][0]
    items = []
    for i, a in enumerate(artists):
        index = i + 1
        styles = [str(s).strip() for s in (a.get("styles") or []) if str(s).strip()]
        distinct = tuple(styles) != common and bool(styles)
        selected, core = index in src["selected"], index in src["core"]
        favorite = index in src["favorites"]
        if not (distinct or selected or core or favorite):
            continue
        p = src["profiles"].get(index, {})
        cn = [str(x).strip() for x in (p.get("styles_cn") or []) if str(x).strip()]
        en = [str(x).strip() for x in (p.get("styles_en") or []) if str(x).strip()]
        if not cn and not en:
            # 中英标签按「中文在前、英文在后」的回填规律切分
            cn = [s for s in styles if re.search(r"[\u4e00-\u9fff]", s)]
            en = [s for s in styles if s not in cn]
        parts = [str(a.get("name", "")).strip()]
        parts += cn + en
        for key in ("genre", "genre_en"):
            if p.get(key):
                parts.append(str(p[key]).strip())
        if p.get("description"):
            parts.append(str(p["description"]).strip())
        if core:
            parts.append("核心画师 精选")
        elif selected:
            parts.append("精选画师")
        if favorite:
            parts.append("收藏画师")
        items.append({
            "index": index,
            "name": str(a.get("name", "")).strip(),
            "styles_cn": cn[:8],
            "styles_en": en[:8],
            "genre": str(p.get("genre") or ""),
            "weight": str(p.get("weight") or ""),
            "core": core,
            "selected": selected,
            "favorite": favorite,
            "thumb": src["thumbs"].get(index),
            "_tags": list(dict.fromkeys(cn + en + ([p["genre"]] if p.get("genre") else []))),
            "_text": " ".join(x for x in parts if x),
        })
    return items


def build(src: Path, force: bool) -> dict:
    embed.prepare_model(force=force)
    data = load_sources(src)
    items = build_items(data)
    if not items:
        raise RuntimeError("没有可索引的画师，检查源目录数据是否完整")
    # 标签单独编码一份，用来给出「为什么命中」的可解释依据
    tags = list(dict.fromkeys(t for it in items for t in it["_tags"]))
    tag_pos = {t: i for i, t in enumerate(tags)}
    texts = [it["_text"] for it in items]
    print(f"[semantics] 编码 {len(items)} 位画师 / {len(tags)} 个风格标签 ...")
    vectors = embed.encode(texts)
    tag_vectors = embed.encode(tags)
    INDEX_DIR.mkdir(parents=True, exist_ok=True)
    np.save(INDEX_DIR / "vectors.npy", vectors)
    np.save(INDEX_DIR / "tag_vectors.npy", tag_vectors)
    (INDEX_DIR / "tags.json").write_text(
        json.dumps(tags, ensure_ascii=False), encoding="utf-8")
    clean = []
    for it in items:
        row = {k: v for k, v in it.items() if not k.startswith("_")}
        row["tag_ids"] = [tag_pos[t] for t in it["_tags"]]
        clean.append(row)
    meta = {
        "encoder": ENCODER_NAME,
        "dim": embed.DIM,
        "built_at": datetime.now().isoformat(timespec="seconds"),
        "source": str(src),
        "thumbs_dir": str(data["thumbs_dir"].resolve()),
        "items": clean,
    }
    (INDEX_DIR / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    stat = {
        "items": len(clean), "tags": len(tags),
        "core": sum(1 for x in clean if x["core"]),
        "selected": sum(1 for x in clean if x["selected"]),
        "favorite": sum(1 for x in clean if x["favorite"]),
        "thumbs": sum(1 for x in clean if x["thumb"]),
        "model": str(embed.model_dir()),
    }
    print("[semantics] 索引完成:", json.dumps(stat, ensure_ascii=False))
    return stat


def index_ready() -> bool:
    return all((INDEX_DIR / n).is_file()
               for n in ("meta.json", "vectors.npy", "tags.json", "tag_vectors.npy"))


def main() -> int:
    ap = argparse.ArgumentParser(description="构建画师语义索引")
    ap.add_argument("--source", default=None, help="画师资料目录")
    ap.add_argument("--force", action="store_true", help="强制重新复制模型并重建索引")
    ap.add_argument("--if-missing", action="store_true",
                    help="索引已存在则跳过；缺依赖时只告警不阻断 start.bat")
    args = ap.parse_args()
    if args.if_missing and index_ready() and not args.force:
        print("[semantics] 索引已存在，跳过构建")
        return 0
    try:
        build(resolve_source(args.source), args.force)
        return 0
    except Exception as exc:
        if args.if_missing:
            print(f"[semantics] WARN 语义索引未就绪（不影响抽卡主流程）：{exc}")
            return 0
        print(f"[semantics] ERROR {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
