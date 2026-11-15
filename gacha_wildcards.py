# -*- coding: utf-8 -*-
"""把 stable-diffusion-webui-wildcards 词卡库接入 gacha 抽卡体系。

约定：
  - 每个 *.txt = 一个池，池名 = 相对路径（正斜杠、无扩展名），
    与 A1111 扩展里的 __池名__ 写法完全一致（如 DanbooruTAG/hair_color）；
  - 每行一个候选：label = tags = 行文本；
  - friendly 类别按“文件名片段 + 顶层目录”自动归类，供 UI 分组与按类过滤；
  - 词卡目录保持唯一事实源（A1111 扩展与本抽卡器共用），不做格式转换。

用法：
  import gacha_wildcards as wc
  pools = wc.scan_wildcards()          # -> [gacha.Pool]
  big   = wc.merge_pools(pools[:5])    # 多池合成虚拟大池（均匀抽取）
"""

import os

import gacha  # 复用 Pool 数据结构

DEFAULT_ROOT = os.environ.get("GACHA_WILDCARDS_DIR") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "stable-diffusion-webui-wildcards", "wildcards")

# (类别, 片段表)：英文片段按“文件名片段”精确/前缀匹配，中文片段按整词包含匹配；
# 先命中先赢，大小写不敏感。覆盖根目录散落的中文词卡（人物-*/构图-*/自然景观-* 等）。
FRIENDLY_RULES = [
    ("角色", ("character", "char", "类型")),
    ("画师", ("artists", "artist", "画师")),
    ("服装", ("服装", "衣服", "穿搭", "鞋袜", "装饰",
              "attire", "bra", "panties", "legwear", "headwear",
              "sleeves", "swimsuit", "uniform", "clothing", "shoes", "dress")),
    ("背景", ("背景", "景观", "场景", "background", "backgrounds",
              "locations", "places")),
    ("发型", ("hair", "头发")),
    ("眼睛", ("eyes", "eye", "eyewear", "眼睛")),
    ("表情", ("expression", "face", "facial", "面部", "唇膏")),
    ("动作", ("sex", "posture", "action", "pose", "gestures", "动作", "摆位")),
    ("身体", ("breasts", "breast", "body", "ass", "nudity", "skin",
              "tail", "wings", "pussy", "nipples", "ears",
              "胸部", "耳朵", "脖子")),
    ("构图", ("composition", "image", "chart", "framing", "angle",
              "构图", "镜头", "视角")),
    ("风格", ("style", "styles", "movements", "film", "cameras", "audio",
              "画风", "材质", "纹理")),
    ("动物", ("animals", "animal", "cats", "birds", "dog")),
    ("颜色", ("colors", "color", "palette", "色彩")),
    ("物品", ("food", "technology", "objects", "toys", "board", "weapon",
              "flowers", "fire", "water", "game", "music")),
    ("标签", ("negativeprompt", "negative", "tag")),
]


def friendly_for(top, stem):
    """根据顶层目录 + 文件名片段推断类别，兜底用顶层目录名。"""
    segs = [s for s in stem.lower().replace("-", "_").split("_") if s]
    for friendly, frags in FRIENDLY_RULES:
        for frag in frags:
            if any("\u4e00" <= ch <= "\u9fff" for ch in frag):
                # 中文片段：整词包含即命中（如 服装-女性简单穿搭）
                if frag in stem:
                    return friendly
            elif any(seg == frag or seg.startswith(frag) for seg in segs):
                return friendly
    # DanbooruTAG 长尾统一归入“标签”，其余按顶层目录兜底
    return "标签" if top == "DanbooruTAG" else top


def scan_wildcards(root=None):
    """扫描词卡库 -> [gacha.Pool]。空文件自动跳过。"""
    root = root or DEFAULT_ROOT
    pools = []
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
            items = [{"label": ln, "tags": ln, "payload": ln} for ln in lines]
            top = name.split("/", 1)[0]
            stem = os.path.splitext(fn)[0]
            pools.append(gacha.Pool(name, friendly_for(top, stem), fp, items))
    return pools


def merge_pools(pools):
    """把多个池合成一个虚拟大池（glob 命中多文件时保证均匀抽取）。"""
    pools = list(pools)
    items = [it for p in pools for it in p.items]
    name = "+".join(p.name for p in pools) or "empty"
    return gacha.Pool(name,
                      pools[0].friendly if pools else "条目",
                      pools[0].file if pools else "",
                      items)


if __name__ == "__main__":  # 自检：python gacha_wildcards.py
    import collections
    ps = scan_wildcards()
    cnt = collections.Counter(p.friendly for p in ps)
    print(f"词卡根目录: {DEFAULT_ROOT}")
    print(f"共 {len(ps)} 池 / {sum(len(p) for p in ps)} 条\n类别分布：")
    for f, c in cnt.most_common():
        print(f"  {c:4} 池  {f}")
