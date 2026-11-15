# -*- coding: utf-8 -*-
"""配方执行引擎（迁移自 gacha_combo.py）：槽位 + __池__ 模板 → 完整 prompt。"""
from __future__ import annotations

import fnmatch
import re
from typing import Any

from .pools import PoolData, apply_filter_spec

TOKEN_RE = re.compile(r"__([\w./\-*]+?)(?:#(\d+))?(~)?__")


def resolve_pools(spec: str, all_pools: list[PoolData]) -> list[PoolData]:
    """池规格 → 池列表：精确名 → glob → 类别/顶层目录 → 子串。"""
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
            if p.friendly == spec or p.name.split("/", 1)[0] == spec or spec in p.name]


def merge_pools(pools: list[PoolData]) -> PoolData:
    pools = list(pools)
    items = [it for p in pools for it in p.items]
    return PoolData("+".join(p.name for p in pools) or "empty",
                    pools[0].friendly if pools else "条目",
                    pools[0].source if pools else "", items)


def draw_tags(rng, pools: list[PoolData], count: int) -> list[str]:
    if not pools:
        return []
    merged = merge_pools(pools)
    if not merged.items:
        return []
    k = min(max(1, int(count)), len(merged.items))
    return [merged.items[i].tags for i in rng.sample(range(len(merged.items)), k)]


def expand_template(tpl: str, all_pools: list[PoolData], rng) -> str:
    """__池__ 抽 1 条 / __池#3__ 抽 3 条 / __池~__ 50% 出现 / 支持 glob。"""
    def repl(m):
        name, n, maybe = m.group(1), int(m.group(2) or 1), bool(m.group(3))
        if maybe and rng.random() < 0.5:
            return ""
        tags = draw_tags(rng, resolve_pools(name, all_pools), n)
        return ", ".join(tags) if tags else m.group(0)
    out = TOKEN_RE.sub(repl, tpl or "")
    out = re.sub(r"(,\s*){2,}", ", ", out)
    return out.strip(" ,")


def run_recipe(recipe: dict[str, Any], all_pools: list[PoolData], rng) -> dict:
    """执行一次配方 → {prompt, detail}。detail 记录每个槽位抽到了什么。"""
    parts: list[str] = []
    detail: list[dict] = []
    head = str(recipe.get("fixed_head") or "").strip()
    if head:
        parts.append(head)
        detail.append({"slot": "fixed_head", "tags": [head]})
    for slot in recipe.get("slots") or []:
        name = slot.get("pool")
        if rng.random() > float(slot.get("weight", 1.0)):
            detail.append({"slot": name, "skipped": True, "tags": []})
            continue
        pools = apply_filter_spec(resolve_pools(name or "", all_pools),
                                  slot.get("filter", ""))
        tags = draw_tags(rng, pools, int(slot.get("count", 1) or 1))
        if tags:
            parts.extend(tags)
            detail.append({"slot": name, "tags": tags})
        else:
            # 空槽位必须留痕，否则「按池过滤」把池筛掉时用户只看到槽位莫名消失。
            detail.append({
                "slot": name, "tags": [], "empty": True,
                "reason": ("未找到匹配卡池（很可能被抽卡设置里的全局过滤移除）"
                           if not pools else
                           "池内无匹配条目（检查表单「按池过滤」的关键字）"),
            })
    tpl = recipe.get("template") or ""
    if tpl:
        text = expand_template(tpl, all_pools, rng)
        if text:
            parts.append(text)
            detail.append({"slot": "template", "tags": [text]})
    tail = str(recipe.get("fixed_tail") or "").strip()
    if tail:
        parts.append(tail)
        detail.append({"slot": "fixed_tail", "tags": [tail]})
    prompt = ", ".join(p for p in parts if p)
    prompt = re.sub(r"(,\s*){2,}", ", ", prompt).strip(" ,")
    return {"prompt": prompt, "detail": detail}


def sanitize_name(name: str) -> str:
    return re.sub(r'[\\/:*?"<>|\s]+', "_", (name or "").strip() or "未命名配方")
