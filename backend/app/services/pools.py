# -*- coding: utf-8 -*-
"""卡池仓储与服务：SQLite 单一事实源 + 旧数据导入。"""
from __future__ import annotations

import csv
import hashlib
import json
import re
from collections import Counter
from types import SimpleNamespace
from pathlib import Path
from typing import Any
from urllib.parse import quote

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..core import semantics as sem_core
from ..core import wildcards as wc_core
from ..core.pools import Item, PoolData, discover_pools
from ..errors import ConflictError, NotFoundError
from ..models import ImportBatch, Pool, PoolItem


def _hash(label: str, tags: str) -> str:
    return hashlib.sha256(f"{label}\x1f{tags}".encode("utf-8")).hexdigest()[:32]


def _count(db: Session, pool_id: int) -> int:
    return int(db.scalar(select(func.count()).select_from(PoolItem)
                         .where(PoolItem.pool_id == pool_id)) or 0)


# ---------------- 条目搜索：前端「快速筛选」的后端一半 ----------------
# 用户口径：输入片段就能筛（`black h` → `black hair`）。所以：
#   · 空格分词后 AND，顺序不限（`hair black` 同样命中）
#   · `_` 与空格等价：库里两种写法都有（`black_hair` / `black hair`），搜索时两边都归一
#   · 半截词照样命中（子串），不要求用户打完整词
def _q_words(q: str) -> list[str]:
    return [w for w in re.sub(r"[_\\]", " ", (q or "").lower()).split() if w]


def _q_clauses(q: str) -> list:
    out = []
    for w in _q_words(q):
        like = f"%{w}%"
        out.append(func.replace(func.lower(PoolItem.label), "_", " ").like(like)
                   | func.replace(func.lower(PoolItem.tags), "_", " ").like(like))
    return out


def list_pools(db: Session, *, enabled_only: bool = False,
               include_absorbed: bool = False) -> list[dict]:
    """池列表。默认不列「已收编」的细分池。

    danbooru 的 hair_styles_tied 这类池与粗池 100% 重叠（见 facet_rules.json 的
    absorb 段），界面上再单列一遍只是把同一批货摆两个入口，推荐排序还会被 30 个
    碎片池淹掉。条目一条没删，`include_absorbed=True` 就能看回来。
    """
    from . import facets as facet_svc
    absorbed = facet_svc.absorbed_map(db)
    stmt = select(Pool).order_by(Pool.kind, Pool.slug)
    if enabled_only:
        stmt = stmt.where(Pool.enabled.is_(True))
    rows = db.scalars(stmt).all()
    counts = dict(db.execute(
        select(PoolItem.pool_id, func.count()).group_by(PoolItem.pool_id)).all())
    # 这个池能被切几刀。前端用它决定「打开选择器时先落在哪个池」——
    # 点「衣着」先看到能按类型细化的 190 条，而不是 740 条一整套的盲盒预设。
    from ..models import PoolFacet
    facet_counts = dict(db.execute(
        select(PoolFacet.pool_id, func.count(func.distinct(PoolFacet.group_name)))
        .group_by(PoolFacet.pool_id)).all())
    out = []
    for p in rows:
        ab = absorbed.get(p.id) if p.id in absorbed else None
        if ab and not include_absorbed:
            continue
        row = {"id": p.id, "slug": p.slug, "name": p.name, "kind": p.kind,
               "source": p.source, "source_ref": p.source_ref,
               "enabled": p.enabled, "weight": p.weight,
               "item_count": int(counts.get(p.id, 0)),
               "facet_groups": int(facet_counts.get(p.id, 0))}
        if ab:
            row["absorbed_into"] = ab["into"]
            row["absorbed_reason"] = ab["reason"]
        out.append(row)
    return out


def get_pool(db: Session, pool_id: int) -> Pool:
    p = db.get(Pool, pool_id)
    if not p:
        raise NotFoundError(f"卡池不存在: id={pool_id}")
    return p


def create_pool(db: Session, data: dict) -> Pool:
    if db.scalar(select(Pool).where(Pool.slug == data["slug"])):
        raise ConflictError(f"卡池 slug 已存在: {data['slug']}")
    p = Pool(**data)
    db.add(p)
    db.commit()
    db.refresh(p)
    return p


def update_pool(db: Session, pool_id: int, data: dict) -> Pool:
    p = get_pool(db, pool_id)
    for k, v in data.items():
        if v is not None and hasattr(p, k):
            setattr(p, k, v)
    db.commit()
    db.refresh(p)
    return p


def delete_pool(db: Session, pool_id: int) -> None:
    p = get_pool(db, pool_id)
    db.delete(p)
    db.commit()


def list_pool_items(db: Session, pool_id: int, *, q: str = "",
                    limit: int = 100, offset: int = 0) -> dict:
    stmt = select(PoolItem).where(PoolItem.pool_id == pool_id)
    count_stmt = select(func.count()).select_from(PoolItem).where(PoolItem.pool_id == pool_id)
    if q:
        for clause in _q_clauses(q):
            stmt = stmt.where(clause)
            count_stmt = count_stmt.where(clause)
    total = int(db.scalar(count_stmt) or 0)
    rows = db.scalars(stmt.order_by(PoolItem.id).limit(min(500, limit)).offset(offset)).all()
    return {"total": total, "items": [
        {"id": it.id, "pool_id": it.pool_id, "label": it.label, "tags": it.tags,
         "weight": it.weight, "enabled": it.enabled} for it in rows]}


# ---------------- tag 候选：让过滤关键字可以点选，而不是靠用户手打 ----------------
# 索引按 (行数, max_id) 做签名缓存；导入、增删条目后签名变化会自动重建。
_TAG_INDEX: dict[str, Any] = {"sig": None, "data": None}


def _tag_words(text: str) -> list[str]:
    """一条 tags 字段 → 可作为过滤关键字的词。

    `asuna (sao), sword art online` → `['asuna', 'sword art online']`：
    括号后缀去掉只留基础词（过滤是子串包含，`asuna` 能命中全部亚丝娜条目）；
    下划线保持原样，`blue_archive` 转成空格反而匹配不到。
    """
    out: list[str] = []
    for part in re.split(r"[,，;；|\n]+", text or ""):
        word = part.strip().strip("()[]{}\"'").strip()
        if not word or len(word) > 80:
            continue
        # 去掉括号后缀与尾部转义反斜杠：'asuna \(sao\)' → 'asuna'
        base = re.split(r"[（(]", word, 1)[0].strip().rstrip("\\").strip()
        if 1 < len(base) <= 60:
            out.append(base.lower())
    return out


def _tag_index(db: Session) -> dict[str, Any]:
    sig = (int(db.scalar(select(func.count()).select_from(PoolItem)) or 0),
           int(db.scalar(select(func.max(PoolItem.id))) or 0))
    if _TAG_INDEX["sig"] == sig and _TAG_INDEX["data"] is not None:
        return _TAG_INDEX["data"]
    meta = {p.id: (p.name, p.kind, p.slug) for p in db.scalars(select(Pool)).all()}
    freq: Counter[str] = Counter()
    by_pool: dict[int, Counter[str]] = {}
    labels: dict[int, list[str]] = {}
    for pool_id, label, tags in db.execute(
            select(PoolItem.pool_id, PoolItem.label, PoolItem.tags)).all():
        counter = by_pool.setdefault(pool_id, Counter())
        for word in _tag_words(tags or ""):
            freq[word] += 1
            counter[word] += 1
        if label and len(label) <= 60:
            labels.setdefault(pool_id, []).append(label)
    data = {"freq": freq, "by_pool": by_pool, "meta": meta, "labels": labels}
    _TAG_INDEX.update(sig=sig, data=data)
    return data


def _label_matches(idx: dict, pool_ids: list[int], qlow: str, limit: int) -> list[tuple]:
    if limit <= 0:
        return []
    seen: set[str] = set()
    out: list[tuple] = []
    for pid in pool_ids:
        for label in idx["labels"].get(pid, []):
            key = label.lower()
            # 词卡池的 label 可能是一整行 prompt（含逗号 / 转义符），点选后会被
            # 过滤表达式的逗号切开而永远匹配不到，不作为候选展示。
            if any(ch in label for ch in (",", "，", "\\", "\n")) or len(label) > 40:
                continue
            if qlow in key and key not in seen:
                seen.add(key)
                out.append((label, 1))
                if len(out) >= limit:
                    return out
    return out


def suggest_tags(db: Session, *, q: str = "", pool: str = "", limit: int = 30) -> dict:
    """点选用的过滤关键字：空 q 给高频词，非空做子串联想。

    `pool` 与 `core.apply_filter_spec` 同语义：kind 精确命中或 name/slug 子串命中。
    """
    idx = _tag_index(db)
    key = (pool or "").strip().lower()
    if key:
        ids = [pid for pid, (name, kind, slug) in idx["meta"].items()
               if key == kind.lower() or key in name.lower() or key in slug.lower()]
        merged: Counter[str] = Counter()
        for pid in ids:
            merged.update(idx["by_pool"].get(pid, {}))
    else:
        ids = list(idx["meta"].keys())
        merged = idx["freq"]

    qlow = (q or "").strip().lower()
    if not qlow:
        items = [{"value": w, "count": int(n), "source": "tag"}
                 for w, n in merged.most_common(limit)]
    else:
        hits = [(w, n) for w, n in merged.items() if qlow in w]
        hits.sort(key=lambda x: (-x[1], x[0]))
        items = [{"value": w, "count": int(n), "source": "tag"}
                 for w, n in hits[:limit]]
        for label, count in _label_matches(idx, ids, qlow, limit - len(items)):
            items.append({"value": label, "count": count, "source": "label"})
    return {"items": items, "total": len(merged), "pool": pool or "全部",
            "query": q or ""}


def list_items(db: Session, *, kind: str = "", q: str = "", pool: str = "",
               limit: int = 60, offset: int = 0, facets: str = "") -> dict:
    """装配面板的选择器：按类别 / 池名列出条目本身（不是 tag）。

    和 suggest_tags 的区别：那个给的是「过滤表达式的关键字」，会刻意跳过带逗号的
    长 label（塞进 `池:tag` 表达式会被逗号切碎）；装配面板的 pick 直接按 label
    锁定整条，所以这里要原样返回 label + tags，长的也要。

    `facets`（逗号分隔的切片 slug）只在**指定了唯一池**时生效：跨池浏览时切片
    各池不一样，硬套一个池的切片会把别的池筛空。
    """
    base = select(PoolItem, Pool).join(Pool, Pool.id == PoolItem.pool_id)
    kk = (kind or "").strip()
    if kk:
        base = base.where(Pool.kind == kk)
    pk = (pool or "").strip().lower()
    if pk:
        base = base.where(func.lower(Pool.name).contains(pk)
                          | func.lower(Pool.slug).contains(pk))
    picked = [s.strip() for s in str(facets or "").split(",") if s.strip()]
    facet_hit = None
    if pk and picked:
        from . import facets as facet_svc
        target = db.scalar(select(Pool).where(
            (func.lower(Pool.name) == pk) | (func.lower(Pool.slug) == pk)))
        if target:
            facet_hit = facet_svc.item_ids_for(db, target.id, picked)
    if facet_hit is not None:
        base = base.where(PoolItem.id.in_(list(facet_hit)))
    clauses = _q_clauses(q)
    if clauses:
        base = base.where(*clauses)
    total = db.scalar(select(func.count()).select_from(base.subquery())) or 0
    cap = min(200, max(1, limit))
    if pk:
        rows = db.execute(base.order_by(PoolItem.id).limit(cap)
                          .offset(max(0, offset))).all()
    else:
        # 「全部」不等于「按 id 前 N 条」：条目是按池导入的，前 60 条会全来自同一个池
        # （实测点衣着看到 7 条全是「人物-女性时尚穿搭」）。改成每池轮转取样，
        # 一次就能看见十来个池的货色；per 由 limit 推，至少 2 条，避免一池霸屏。
        # 每池 3 条：60 条能盖住 20 个池，一屏就能看出「池与池之间的差别」。
        # 想深挖某池，点组头（或 chip / 下拉）切过去看全量。
        per = max(2, min(5, cap // 20))
        rn = func.row_number().over(partition_by=PoolItem.pool_id,
                                    order_by=PoolItem.id).label("rn")
        sz = func.count().over(partition_by=PoolItem.pool_id).label("sz")
        sub = select(PoolItem.label.label("label"), PoolItem.tags.label("tags"),
                     Pool.name.label("pname"), Pool.kind.label("pkind"), rn, sz) \
            .join(Pool, Pool.id == PoolItem.pool_id)
        if kk:
            sub = sub.where(Pool.kind == kk)
        if clauses:
            sub = sub.where(*clauses)
        ranked = sub.subquery()
        # 大池先上：按字母序取前 10 池的话，看到的全是 DanbooruTAG/attire_*，
        # 用户真正在用的「组合预设/服装-…」「人物-衣服」反而排不进来。
        hits = db.execute(select(ranked).where(ranked.c.rn <= per)
                          .order_by(ranked.c.sz.desc(), ranked.c.pname, ranked.c.rn)
                          .limit(cap).offset(max(0, offset))).all()
        rows = [(SimpleNamespace(label=r.label, tags=r.tags),
                 SimpleNamespace(name=r.pname, kind=r.pkind)) for r in hits]
    items = [{"label": it.label, "tags": it.tags,
              "pool": p.name, "kind": p.kind} for it, p in rows]
    _attach_artist_thumbs(items)
    return {
        "items": items,
        "total": int(total),
        "kind": kk or "全部",
        "query": q or "",
    }


def _attach_artist_thumbs(items: list[dict]) -> None:
    """画师池的条目补上「这位画师的风格样图」地址。

    一千多条画师名里，`dore \\(gilles dore\\)` 这种字面量判断不了画风；
    有样图的条目才带地址（没样图的不给，前端就不会去请求一个必然 404 的图）。
    前端只在悬停 / 聚焦时才加载这张图，列表本身仍然零 <img>。
    """
    for row in items:
        if str(row.get("kind") or "") != "画师":
            continue
        label = str(row.get("label") or "")
        if not label or sem_core.artist_thumb(label) is None:
            continue
        row["thumb_url"] = ("/api/semantics/artist-thumb?name="
                            + quote(label, safe=""))


def add_item(db: Session, pool_id: int, data: dict) -> PoolItem:
    get_pool(db, pool_id)
    it = PoolItem(pool_id=pool_id, label=data["label"], tags=data.get("tags", ""),
                  weight=data.get("weight", 1.0), enabled=data.get("enabled", True),
                  content_hash=_hash(data["label"], data.get("tags", "")))
    db.add(it)
    db.commit()
    db.refresh(it)
    return it


def toggle_item(db: Session, item_id: int, enabled: bool) -> None:
    it = db.get(PoolItem, item_id)
    if not it:
        raise NotFoundError(f"条目不存在: id={item_id}")
    it.enabled = enabled
    db.commit()


def delete_item(db: Session, item_id: int) -> None:
    it = db.get(PoolItem, item_id)
    if not it:
        raise NotFoundError(f"条目不存在: id={item_id}")
    db.delete(it)
    db.commit()


def pools_for_draw(db: Session, slugs: list[str] | None = None,
                   *, include_disabled_pool: bool = False,
                   facets: dict[str, list[str]] | None = None) -> list[PoolData]:
    """把 DB 里的启用的池组装成 core 需要的 PoolData。

    `facets`：`{池 slug: [切片 slug]}`。命中切片时只在该子集里抽，
    不传或该池没有切片 = 原行为（整个池）。跨组 AND、组内 OR。
    """
    from . import facets as facet_svc
    absorbed = facet_svc.absorbed_ids(db)
    stmt = select(Pool)
    if not include_disabled_pool:
        stmt = stmt.where(Pool.enabled.is_(True))
    if slugs:
        stmt = stmt.where(Pool.slug.in_(slugs))
    pools = db.scalars(stmt.order_by(Pool.id)).all()
    result: list[PoolData] = []
    for p in pools:
        # 已收编的细分池不参与抽卡：它们的条目已经在粗池里，再抽一遍等于双倍权重。
        if p.id in absorbed:
            continue
        rows = db.execute(
            select(PoolItem.id, PoolItem.label, PoolItem.tags).where(
                PoolItem.pool_id == p.id, PoolItem.enabled.is_(True))
            .order_by(PoolItem.id)).all()
        keep = facet_svc.item_ids_for(db, p.id, (facets or {}).get(p.slug) or [])
        if keep is not None:
            rows = [r for r in rows if r[0] in keep]
        if rows:
            result.append(PoolData(p.slug, p.kind, p.source_ref,
                                   [Item(r[1], r[2]) for r in rows]))
    return result


# ---------------- 导入 ----------------

def _upsert_pool(db: Session, *, slug: str, name: str, kind: str,
                 source: str, source_ref: str, enabled: bool = True) -> Pool | None:
    if db.scalar(select(Pool).where(Pool.slug == slug)):
        return None
    p = Pool(slug=slug, name=name, kind=kind, source=source,
             source_ref=source_ref, enabled=enabled)
    db.add(p)
    db.flush()
    return p


def _insert_items(db: Session, pool: Pool, items: list[Item]) -> int:
    seen: set[str] = set()
    mappings = []
    for it in items:
        h = _hash(it.label, it.tags)
        if h in seen:
            continue
        seen.add(h)
        mappings.append({"pool_id": pool.id, "label": it.label, "tags": it.tags,
                         "payload_json": "{}", "weight": 1.0, "enabled": True,
                         "content_hash": h})
    if mappings:
        db.bulk_insert_mappings(PoolItem, mappings)
    return len(mappings)


def _batch(db: Session, source: Path, kind: str, slug: str, count: int) -> None:
    checksum = ""
    if source.is_file():
        checksum = hashlib.sha256(source.read_bytes()).hexdigest()[:32]
    db.add(ImportBatch(source_path=str(source), kind=kind, pool_slug=slug,
                       item_count=count, checksum=checksum))


def _slugify(text: str) -> str:
    # 保留冒号作为「来源:池名」的分隔符，便于按前缀回滚导入批次
    return re.sub(r"[^\w\u4e00-\u9fff./: -]+", "_", text).strip("_")[:150]


def import_json_file(db: Session, path: Path, *, enabled: bool = True,
                     prefix: str | None = None) -> dict:
    """任意结构 JSON → 若干个卡池。"""
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    stem = prefix or path.stem
    pools = discover_pools(data, str(path), stem)
    created, total = 0, 0
    for p in pools:
        slug = _slugify(f"{stem}:{p.name}")
        pool = _upsert_pool(db, slug=slug, name=p.name, kind=p.friendly,
                            source="json", source_ref=str(path), enabled=enabled)
        if pool is None:
            continue
        total += _insert_items(db, pool, p.items)
        created += 1
    _batch(db, path, "json", f"{stem}:*", total)
    db.commit()
    return {"file": str(path), "pools": created, "items": total}


def import_csv_file(db: Session, path: Path, *, enabled: bool = True) -> dict:
    """两列 CSV：中文名, 英文 tag。"""
    items: list[Item] = []
    with path.open("r", encoding="utf-8-sig", newline="") as fh:
        for row in csv.reader(fh):
            if len(row) >= 2 and row[0].strip():
                items.append(Item(row[0].strip(), row[1].strip()))
    slug = _slugify(f"csv:{path.stem}")
    pool = _upsert_pool(db, slug=slug, name=path.stem, kind="角色",
                        source="csv", source_ref=str(path), enabled=enabled)
    count = _insert_items(db, pool, items) if pool else 0
    _batch(db, path, "csv", slug, count)
    db.commit()
    return {"file": str(path), "pools": 1 if pool else 0, "items": count}


def import_artists(db: Session, path: Path) -> dict:
    """noobai_data.json 的 artists[] → 画师卡池（图鉴并入）。"""
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    items = [Item(str(a.get("name", "")).strip(), str(a.get("name", "")).strip())
             for a in data.get("artists", []) if isinstance(a, dict) and a.get("name")]
    slug = "gallery:artists"
    pool = _upsert_pool(db, slug=slug, name="画师图鉴", kind="画师",
                        source="gallery", source_ref=str(path))
    count = _insert_items(db, pool, items) if pool else 0
    _batch(db, path, "gallery", slug, count)
    db.commit()
    return {"file": str(path), "pools": 1 if pool else 0, "items": count}


def import_wildcards(db: Session, root: Path) -> dict:
    """词卡库每个 .txt = 一个池。"""
    if not root.is_dir():
        return {"file": str(root), "pools": 0, "items": 0, "skipped": True}
    pools = wc_core.scan(str(root))
    created, total = 0, 0
    for p in pools:
        slug = _slugify(f"wc:{p.name}")
        pool = _upsert_pool(db, slug=slug, name=p.name, kind=p.friendly,
                            source="wildcards", source_ref=p.source)
        if pool is None:
            continue
        total += _insert_items(db, pool, p.items)
        created += 1
    _batch(db, root, "wildcards", "wc:*", total)
    db.commit()
    return {"file": str(root), "pools": created, "items": total}


def import_combos(db: Session, folder: Path) -> dict:
    """旧 combos/*.json 配方迁入 recipes 表（由 draws 服务处理，这里只返回内容）。"""
    out = []
    if not folder.is_dir():
        return {"file": str(folder), "recipes": 0, "skipped": True}
    for fp in sorted(folder.glob("*.json")):
        try:
            out.append(json.loads(fp.read_text(encoding="utf-8-sig")))
        except Exception:
            continue
    return {"file": str(folder), "recipes": len(out), "items": out}


def list_batches(db: Session) -> list[dict]:
    rows = db.scalars(select(ImportBatch).order_by(ImportBatch.id.desc())).all()
    return [{"id": b.id, "source_path": b.source_path, "kind": b.kind,
             "pool_slug": b.pool_slug, "item_count": b.item_count,
             "created_at": b.created_at.isoformat(timespec="seconds")} for b in rows]


def rollback_batch(db: Session, batch_id: int) -> dict:
    b = db.get(ImportBatch, batch_id)
    if not b:
        raise NotFoundError(f"导入批次不存在: {batch_id}")
    stmt = select(Pool)
    if b.pool_slug.endswith("*"):
        stmt = stmt.where(Pool.slug.like(b.pool_slug.replace("*", "%")))
    elif b.pool_slug:
        stmt = stmt.where(Pool.slug == b.pool_slug)
    else:
        stmt = stmt.where(Pool.source_ref == b.source_path)
    pools = db.scalars(stmt).all()
    for p in pools:
        db.delete(p)
    db.delete(b)
    db.commit()
    return {"removed_pools": len(pools), "batch_id": batch_id}


def import_path(db: Session, raw_path: str, *, kind: str = "auto",
                pool_slug: str = "") -> dict:
    """供 /api/pools/import 使用；路径只允许项目根目录内，防越权读取。"""
    from ..config import get_settings
    root = get_settings().root.resolve()
    p = Path(raw_path)
    p = (p if p.is_absolute() else root / p).resolve()
    if root not in p.parents and p != root:
        raise ConflictError("导入路径必须位于项目目录内")
    if not p.exists():
        raise NotFoundError(f"路径不存在: {p}")
    if p.is_dir():
        return import_wildcards(db, p)
    suffix = p.suffix.lower()
    if suffix == ".csv":
        return import_csv_file(db, p)
    if suffix == ".json":
        if kind == "artists" or p.name == "noobai_data.json":
            return import_artists(db, p)
        return import_json_file(db, p)
    raise ConflictError(f"不支持的文件类型: {suffix}")
