# -*- coding: utf-8 -*-
"""卡池结构与抽取算法（迁移自 gacha.py，保持同 seed 行为一致）。

服务层负责把数据库里的 Pool/PoolItem 组装成 PoolData；这里只做纯计算。
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

NAME_KEYS = ("name", "名称", "label", "title", "character", "角色", "cn", "en", "tag")
TAGS_KEYS = ("tags", "tag", "styleColumns", "标签", "风格")
ARTIST_HINT = ("artist", "画师")
STYLE_HINT = ("style", "column", "风格")
CHAR_HINT = ("char", "角色")
ACTION_HINT = ("action", "动作")


@dataclass
class Item:
    label: str
    tags: str
    payload: Any = None


@dataclass
class PoolData:
    name: str
    friendly: str
    source: str
    items: list[Item] = field(default_factory=list)

    def __len__(self) -> int:
        return len(self.items)


def looks_like_token_list(s: str) -> bool:
    s = s.strip()
    if not s or any(c in s for c in (",", "，", "、", "：")):
        return False
    tokens = s.split()
    if len(tokens) < 3:
        return False
    return all(re.fullmatch(r"[A-Za-z0-9_\-/()\.']+", t) for t in tokens)


def friendly_for(key: str, name: str) -> str:
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


def pool_from_list(key: str, source: str, data: list, name: str) -> PoolData:
    items: list[Item] = []
    for el in data:
        if isinstance(el, dict):
            label = None
            for k in NAME_KEYS:
                v = el.get(k)
                if v not in (None, ""):
                    label = str(v)
                    break
            if label is None:
                for v in el.values():
                    if isinstance(v, (str, int, float)) and not isinstance(v, bool):
                        label = str(v)
                        break
            if label is None:
                label = f"<对象{len(items) + 1}>"
            tags = None
            for tk in TAGS_KEYS:
                if tk in el:
                    tv = el[tk]
                    tags = ", ".join(str(x) for x in tv) if isinstance(tv, list) else str(tv)
                    break
            items.append(Item(label, (tags or label).strip(), el))
        elif isinstance(el, list):
            joined = ", ".join(str(x) for x in el)
            items.append(Item(joined[:80] or "<空列表>", joined, el))
        else:
            s = str(el)
            items.append(Item(s, s, el))
    return PoolData(name, friendly_for(key, name), source, items)


def discover_pools(data: Any, source: str, prefix: str = "") -> list[PoolData]:
    """递归识别任意结构 JSON 里的数据池（迁移脚本用）。"""
    pools: list[PoolData] = []
    if isinstance(data, dict):
        if not data:
            return pools
        if all(isinstance(v, (str, int, float)) for v in data.values()):
            base = prefix or source
            items = [Item(str(k), str(v), v) for k, v in data.items()]
            has_cjk = any("\u4e00" <= ch <= "\u9fff" for ch in "".join(data.keys()))
            friendly = "角色" if has_cjk else friendly_for(base, prefix)
            pools.append(PoolData(base, friendly, source, items))
            return pools
        for k, v in data.items():
            base = f"{prefix}.{k}" if prefix else str(k)
            if isinstance(v, list):
                pools.append(pool_from_list(str(k), source, v, base))
            elif isinstance(v, dict):
                pools.extend(discover_pools(v, source, base))
            elif isinstance(v, str) and looks_like_token_list(v):
                items = [Item(t, t, t) for t in v.split()]
                pools.append(PoolData(base, friendly_for(str(k), base), source, items))
    elif isinstance(data, list):
        pools.append(pool_from_list(source, source, data, prefix or source))
    return pools


def pick_pools(all_pools: list[PoolData], spec: str | list[str]) -> list[PoolData]:
    """按名称/友好名筛选池；空规格 = 全部。"""
    wanted = [s.strip() for s in (spec if isinstance(spec, list) else spec.split(",")) if s.strip()]
    if not wanted:
        return list(all_pools)
    result, seen = [], set()
    for w in wanted:
        for p in all_pools:
            if (w == p.name or w == p.friendly or w in p.name) and id(p) not in seen:
                seen.add(id(p))
                result.append(p)
    return result or list(all_pools)


def filter_pool(pool: PoolData, keywords: list[str]) -> PoolData:
    if not keywords:
        return pool
    kept = [it for it in pool.items
            if any(kw in it.label or kw in it.tags for kw in keywords)]
    return PoolData(pool.name, pool.friendly, pool.source, kept)


def apply_filter_spec(pools: list[PoolData], spec: str) -> list[PoolData]:
    """全局关键字 / 按池关键字（'角色:Fate,动作:xxx'）。"""
    if not spec:
        return [p for p in pools if len(p) > 0]
    global_kws: list[str] = []
    per_pool: dict[str, list[str]] = {}
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


def expand_nested_card(card: list[dict], all_pools: list[PoolData], rng,
                       max_depth: int = 3) -> list[dict]:
    """支持条目里 @池名 / [池名] 引用，自动展开成子抽卡。"""
    if max_depth <= 0 or not all_pools:
        return card
    mapping: dict[str, PoolData] = {}
    for p in all_pools:
        for key in (p.name, p.friendly, p.source, p.source.rsplit("/", 1)[-1]):
            mapping[key] = p
    new_card: list[dict] = []
    for item in card:
        text = f"{item.get('label') or ''} {item.get('tags') or ''}"
        refs = [a or b for a, b in re.findall(r"@([\w\.\-]+)|\[([\w\.\-]+)\]", text)]
        subs = []
        for ref in refs:
            target = mapping.get(ref) or mapping.get(ref + ".json")
            if target and target.items:
                sub = rng.choice(target.items)
                subs.append({"pool": target.name, "friendly": target.friendly,
                             "label": f"{item['label']} > {sub.label}",
                             "tags": f"{item['tags']}, {sub.tags}"})
        if subs:
            new_card.extend(expand_nested_card(subs, all_pools, rng, max_depth - 1))
        else:
            new_card.append(item)
    return new_card


def draw_pull(rng, pools: list[PoolData], count: int, no_repeat: bool,
             used_hist: dict, *, all_pools: list[PoolData] | None = None,
             fixed: str = "") -> list[dict]:
    """一次连抽：每个池各抽 count 条，返回卡片明细。"""
    card: list[dict] = []
    if fixed.strip():
        card.append({"pool": "custom", "friendly": "附加 Prompt",
                     "label": fixed.strip(), "tags": fixed.strip()})
    for pool in pools:
        if not pool.items:
            continue
        if no_repeat:
            hist = used_hist.setdefault(pool.name, set())
            remaining = [i for i in range(len(pool.items)) if i not in hist]
            if not remaining:
                hist.clear()
                remaining = list(range(len(pool.items)))
            k = min(count, len(remaining))
            idxs = rng.sample(remaining, k)
            hist.update(idxs)
        else:
            idxs = rng.sample(range(len(pool.items)), min(count, len(pool.items)))
        for i in idxs:
            it = pool.items[i]
            card.append({"pool": pool.name, "friendly": pool.friendly,
                         "label": it.label, "tags": it.tags})
    if all_pools:
        card = expand_nested_card(card, all_pools, rng)
    return card


def prompt_tag(it: dict) -> str:
    """中文说明类条目退化成 ASCII 短名，避免把中文说明拼进 SD prompt。"""
    tags = (it.get("tags") or "").strip()
    label = (it.get("label") or "").strip()
    if any("\u4e00" <= ch <= "\u9fff" for ch in tags):
        if label and label != tags and all(ord(ch) < 128 for ch in label):
            return label
        return ""
    return tags


def build_prompt(card: list[dict], sep: str = ", ", prepend: str = "") -> str:
    parts = [p for p in (prompt_tag(it) for it in card) if p]
    body = sep.join(parts)
    return (prepend + body).strip() if prepend else body
