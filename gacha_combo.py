# -*- coding: utf-8 -*-
"""组合配方引擎：把 JSON 池 + wildcards TXT 词卡池按「配方」拼成完整 prompt。

配方 = combos/*.json，两种模式可混用：
  slots    声明式槽位：
             {"pool": <精确名/glob/类别/顶层目录>, "count": N,
              "weight": 0~1, "filter": "关键字"}
  template 文本模板（沿用 A1111 的 __池__ 写法，扩展 # / ~ 修饰符）：
             "1girl, __AnimagineXLV3/character__, __组合预设/服装-比基尼__"

模板语法：
  __池__        抽 1 条
  __池#3__      同池抽 3 条（不重复），逗号拼接
  __池~__       50% 概率出现（摸空不留痕）
  __池#2~__     组合：50% 概率抽 2 条
  池名支持 glob：__DanbooruTAG/hair_*__ 命中多文件时合并均匀抽

CLI：
  python gacha_combo.py 随机动漫少女 --pulls 2
  python gacha_combo.py combos/海边比基尼.json --pulls 4 --seed 42 --gen
  python gacha_combo.py --list
"""

import argparse
import fnmatch
import glob
import json
import os
import random
import re
import sys

import gacha
import gacha_wildcards as wc

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
COMBO_DIR = os.path.join(BASE_DIR, "combos")
TOKEN_RE = re.compile(r"__([\w./\-*]+?)(?:#(\d+))?(~)?__")

# generate_from_prompts 允许透传的生图参数键
GEN_KEYS = ("model", "project", "seed", "width", "height", "steps", "cfg",
            "negative", "fix_face", "hires", "denoise", "face_denoise",
            "upscale", "sidecar", "prepend", "engine", "base",
            "loras", "clip_skip")


# --------------------------------------------------------------------------
# 池加载与解析
# --------------------------------------------------------------------------

def load_all_pools(json_files=(), wc_root=None):
    """JSON 池 + 全部 TXT 词卡池。json_files 为空时只载词卡。"""
    pools = []
    for f in json_files:
        pools.extend(gacha.load_pools(f))
    pools.extend(wc.scan_wildcards(wc_root))
    return pools


def resolve_pools(spec, all_pools):
    """池规格 -> 池列表。精确名 → glob → 类别名 → 顶层目录 → 子串，逐级兜底。"""
    spec = (spec or "").strip()
    if not spec:
        return []
    hit = [p for p in all_pools if p.name == spec]
    if hit:
        return hit
    hit = [p for p in all_pools if fnmatch.fnmatch(p.name, spec)]
    if hit:
        return hit
    return [p for p in all_pools
            if p.friendly == spec
            or p.name.split("/", 1)[0] == spec
            or spec in p.name]


def draw_tags(rng, pools, count):
    """从若干池合并后的虚拟大池里不重复抽 count 条的 tags。"""
    if not pools:
        return []
    m = wc.merge_pools(pools)
    k = min(max(1, int(count)), len(m.items))
    return [m.items[i]["tags"] for i in rng.sample(range(len(m.items)), k)]


# --------------------------------------------------------------------------
# 模板展开
# --------------------------------------------------------------------------

def expand_template(tpl, all_pools, rng):
    """展开模板里的 __池__ / __池#N__ / __池~__ 占位符。"""
    def repl(m):
        name, n, maybe = m.group(1), int(m.group(2) or 1), bool(m.group(3))
        if maybe and rng.random() < 0.5:
            return ""
        tags = draw_tags(rng, resolve_pools(name, all_pools), n)
        return ", ".join(tags) if tags else m.group(0)  # 找不到池原样保留
    out = TOKEN_RE.sub(repl, tpl or "")
    out = re.sub(r"(,\s*){2,}", ", ", out)   # 清掉空槽残留的多余逗号
    return out.strip(" ,")


# --------------------------------------------------------------------------
# 配方执行
# --------------------------------------------------------------------------

def run_recipe(recipe, all_pools, rng):
    """执行一次配方 -> {prompt, detail}。detail 记录每个槽位抽到了什么。"""
    parts, detail = [], []
    if recipe.get("fixed_head"):
        head = str(recipe["fixed_head"]).strip()
        if head:
            parts.append(head)
            # 必须记入 detail：前端卡片与 prompt 重建都依赖 detail，
            # 缺了它 fixed_head 会在 UI 显示和一键生图时丢失
            detail.append({"slot": "fixed_head", "tags": [head]})
    for slot in recipe.get("slots", []):
        if rng.random() > float(slot.get("weight", 1.0)):
            detail.append({"slot": slot.get("pool"), "skipped": True, "tags": []})
            continue
        pools = gacha.apply_filter_spec(
            resolve_pools(slot.get("pool", ""), all_pools),
            slot.get("filter", ""))
        tags = draw_tags(rng, pools, int(slot.get("count", 1) or 1))
        if tags:
            parts.extend(tags)
            detail.append({"slot": slot.get("pool"), "tags": tags})
    if recipe.get("template"):
        text = expand_template(recipe["template"], all_pools, rng)
        if text:
            parts.append(text)
            detail.append({"slot": "template", "tags": [text]})
    if recipe.get("fixed_tail"):
        tail = str(recipe["fixed_tail"]).strip()
        if tail:
            parts.append(tail)
            detail.append({"slot": "fixed_tail", "tags": [tail]})
    prompt = ", ".join(p for p in parts if p)
    prompt = re.sub(r"(,\s*){2,}", ", ", prompt).strip(" ,")
    return {"prompt": prompt, "detail": detail}


def sanitize_recipe_name(name):
    """配方名 -> 安全文件名（保留中英文数字-_，其余转 _）。"""
    name = (name or "").strip() or "未命名配方"
    return re.sub(r'[\\/:*?"<>|\s]+', "_", name)


def recipe_path(name_or_file):
    fp = name_or_file
    if not os.path.isfile(fp):
        base = sanitize_recipe_name(name_or_file)
        if not base.endswith(".json"):
            base += ".json"
        fp = os.path.join(COMBO_DIR, base)
    return fp


def load_recipe(name_or_file):
    with open(recipe_path(name_or_file), encoding="utf-8-sig") as fh:
        return json.load(fh)


def save_recipe(recipe, name=None):
    """保存配方到 combos/，返回文件名。"""
    os.makedirs(COMBO_DIR, exist_ok=True)
    name = name or recipe.get("name") or "未命名配方"
    recipe = dict(recipe, name=name)
    fp = recipe_path(name)
    with open(fp, "w", encoding="utf-8") as fh:
        json.dump(recipe, fh, ensure_ascii=False, indent=2)
    return os.path.basename(fp)


def delete_recipe(name_or_file):
    fp = recipe_path(name_or_file)
    if os.path.isfile(fp):
        os.remove(fp)
        return True
    return False


def list_recipes():
    """列出 combos/*.json 全部配方（含完整内容，文件都很小）。"""
    out = []
    for fp in sorted(glob.glob(os.path.join(COMBO_DIR, "*.json"))):
        try:
            with open(fp, encoding="utf-8-sig") as fh:
                r = json.load(fh)
            out.append({"file": os.path.basename(fp),
                        "name": r.get("name") or os.path.basename(fp),
                        "recipe": r})
        except Exception:  # noqa: BLE001
            continue
    return out


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def main(argv=None):
    ap = argparse.ArgumentParser(prog="gacha_combo",
                                 description="组合配方抽卡：词卡 × JSON 池 → 完整 prompt")
    ap.add_argument("recipe", nargs="?", help="配方名或 combos/xxx.json 路径")
    ap.add_argument("--pulls", "-p", type=int, default=1, help="连抽次数")
    ap.add_argument("--seed", type=int, default=None, help="随机种子（可复现）")
    ap.add_argument("--json", action="store_true", help="输出 JSON 明细")
    ap.add_argument("--gen", action="store_true", help="抽完直接送 ComfyUI 生图")
    ap.add_argument("--list", action="store_true", help="列出全部配方后退出")
    args = ap.parse_args(argv)

    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

    if args.list:
        for r in list_recipes():
            rc = r["recipe"]
            print(f"◆ {r['file']:<28} {r['name']}"
                  f"（slots:{len(rc.get('slots', []))}"
                  f"{' + template' if rc.get('template') else ''}）")
        return 0

    if not args.recipe:
        ap.error("请给配方名（--list 可看全部）")

    recipe = load_recipe(args.recipe)
    pools = load_all_pools()
    rng = random.Random(args.seed)
    draws = [run_recipe(recipe, pools, rng) for _ in range(max(1, args.pulls))]

    if args.json:
        print(json.dumps(draws, ensure_ascii=False, indent=2))
    else:
        for i, d in enumerate(draws, 1):
            print(f"[{i}] {d['prompt']}")

    if args.gen:
        import gacha_to_sdxl
        gen = {k: v for k, v in (recipe.get("gen") or {}).items() if k in GEN_KEYS}
        res = gacha_to_sdxl.generate_from_prompts(
            [d["prompt"] for d in draws],
            outdir=str(gacha_to_sdxl.WORKSPACE / "outputs"), **gen)
        print(json.dumps({k: res[k] for k in ("ok", "images", "error")},
                         ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
