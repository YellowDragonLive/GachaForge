# -*- coding: utf-8 -*-
"""词卡库扫描（迁移自 gacha_wildcards.py）：每个 .txt = 一个池。"""
from __future__ import annotations

import os

from .pools import Item, PoolData

FRIENDLY_RULES = [
    ("角色", ("character", "char", "类型")),
    ("画师", ("artists", "artist", "画师")),
    ("服装", ("服装", "衣服", "穿搭", "鞋袜", "装饰", "attire", "bra", "panties",
              "legwear", "headwear", "sleeves", "swimsuit", "uniform", "clothing",
              "shoes", "dress")),
    ("背景", ("背景", "景观", "场景", "background", "backgrounds", "locations", "places")),
    ("发型", ("hair", "头发")),
    ("眼睛", ("eyes", "eye", "eyewear", "眼睛")),
    ("表情", ("expression", "face", "facial", "面部", "唇膏")),
    ("动作", ("sex", "posture", "action", "pose", "gestures", "动作", "摆位")),
    ("身体", ("breasts", "breast", "body", "ass", "nudity", "skin", "tail", "wings",
              "pussy", "nipples", "ears", "胸部", "耳朵", "脖子")),
    ("构图", ("composition", "image", "chart", "framing", "angle", "构图", "镜头", "视角")),
    ("风格", ("style", "styles", "movements", "film", "cameras", "audio", "画风", "材质", "纹理")),
    ("动物", ("animals", "animal", "cats", "birds", "dog")),
    ("颜色", ("colors", "color", "palette", "色彩")),
    ("物品", ("food", "technology", "objects", "toys", "board", "weapon", "flowers",
              "fire", "water", "game", "music")),
    ("标签", ("negativeprompt", "negative", "tag")),
]


def friendly_for(top: str, stem: str) -> str:
    segs = [s for s in stem.lower().replace("-", "_").split("_") if s]
    for friendly, frags in FRIENDLY_RULES:
        for frag in frags:
            if any("\u4e00" <= ch <= "\u9fff" for ch in frag):
                if frag in stem:
                    return friendly
            elif any(seg == frag or seg.startswith(frag) for seg in segs):
                return friendly
    return "标签" if top == "DanbooruTAG" else top


def scan(root: str) -> list[PoolData]:
    """扫描词卡目录 → PoolData 列表；空文件跳过。"""
    pools: list[PoolData] = []
    if not os.path.isdir(root):
        return pools
    for dirpath, _dirs, files in os.walk(root):
        for fn in sorted(files):
            if not fn.lower().endswith(".txt"):
                continue
            fp = os.path.join(dirpath, fn)
            rel = os.path.relpath(fp, root)
            name = os.path.splitext(rel)[0].replace(os.sep, "/")
            try:
                with open(fp, encoding="utf-8-sig", errors="ignore") as fh:
                    lines = [ln.strip() for ln in fh if ln.strip()]
            except OSError:
                continue
            if not lines:
                continue
            top = name.split("/", 1)[0]
            stem = os.path.splitext(fn)[0]
            pools.append(PoolData(name, friendly_for(top, stem), fp,
                                  [Item(ln, ln, ln) for ln in lines]))
    return pools
