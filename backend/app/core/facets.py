# -*- coding: utf-8 -*-
"""池内切片（facet）的纯计算层：规则 → 条目归属，不碰数据库。

为什么要有这一层：`人物-头发` 212 条同时混着长度 / 束法 / 质地 / 刘海 / 性别向 /
适格五个维度，想「只要长发」「不要光秃」只能整池换掉。拆池会爆池数且不可逆，
所以池和条目一个字不改，只在上面挂一组正交切片，抽卡时按选中的档收窄。

本模块只做「哪些条目属于哪一档」，落库与查询在 services/facets.py。
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Iterable

RULES_PATH = Path(__file__).with_name("facet_rules.json")

# 组内 first-match：一条条目在每个维度里最多落一档；不同维度之间互不影响，
# 所以 `bald girl` 可以同时是「无发」和「异常向」——这正是拆池做不到的。
_RULE_CACHE: dict[str, Any] = {"mtime": None, "data": None}


def load_rules(path: Path | str | None = None) -> dict:
    p = Path(path) if path else RULES_PATH
    try:
        mtime = p.stat().st_mtime
    except OSError:
        return {"version": 0, "pools": []}
    if path is None and _RULE_CACHE["mtime"] == mtime and _RULE_CACHE["data"]:
        return _RULE_CACHE["data"]
    data = json.loads(p.read_text(encoding="utf-8"))
    if path is None:
        _RULE_CACHE.update(mtime=mtime, data=data)
    return data


def rule_for_pool(rules: dict, slug: str) -> dict | None:
    for rule in rules.get("pools") or []:
        if str(rule.get("pool") or "") == str(slug):
            return rule
    return None


def _compile(pattern: str):
    try:
        return re.compile(pattern, re.I)
    except re.error:
        return None


def assign_items(items: Iterable[dict], rule: dict,
                 inherited: dict[str, set[str]] | None = None) -> dict[str, list[int]]:
    """按规则把条目分到各切片。

    items: `[{id, label, tags}]`；返回 `{facet_slug: [item_id, ...]}`。
    `inherited`：`{facet_slug: set(去重后的小写 tags)}`，用于吸收其它池的条目
    （danbooru 官方细分池与粗池 100% 重叠，直接继承比猜正则准）。
    """
    fields = [str(f) for f in (rule.get("fields") or ["tags", "label"])]
    groups = []
    for g in rule.get("groups") or []:
        opts = []
        for o in g.get("options") or []:
            slug = str(o.get("slug") or "").strip()
            if not slug:
                continue
            opts.append({
                "slug": slug,
                "name": str(o.get("name") or slug),
                "sort": int(o.get("sort") or 0),
                "re": _compile(o["match"]) if o.get("match") else None,
                "from_pool": str(o.get("from_pool") or ""),
                "catch_rest": bool(o.get("catch_rest")),
            })
        if opts:
            groups.append({"name": str(g.get("name") or ""),
                           "sort": int(g.get("sort") or 0), "options": opts})

    inh = inherited or {}
    out: dict[str, list[int]] = {o["slug"]: [] for g in groups for o in g["options"]}

    for it in items:
        iid = int(it["id"])
        tags_raw = str(it.get("tags") or "").strip().lower()
        text = " ".join(str(it.get(f) or "") for f in fields).strip().lower()
        if not text:
            continue
        for g in groups:
            rest = None
            hit = None
            for o in g["options"]:
                if o["catch_rest"]:
                    rest = o
                    continue
                matched = False
                if o["from_pool"] and tags_raw and tags_raw in inh.get(o["slug"], ()):
                    matched = True
                elif o["re"] is not None and o["re"].search(text):
                    matched = True
                if matched:
                    hit = o
                    break
            if hit is None:
                hit = rest
            if hit is not None:
                out[hit["slug"]].append(iid)
    return out


def option_meta(rule: dict) -> list[dict]:
    """规则的「组 → 档」结构（不含条目），给建表与前端分组用。

    `catch_rest` 档（「散发」「无刘海」「常规」这类兜底）**不落库**：
    它的语义就是「不选」，摆成 chip 只是占一行位置——用户点「无刘海」197 条
    和不点没区别。落库的只有能被主动选中的档。
    """
    rows = []
    for g in rule.get("groups") or []:
        gname = str(g.get("name") or "")
        gsort = int(g.get("sort") or 0)
        for i, o in enumerate(g.get("options") or []):
            slug = str(o.get("slug") or "").strip()
            if not slug or o.get("catch_rest"):
                continue
            rows.append({"group_name": gname, "group_sort": gsort,
                         "slug": slug, "name": str(o.get("name") or slug),
                         "sort": gsort * 100 + i,
                         "origin": "inherit" if o.get("from_pool") else "auto"})
    return rows
