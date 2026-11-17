# -*- coding: utf-8 -*-
"""池内切片 facet 的服务层：建切片、给条目归位、按切片收窄。

数据模型只加表不改表（见 models.PoolFacet 注释），规则在 core/facet_rules.json。
"""
from __future__ import annotations

import hashlib

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from ..core import facets as facet_core
from ..models import Pool, PoolAbsorption, PoolFacet, PoolItem, PoolItemFacet


def _hash(label: str, tags: str) -> str:
    """与 pools.py 的条目指纹同一算法，补进粗池的条目才能和原条目对得上。"""
    return hashlib.sha256(f"{label}\x1f{tags}".encode("utf-8")).hexdigest()[:32]


def _item_rows(db: Session, pool_id: int) -> list[dict]:
    return [{"id": r[0], "label": r[1], "tags": r[2]} for r in db.execute(
        select(PoolItem.id, PoolItem.label, PoolItem.tags)
        .where(PoolItem.pool_id == pool_id).order_by(PoolItem.id)).all()]


def _inherited(db: Session, rule: dict) -> dict[str, set[str]]:
    """把规则里 `from_pool` 指的池的 tags 读出来，作为该档的直接成员集合。"""
    want: dict[str, str] = {}
    for g in rule.get("groups") or []:
        for o in g.get("options") or []:
            fp = str(o.get("from_pool") or "").strip()
            slug = str(o.get("slug") or "").strip()
            if fp and slug:
                want[slug] = fp
    if not want:
        return {}
    slugs = set(want.values())
    pools = db.scalars(select(Pool).where(Pool.slug.in_(slugs))).all()
    by_slug = {p.slug: p.id for p in pools}
    out: dict[str, set[str]] = {}
    for facet_slug, pool_slug in want.items():
        pid = by_slug.get(pool_slug)
        if not pid:
            continue
        out[facet_slug] = {
            str(t or "").strip().lower()
            for t in db.scalars(select(PoolItem.tags).where(PoolItem.pool_id == pid)).all()
            if str(t or "").strip()
        }
    return out


def sync_pool(db: Session, pool: Pool, rule: dict, *, apply: bool = False) -> dict:
    """按规则重建一个池的切片。apply=False 只算不写（dry-run）。

    幂等：每次全量重算该池的归属，重复跑不会叠加。
    """
    meta = facet_core.option_meta(rule)
    items = _item_rows(db, pool.id)
    assigned = facet_core.assign_items(items, rule, _inherited(db, rule))

    if apply:
        existing = {f.slug: f for f in db.scalars(
            select(PoolFacet).where(PoolFacet.pool_id == pool.id)).all()}
        for m in meta:
            row = existing.get(m["slug"])
            if row is None:
                row = PoolFacet(pool_id=pool.id, slug=m["slug"],
                                group_name=m["group_name"], name=m["name"],
                                sort=m["sort"], origin=m["origin"])
                db.add(row)
                db.flush()
                existing[m["slug"]] = row
            row.group_name = m["group_name"]
            row.name = m["name"]
            row.sort = m["sort"]
            row.origin = m["origin"]
        # 规则里删掉的档：连带条目归属一起走
        stale = [f for s, f in existing.items() if s not in {m["slug"] for m in meta}]
        for f in stale:
            db.execute(delete(PoolItemFacet).where(PoolItemFacet.facet_id == f.id))
            db.delete(f)
        db.flush()
        ids = {s: f.id for s, f in existing.items() if s in {m["slug"] for m in meta}}
        if ids:
            db.execute(delete(PoolItemFacet).where(
                PoolItemFacet.facet_id.in_(list(ids.values()))))
            rows = []
            for slug, item_ids in assigned.items():
                fid = ids.get(slug)
                if not fid:
                    continue
                rows.extend({"item_id": i, "facet_id": fid} for i in item_ids)
            if rows:
                db.bulk_insert_mappings(PoolItemFacet, rows)
        db.flush()

    covered = {i for v in assigned.values() for i in v}
    groups: dict[str, list[dict]] = {}
    for m in meta:
        groups.setdefault(m["group_name"], []).append(
            {"slug": m["slug"], "name": m["name"], "count": len(assigned.get(m["slug"], []))})
    return {
        "pool": pool.name, "pool_id": pool.id, "slug": pool.slug,
        "items": len(items), "assigned": len(covered),
        "unassigned": len(items) - len(covered),
        "groups": [{"name": k, "options": v} for k, v in groups.items()],
    }


def sync_all(db: Session, *, apply: bool = False, only: list[str] | None = None) -> list[dict]:
    rules = facet_core.load_rules()
    out = []
    for rule in rules.get("pools") or []:
        slug = str(rule.get("pool") or "")
        if only and slug not in only:
            continue
        pool = db.scalar(select(Pool).where(Pool.slug == slug))
        if not pool:
            continue
        out.append(sync_pool(db, pool, rule, apply=apply))
    if apply:
        db.commit()
    return out


# ---------------- 查询 ----------------

def facets_for_pool(db: Session, pool_id: int) -> dict:
    """给前端的切片行：按组返回，只留「能真正切掉一部分」的组。

    判据是这一组的档合计小于池总量，不是档数。单档组（「只要异形瞳」「只要束发」）
    恰恰是最有用的一类，按档数砍掉会把它误杀；反过来一档吃掉全池的组（比如
    「常规」占 89%）摆出来才真的没用。
    """
    rows = db.execute(
        select(PoolFacet.group_name, PoolFacet.slug, PoolFacet.name, PoolFacet.sort,
               func.count(PoolItemFacet.item_id))
        .outerjoin(PoolItemFacet, PoolItemFacet.facet_id == PoolFacet.id)
        .where(PoolFacet.pool_id == pool_id)
        .group_by(PoolFacet.id)
        .order_by(PoolFacet.sort)).all()
    groups: dict[str, list[dict]] = {}
    order: list[str] = []
    for gname, slug, name, _s, cnt in rows:
        if not cnt:
            continue
        if gname not in groups:
            groups[gname] = []
            order.append(gname)
        groups[gname].append({"slug": slug, "name": name, "count": int(cnt)})
    total = int(db.scalar(select(func.count()).select_from(PoolItem)
                          .where(PoolItem.pool_id == pool_id)) or 0)
    live = [{"name": g, "options": groups[g]} for g in order
            if groups[g] and sum(o["count"] for o in groups[g]) < total]
    return {"pool_id": pool_id, "total": total,
            "groups": live, "has_facets": bool(live)}


def item_ids_for(db: Session, pool_id: int, slugs: list[str]) -> set[int] | None:
    """选中的切片 → 条目 id 集合。

    跨组是 AND、组内是 OR：只选「长发」+「常规」= 长发里排除异常向的那些。
    None 表示「没有可用条件」（池没有这些切片），调用方应按不过滤处理。
    """
    clean = [str(s).strip() for s in (slugs or []) if str(s).strip()]
    if not clean:
        return None
    facets = db.scalars(select(PoolFacet).where(
        PoolFacet.pool_id == pool_id, PoolFacet.slug.in_(clean))).all()
    if not facets:
        return None
    # 同一个 slug 只会在一个组里，所以「每组的命中集合」直接按 group_name 收拢
    per_group: dict[str, set[int]] = {}
    id_to_group = {f.id: f.group_name for f in facets}
    facet_ids = {f.id for f in facets}
    for fid, item_id in db.execute(
            select(PoolItemFacet.facet_id, PoolItemFacet.item_id)
            .where(PoolItemFacet.facet_id.in_(list(facet_ids)))).all():
        per_group.setdefault(id_to_group[fid], set()).add(int(item_id))
    if not per_group:
        return set()
    result: set[int] = set()
    for s in per_group.values():
        result = s if not result else (result & s)
    return result


def facets_for_pools(db: Session, pairs: dict[str, list[str]]) -> dict[str, list[str]]:
    """`{池名或 slug: [切片 slug]}` → 只保留该池真实存在的切片。"""
    if not pairs:
        return {}
    pools = db.scalars(select(Pool)).all()
    by_key = {}
    for p in pools:
        by_key[p.slug] = p
        by_key.setdefault(p.name, p)
    out: dict[str, list[str]] = {}
    for key, slugs in pairs.items():
        p = by_key.get(key)
        if not p or not slugs:
            continue
        have = {s for s in db.scalars(select(PoolFacet.slug)
                                      .where(PoolFacet.pool_id == p.id)).all()}
        keep = [s for s in slugs if s in have]
        if keep:
            out[p.slug] = keep
    return out


# ---------------- 细池收编 ----------------

def absorb_fine_pools(db: Session, *, apply: bool = False) -> list[dict]:
    """把与粗池重叠的 danbooru 细分池标记为「已收编」，并补齐粗池缺的那几条。

    实测重叠不是「差不多」而是「完全包含」：hair_styles_tied 45/45、front 12/12、
    length 9/9、texture 9/9 全在「人物-头发」里。界面再单列一遍只是把同一批货
    摆两个入口，推荐排序还会被 30 个碎片池淹掉。

    只隐藏不补会丢货：细池里 2 条（hair up / hair down）粗池没有。所以收编时把
    独有条目插进粗池，再写 pool_absorption 一行；删掉那张表的行即可回滚。
    """
    rules = facet_core.load_rules()
    spec = rules.get("absorb") or []
    if not spec:
        return []
    slugs = {str(s.get("pool") or "") for s in spec} | {str(s.get("into") or "") for s in spec}
    by_slug = {p.slug: p for p in db.scalars(select(Pool).where(Pool.slug.in_(list(slugs)))).all()}
    out = []
    for s in spec:
        fine = by_slug.get(str(s.get("pool") or ""))
        master = by_slug.get(str(s.get("into") or ""))
        if not fine or not master:
            continue
        fine_items = db.execute(select(PoolItem.label, PoolItem.tags)
                                .where(PoolItem.pool_id == fine.id)).all()
        master_tags = {str(t or "").strip().lower()
                       for t in db.scalars(select(PoolItem.tags)
                                           .where(PoolItem.pool_id == master.id)).all()}
        missing = [(lb, tg or "") for lb, tg in fine_items
                   if str(tg or "").strip().lower() not in master_tags]
        if apply:
            for label, tags in missing:
                db.add(PoolItem(pool_id=master.id, label=label, tags=tags, weight=1.0,
                                enabled=True, content_hash=_hash(label, tags)))
            row = db.scalar(select(PoolAbsorption).where(PoolAbsorption.pool_id == fine.id))
            if row is None:
                row = PoolAbsorption(pool_id=fine.id)
                db.add(row)
            row.into_pool_id = master.id
            row.facet_slug = str(s.get("facet") or "")
            row.reason = (f"与「{master.name}」重叠 "
                          f"{len(fine_items) - len(missing)}/{len(fine_items)}，改由切片承载")[:200]
        out.append({"pool": fine.name, "into": master.name,
                    "items": len(fine_items), "moved": len(missing),
                    "dupe": len(fine_items) - len(missing)})
    if apply:
        db.commit()
    return out


def absorbed_ids(db: Session) -> set[int]:
    return {int(x) for x in db.scalars(select(PoolAbsorption.pool_id)).all()}


def absorbed_map(db: Session) -> dict[int, dict]:
    rows = db.scalars(select(PoolAbsorption)).all()
    if not rows:
        return {}
    masters = {p.id: p.name for p in db.scalars(select(Pool)).all()}
    return {r.pool_id: {"into": masters.get(r.into_pool_id, ""),
                        "facet": r.facet_slug, "reason": r.reason} for r in rows}
