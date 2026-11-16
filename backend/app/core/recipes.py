# -*- coding: utf-8 -*-
"""配方执行引擎（迁移自 gacha_combo.py）：槽位 + __池__ 模板 → 完整 prompt。"""
from __future__ import annotations

import fnmatch
import re
from typing import Any

from .pools import PoolData, apply_filter_spec
from .weights import strip_weights

TOKEN_RE = re.compile(r"__([\w./\-*]+?)(?:#(\d+))?(~)?__")

# 人数类 tag：Danbooru 的 1girl / 2boys / multiple girls / solo / no humans …
# 它们把「几个人」焊死在角色条目里，多人同框时会互相打架（1girl + 1girl = 还是一个人）。
# 装配面板自己算人数，所以抽到这些 tag 一律剥掉，改由 count_tags 统一注入。
COUNT_TAG_RE = re.compile(
    r"^(?:(?:\d+\+?|multiple|no)\s*(?:girl|boy|other|human)s?|solo(?:\s+focus)?)$",
    re.IGNORECASE)


def strip_count_tags(tags: list[str]) -> tuple[list[str], list[str]]:
    """剥掉人数类 tag，返回 (剩下的, 被剥掉的)，便于在明细里留痕。"""
    kept: list[str] = []
    removed: list[str] = []
    for t in tags:
        key = str(t).strip()
        if key and COUNT_TAG_RE.match(key):
            removed.append(key)
        elif key:
            kept.append(key)
    return kept, removed


def pick_tags(pools: list[PoolData], want: str) -> list[str] | None:
    """锁定到具体条目：先按 label 精确匹配，再退化为包含匹配。

    返回该条目的全部 tag（角色条目常是「artoria pendragon (fate), fate (series)」
    这种多 tag 形式，要拆开才能和随机抽取的结果同构处理）；找不到返回 None。
    """
    want = (want or "").strip().lower()
    if not want or not pools:
        return None
    items = merge_pools(pools).items
    hit = None
    for it in items:
        if (it.label or "").strip().lower() == want:
            hit = it
            break
    if hit is None:
        for it in items:
            if want in (it.label or "").lower():
                hit = it
                break
    if hit is None:
        return None
    return [t.strip() for t in str(hit.tags or "").split(",") if t.strip()]


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


def dedupe_parts(parts: list[str]) -> list[str]:
    """按 tag 去重（保序、大小写不敏感），整段里含逗号的先拆。

    同一个 tag 从两个槽位抽到会写两遍（实测「1girl, 25-ji miku, 25-ji miku」）：
    多出来的那遍不改画面，只让 prompt 变脏、还占 token。人数与质量词尤其容易撞。
    """
    seen: set[str] = set()
    out: list[str] = []
    for chunk in parts:
        keeps: list[str] = []
        for tag in (t.strip() for t in str(chunk or "").split(",")):
            if not tag:
                continue
            key = tag.lower()
            if key in seen:
                continue
            seen.add(key)
            keeps.append(tag)
        if keeps:
            out.append(", ".join(keeps))
    return out


def strip_detail_weights(detail: list[dict]) -> list[dict]:
    """把明细里的 tags 剥掉超重权重（原地改，返回同一个 list）。

    两条抽卡路径（配方 `run_recipe` 与手工卡片 `build_prompt`）都要用：
    prompt 剥了、明细没剥的话，装配区会显示 `(x:1.2)` 而实际出图是 `x`，
    对照就永远对不上；概念索引的 key 也会带一截 `:1.2` 变成孤儿。
    `raw_tags` 留原文，是为了让人看出「这条少了 :1.2 是清理，不是抽错了」。
    """
    for item in detail:
        tags = item.get("tags") if isinstance(item, dict) else None
        if not tags:
            continue
        new_tags = [t for t in (strip_weights(x) for x in tags) if t]
        if new_tags != tags:
            item["raw_tags"] = tags
            item["stripped_weight"] = True
            item["tags"] = new_tags
    return detail


def run_recipe(recipe: dict[str, Any], all_pools: list[PoolData], rng) -> dict:
    """执行一次配方 → {prompt, detail}。detail 记录每个槽位抽到了什么。"""
    parts: list[str] = []
    detail: list[dict] = []
    head = str(recipe.get("fixed_head") or "").strip()
    if head:
        parts.append(head)
        detail.append({"slot": "fixed_head", "tags": [head]})
    # 人数由装配面板算好（0 人 no humans / 1 人 1girl / 2 人 1girl, 1boy…），
    # 放在质量词之后、内容之前，和 Danbooru 的书写惯例一致。
    count_tags = str(recipe.get("count_tags") or "").strip()
    if count_tags:
        parts.append(count_tags)
        detail.append({"slot": "count_tags", "tags": [count_tags]})
    for slot in recipe.get("slots") or []:
        name = slot.get("pool")
        if rng.random() > float(slot.get("weight", 1.0)):
            detail.append({"slot": name, "skipped": True, "tags": []})
            continue
        pools = resolve_pools(name or "", all_pools)
        filtered = apply_filter_spec(pools, slot.get("filter", ""))
        free = str(slot.get("free") or "").strip()
        pick = str(slot.get("pick") or "").strip()
        locked: list[str] = []
        if free:
            # 手填的任意值：不查池子，也不吃 filter。池里没有的东西一样要能用——
            # 自造词、外部画师名、`(masterpiece:1.2)` 这类 A1111 语法都走这条。
            # 权重修饰符不在这里剥，统一由出口的 strip_weights 处理（规则只写一处）。
            tags = [t.strip() for t in free.split(",") if t.strip()]
            locked = [free]
        elif pick:
            # 锁定优先且不吃 filter：用户明确点了这件衣服，就不该被筛选条件再筛掉。
            tags = pick_tags(pools, pick)
            if tags is None:
                detail.append({
                    "slot": name, "tags": [], "empty": True,
                    "reason": f"锁定的条目「{pick}」在池「{name}」里找不到",
                })
                continue
            locked = [pick]
        else:
            tags = draw_tags(rng, filtered, int(slot.get("count", 1) or 1))
        tags, removed_count = strip_count_tags(tags)
        if tags:
            parts.extend(tags)
            item = {"slot": name, "tags": tags}
            if locked:
                item["locked"] = locked[0]
            if free:
                item["free"] = True      # 前端据此标「手填」，不和池里抽到的混在一起
            if removed_count:
                item["dropped_count_tags"] = removed_count
            detail.append(item)
        else:
            # 空槽位必须留痕，否则「按池过滤」把池筛掉时用户只看到槽位莫名消失。
            detail.append({
                "slot": name, "tags": [], "empty": True,
                "reason": ("只抽到人数类 tag，已剥离（人数由装配面板统一控制）"
                           if removed_count else
                           "未找到匹配卡池（很可能被抽卡设置里的全局过滤移除）"
                           if not filtered else
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
    # 条目原文里手写的 `(long petticoat:1.2)` / `a:1.3` 是 SD1.5 时代的残留：一条条目只该是
    # 「一个概念」，强调程度由人在配方里决定，而不是每条自带 1.2/1.5 把 prompt 拉偏。
    # 只在「写进 prompt 的那一刻」剥掉超重权重，**池子里的原文一个字都不改** ——
    # 卡池页 / 选择器 / 重新导入看到的仍是导入时的样子，清理结果不会被写回数据。
    cleaned: list[str] = []
    for part in parts:
        if not part:
            continue
        fixed = strip_weights(part)
        if fixed:
            cleaned.append(fixed)
    parts = cleaned
    strip_detail_weights(detail)
    prompt = ", ".join(dedupe_parts(parts))
    prompt = re.sub(r"(,\s*){2,}", ", ", prompt).strip(" ,")
    return {"prompt": prompt, "detail": detail}


def sanitize_name(name: str) -> str:
    return re.sub(r'[\\/:*?"<>|\s]+', "_", (name or "").strip() or "未命名配方")
