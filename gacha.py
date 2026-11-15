# -*- coding: utf-8 -*-
"""多 JSON 通用抽卡器 (Gacha Tool for Multiple / Varied JSON Pools).

核心诉求：
  - 面对多变的多个 json（对象 / 数组 / 嵌套 / 扁平字典），都能自动识别"数据池"；
  - 多项随机抽卡：一次连抽 = 从每个数据池各随机抽取 K 条，拼成一张"卡"；
  - 支持纯随机抽取、关键字过滤、固定随机种子复现；
  - 输出：文本卡片 / JSON / CSV，并可一键拼出供出图使用的标签 prompt。

示例：
  python gacha.py                          # 默认 action.json + zh_TW.json
  python gacha.py action.json zh_TW.json --pulls 5 --count 2 --prompt
  python gacha.py --pools zh_TW,action --pulls 3 --prompt --seed 42
  python gacha.py --list-pools
  python gacha.py zh_TW.json --filter 原神 --pulls 3
"""

import argparse
import datetime
import glob
import json
import os
import random
import re
import sys

# --------------------------------------------------------------------------
# 常量与池数据结构
# --------------------------------------------------------------------------

DEFAULT_FILES = ["action.json", "zh_TW.json"]

# 数组元素里用于当作"名字/显示名"的键
NAME_KEYS = ("name", "名称", "label", "title", "character", "角色", "cn", "en", "tag")
# 数组元素里用于当作"标签串"的键
TAGS_KEYS = ("tags", "tag", "styleColumns", "标签", "风格")
# 用作池友好名称的关键字
ARTIST_HINT = ("artist", "画师")
STYLE_HINT = ("style", "column", "风格")
CHAR_HINT = ("char", "角色")
ACTION_HINT = ("action", "动作")


class Pool:
    """一个数据池：名字 + 显示名 + 来源文件 + 条目列表。

    每个条目是 {label, tags, payload}：label 用于展示，tags 用于拼 prompt。
    """

    __slots__ = ("name", "friendly", "file", "items")

    def __init__(self, name, friendly, file, items):
        self.name = name
        self.friendly = friendly
        self.file = file
        self.items = items

    def __len__(self):
        return len(self.items)


# --------------------------------------------------------------------------
# JSON 结构自适应：识别数据池
# --------------------------------------------------------------------------

def looks_like_token_list(s):
    """判断一个字符串是否为「空格分隔的短词列表」（如 styleColumns），
    若是则拆成独立标签池；逗号分隔的文本一律当作文本不拆。
    """
    s = s.strip()
    if not s or "," in s or "，" in s or "、" in s or "：" in s:
        return False
    tokens = s.split()
    if len(tokens) < 3:
        return False
    for t in tokens:
        if not re.fullmatch(r"[A-Za-z0-9_\-/()\.']+", t):
            return False
    return True


def friendly_for(key, name):
    n = (str(key) + " " + str(name)).lower()
    if any(h in n for h in ARTIST_HINT):
        return "画师"
    if any(h in n for h in STYLE_HINT):
        return "风格"
    if any(h in n for h in CHAR_HINT):
        return "角色"
    if any(h in n for h in ACTION_HINT):
        return "动作"
    if "tag" in n or "标签" in n:
        return "标签"
    return "条目"


def pool_from_list(key, file, data, name):
    """把一个 JSON 数组变成一个池。支持：标量数组、对象数组、嵌套数组。"""
    items = []
    for el in data:
        if isinstance(el, dict):
            label = None
            for k in NAME_KEYS:
                v = el.get(k)
                if v not in (None, ""):
                    label = str(v)
                    break
            if label is None:
                for v in el.values():  # 无名称键时取第一个标量字段兜底
                    if isinstance(v, (str, int, float)) and not isinstance(v, bool):
                        label = str(v)
                        break
            if label is None:
                label = f"<对象{len(items) + 1}>"
            tags = None
            for tk in TAGS_KEYS:
                if tk in el:
                    tv = el[tk]
                    if isinstance(tv, list):
                        tags = ", ".join(str(x) for x in tv)
                    elif isinstance(tv, str) and tv.strip():
                        tags = tv
                    break
            items.append({"label": label, "tags": (tags or label).strip(), "payload": el})
        elif isinstance(el, list):
            joined = ", ".join(str(x) for x in el)
            items.append({"label": joined[:80] or "<空列表>", "tags": joined, "payload": el})
        else:
            s = str(el)
            items.append({"label": s, "tags": s, "payload": el})
    return Pool(name, friendly_for(key, name), file, items)


def discover_pools(data, file, prefix):
    """递归识别一个 JSON 对象里的所有数据池。"""
    pools = []
    if isinstance(data, dict):
        if not data:
            return pools
        # 扁平字典（键 -> 标量）：整体作为一个「名字/标签」池，如 zh_TW.json
        if all(isinstance(v, (str, int, float)) for v in data.values()):
            filebase = os.path.splitext(os.path.basename(file))[0]
            name = prefix or filebase
            items = [{"label": str(k), "tags": str(v), "payload": v}
                     for k, v in data.items()]
            keys_cn = "".join(data.keys())
            has_cjk = any("\u4e00" <= ch <= "\u9fff" for ch in keys_cn)
            friendly = "角色" if has_cjk else friendly_for(filebase, prefix)
            pools.append(Pool(name, friendly, file, items))
            return pools
        for k, v in data.items():
            base = f"{prefix}.{k}" if prefix else k
            if isinstance(v, list):
                pools.append(pool_from_list(k, file, v, base))
            elif isinstance(v, dict):
                pools.extend(discover_pools(v, file, base))
            elif isinstance(v, str) and looks_like_token_list(v):
                items = [{"label": t, "tags": t, "payload": t} for t in v.split()]
                pools.append(Pool(base, friendly_for(k, base), file, items))
    elif isinstance(data, list):
        filebase = os.path.splitext(os.path.basename(file))[0]
        pools.append(pool_from_list(filebase, file, data, prefix or filebase))
    return pools


def load_pools(file):
    """载入一个 JSON 文件并识别其中的全部数据池。"""
    if not os.path.exists(file):
        print(f"[跳过] 找不到文件：{file}", file=sys.stderr)
        return []
    with open(file, "r", encoding="utf-8-sig") as fh:
        data = json.load(fh)
    filebase = os.path.splitext(os.path.basename(file))[0]
    return discover_pools(data, file, filebase)


def expand_files(args_files):
    """展开文件参数：支持通配符 / 目录 / 默认文件。"""
    targets = []
    if not args_files:
        args_files = DEFAULT_FILES
    for f in args_files:
        if os.path.isdir(f):
            targets.extend(sorted(glob.glob(os.path.join(f, "*.json"))))
        else:
            targets.extend(sorted(glob.glob(f)))
    # 去重且保持顺序
    seen, out = set(), []
    for f in targets:
        if f not in seen:
            seen.add(f)
            out.append(f)
    return out


# --------------------------------------------------------------------------
# 抽卡逻辑
# --------------------------------------------------------------------------

def pick_pools(all_pools, spec):
    """按 --pools 规格筛选池；空规格 = 全部。支持子串匹配。"""
    if not spec:
        return list(all_pools)
    wanted = [s.strip() for s in spec.split(",") if s.strip()]
    result, matched = [], set()
    for w in wanted:
        found = [p for p in all_pools
                 if w in p.name or w == p.friendly or p.name.startswith(w)]
        for p in found:
            if id(p) not in matched:
                matched.add(id(p))
                result.append(p)
    return result or list(all_pools)


def filter_pool(pool, keywords):
    """关键字过滤：条目 label/tags 命中任一关键字即保留（OR）。"""
    if not keywords:
        return pool
    kept = [it for it in pool.items
            if any(kw in it["label"] or kw in it["tags"] for kw in keywords)]
    return Pool(pool.name, pool.friendly, pool.file, kept)


def apply_filter_spec(pools, spec):
    """按池过滤。spec 支持两类条目（逗号分隔，可混用）：
      - 全局：Fate            -> 对所有池生效
      - 按池：角色:Fate        -> 只对名字/友好名含"角色"的池生效
    返回过滤后的池列表（保留非空池）。
    """
    if not spec:
        return [p for p in pools if len(p) > 0]
    global_kws = []
    per_pool = {}
    for part in str(spec).split(","):
        part = part.strip()
        if not part:
            continue
        if ":" in part or "：" in part:
            pk, val = re.split(r"[:：]", part, maxsplit=1)
            pk, val = pk.strip(), val.strip()
            if val:
                per_pool.setdefault(pk, []).append(val)
        else:
            global_kws.append(part)
    out = []
    for pool in pools:
        kws = list(global_kws)
        for pk, vals in per_pool.items():
            if pk in pool.name or pk == pool.friendly or pool.name.startswith(pk):
                kws.extend(vals)
        filtered = filter_pool(pool, kws)
        if len(filtered) > 0:
            out.append(filtered)
    return out


def expand_nested_card(card, all_pools, rng, max_depth=3):
    """支持抽卡结果中嵌套引用其它池（例如 标签/名字 中含 @zh_TW.json, @action, [pool]）。

    若检测到子池引用，自动从子池抽 1 条进行替换/展平。
    """
    if max_depth <= 0 or not all_pools:
        return card
    pools_map = {p.name: p for p in all_pools}
    pools_map.update({p.friendly: p for p in all_pools})
    pools_map.update({p.file: p for p in all_pools})
    pools_map.update({os.path.basename(p.file): p for p in all_pools})

    new_card = []
    for item in card:
        tags = item.get("tags") or ""
        label = item.get("label") or ""
        text = f"{label} {tags}"
        matches = re.findall(r"@([\w\.\-]+)|\[([\w\.\-]+)\]", text)
        sub_refs = [m[0] or m[1] for m in matches if (m[0] or m[1])]
        if sub_refs:
            drawn_subs = []
            for ref in sub_refs:
                target_pool = pools_map.get(ref) or pools_map.get(ref + ".json")
                if target_pool and len(target_pool.items) > 0:
                    sub_it = rng.choice(target_pool.items)
                    sub_card_item = {
                        "pool": target_pool.name,
                        "friendly": target_pool.friendly,
                        "label": f"{item['label']} ➔ {sub_it['label']}",
                        "tags": f"{item['tags']}, {sub_it['tags']}"
                    }
                    drawn_subs.append(sub_card_item)
            if drawn_subs:
                new_card.extend(expand_nested_card(drawn_subs, all_pools, rng, max_depth - 1))
            else:
                new_card.append(item)
        else:
            new_card.append(item)
    return new_card


def draw_pull(rng, pools, count, no_repeat, used_hist, all_pools=None, fixed=""):
    """执行一次连抽：从每个池各抽 count 条。如果有用户附加词，直接带上。"""
    card = []
    if fixed and str(fixed).strip():
        f_str = str(fixed).strip()
        card.append({"pool": "custom", "friendly": "附加 Prompt", "label": f_str, "tags": f_str})

    for pool in pools:
        avail = pool.items
        if no_repeat:
            hist = used_hist.setdefault(pool.name, set())
            remaining = [i for i in range(len(pool.items)) if i not in hist]
            if not remaining:  # 一轮用完，重置进入下一轮
                hist.clear()
                remaining = list(range(len(pool.items)))
            k = min(count, len(remaining))
            idxs = rng.sample(remaining, k)
            hist.update(idxs)
        else:
            k = min(count, len(avail))
            idxs = rng.sample(range(len(avail)), k)
        for i in idxs:
            it = pool.items[i]
            card.append({"pool": pool.name, "friendly": pool.friendly,
                         "label": it["label"], "tags": it["tags"]})

    if all_pools:
        card = expand_nested_card(card, all_pools, rng)
    return card


# --------------------------------------------------------------------------
# 输出
# --------------------------------------------------------------------------

def prompt_tag(it):
    """取一个条目用于拼 prompt 的标签：中文说明类条目退化为其短 ASCII 名，
    否则直接取标签串。"""
    tags = (it.get("tags") or "").strip()
    label = (it.get("label") or "").strip()
    has_cjk = any("\u4e00" <= ch <= "\u9fff" for ch in tags)
    if has_cjk:
        if label and label != tags and all(ord(ch) < 128 for ch in label):
            return label
        return ""
    return tags


def render_text(draws, tag_sep):
    lines = []
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    lines.append("🎴 抽卡器 · 连抽结果 · " + now)
    lines.append("=" * 56)
    for n, card in enumerate(draws, 1):
        lines.append(f"\n──── 第 {n} 抽 ────")
        for it in card:
            head = f"【{it['friendly']} · {it['pool']}】"
            if it["tags"] and it["tags"] != it["label"]:
                lines.append(head)
                lines.append(f"  {it['label']}")
                lines.append(f"  标签: {it['tags']}")
            else:
                lines.append(f"{head}  {it['label']}")
    if tag_sep is not None:
        lines.append("\n" + "=" * 56)
        lines.append("拼出的 Prompt：")
        for n, card in enumerate(draws, 1):
            parts = [p for p in (prompt_tag(it) for it in card) if p]
            lines.append(f"  [{n}] {tag_sep.join(parts)}")
    return "\n".join(lines)


def render_json(draws):
    return json.dumps(draws, ensure_ascii=False, indent=2)


def render_csv(draws):
    import csv
    import io
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["pull", "pool", "friendly", "label", "tags"])
    for n, card in enumerate(draws, 1):
        for it in card:
            writer.writerow([n, it["pool"], it["friendly"], it["label"], it["tags"]])
    return buf.getvalue().rstrip("\r\n")


def render_list_pools(all_pools):
    lines = ["📦 识别到的数据池：\n"]
    by_file = {}
    for p in all_pools:
        by_file.setdefault(p.file, []).append(p)
    for file, pools in by_file.items():
        lines.append(f"◆ {file}")
        for p in pools:
            lines.append(f"    {p.name:<40} [ {p.friendly} ]  {len(p)} 条")
        lines.append("")
    return "\n".join(lines)


# --------------------------------------------------------------------------
# 主流程
# --------------------------------------------------------------------------

def parse_args(argv=None):
    ap = argparse.ArgumentParser(
        prog="gacha",
        description="多 JSON 通用抽卡器：任意结构 JSON 自动识别数据池，多项随机抽卡。",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__.split("示例：")[-1],
    )
    ap.add_argument("files", nargs="*", metavar="JSON",
                    help="JSON 文件/通配符/目录；缺省自动使用 action.json zh_TW.json")
    ap.add_argument("--pulls", "-p", type=int, default=1,
                    help="连抽次数（默认 1）")
    ap.add_argument("--count", "-c", type=int, default=1,
                    help="每个数据池每次抽取的条数（默认 1）")
    ap.add_argument("--pools", default="",
                    help="只用指定池（逗号分隔，支持池名片段，如 artists,styleColumns）；缺省全部")
    ap.add_argument("--filter", "-f", default="",
                    help="关键字过滤（逗号分隔）。支持按池：'角色:Fate,动作:oral' 只过滤对应池；"
                         "全局：'Fate' 对所有池生效")
    ap.add_argument("--prompt", action="store_true",
                    help="额外拼接输出标签 prompt")
    ap.add_argument("--prompt-only", action="store_true",
                    help="只输出每抽拼好的 prompt 行（便于脚本复用）")
    ap.add_argument("--tag-sep", default=", ",
                    help="拼接 prompt 的分隔符（默认 ', '）")
    ap.add_argument("--fixed", default="",
                    help="用户固定不变项（例如: '1girl, solo'），会在每抽中固定带上")
    ap.add_argument("--no-repeat", action="store_true",
                    help="整次会话内每个池不重复抽取")
    ap.add_argument("--seed", type=int, default=None,
                    help="随机种子，便于复现")
    ap.add_argument("--format", choices=["text", "json", "csv"], default="text",
                    help="输出格式（默认 text）")
    ap.add_argument("--list-pools", action="store_true",
                    help="只列出识别到的数据池后退出")
    return ap.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)

    # Windows 控制台强制 UTF-8 输出，避免中文乱码
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

    files = expand_files(args.files)
    if not files:
        print("[错误] 未找到任何 JSON 文件。", file=sys.stderr)
        return 2

    all_pools = []
    for f in files:
        all_pools.extend(load_pools(f))
    if not all_pools:
        print("[错误] 未从给定 JSON 中识别出任何数据池。", file=sys.stderr)
        return 2

    if args.list_pools:
        print(render_list_pools(all_pools))
        return 0

    pools = pick_pools(all_pools, args.pools)
    pools = apply_filter_spec(pools, args.filter)
    if not pools:
        print("[错误] 过滤后没有任何可用条目。", file=sys.stderr)
        return 2

    rng = random.Random(args.seed)
    used_hist = {}
    draws = []
    for _ in range(max(1, args.pulls)):
        draws.append(draw_pull(rng, pools, max(1, args.count), args.no_repeat, used_hist, all_pools=all_pools, fixed=args.fixed))

    if args.prompt_only:
        for card in draws:
            parts = [prompt_tag(it) for it in card]
            parts = [p for p in parts if p]
            print(args.tag_sep.join(parts))
        return 0

    if args.format == "json":
        print(render_json(draws))
    elif args.format == "csv":
        print(render_csv(draws))
    else:
        print(render_text(draws, args.tag_sep if args.prompt else None))
    return 0


if __name__ == "__main__":
    sys.exit(main())
