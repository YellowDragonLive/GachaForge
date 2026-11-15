# -*- coding: utf-8 -*-
"""概念物化索引（v2）：由关系表增量维护，不再每次扫描全库、不再解析 JSON。

单一事实源：
  draw_slots / draw_slot_tags   抽到的概念（结构化槽位，粒度准确）
  draw_profiles / session_loras / session_recipes   底模 / LoRA / 配方
  image_assets                  图片归属与原始 prompt
  images                        评分 / 收藏 / 归档状态

出图落库时 index_image() 增量写入 concepts + concept_images；评分收藏变化后
refresh_covers() 只重算受影响概念的封面；rebuild() 可随时从关系表全量重建。

对外只给「一张封面」和「详情页按需分页的图」，卡片列表本身不返回任何图片。
"""
from __future__ import annotations

import datetime as dt
import re
from collections import defaultdict

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import (Concept, ConceptImage, DrawSlot, DrawSlotTag, Image as ImageRow,
                      ImageAsset, Pool, SessionLora, SessionProfile, SessionRecipe)

# 通用质量词 / 人数词：出现频率极高，但没有「看一眼就知道是什么」的信息量
STOP = frozenset({
    "masterpiece", "best quality", "high quality", "normal quality",
    "low quality", "worst quality", "best aesthetics", "amazing quality",
    "very aesthetic", "ultra detailed", "highly detailed", "detailed",
    "1girl", "1boy", "2girls", "2boys", "3girls", "1man", "1woman",
    "solo", "multiple girls", "multiple boys", "hetero", "a couple",
    "official art", "offical art style", "absurdres", "highres", "newest",
    "recent", "blurry", "censored", "watermark", "signature", "artist name",
    "english text", "text", "simple background", "white background",
    "masterpiece best quality", "best quality masterpiece",
})
BAD_FRAGMENT = ("masterpiece", "best quality", "worst quality")
ALIAS = {"artist": "画师", "artists": "画师", "gallery:artists": "画师",
         "action": "动作", "character": "角色", "characters": "角色",
         "zh_tw": "角色"}
INFO_KINDS = frozenset({"底模", "LoRA", "配方"})
_HEAD = re.compile(
    r"^(?:(?:1girl|2girls|3girls|1boy|2boys|1man|1woman|solo|a couple"
    r"|multiple girls|multiple boys)\s+)+", re.I)

THUMB_URL = "/api/images/{id}/thumb"
FILE_URL = "/api/images/{id}/file"


def _clean(s) -> str:
    """归一化：去 danbooru 转义反斜杠、压缩空白、小写，用于概念 key 去重。"""
    return re.sub(r"\s+", " ", str(s or "").replace("\\", "").strip().lower())


def _valid(key: str) -> bool:
    if not key or key in STOP or len(key) < 3 or len(key) > 160:
        return False
    if key.isdigit() or len(key.split()) > 8:
        return False
    if any(f in key for f in BAD_FRAGMENT):
        return False
    if re.fullmatch(r"[a-z0-9_\-]{1,2}", key):
        return False
    return True


def _split(raw) -> list[tuple[str, str]]:
    """把一段槽位 tag 切成 (归一化 key, 展示名)，保留原始大小写用于显示。"""
    out = []
    for part in re.split(r"[,，\n]", str(raw or "")):
        disp = re.sub(r"\s+", " ", str(part).replace("\\", "").strip())
        disp = _HEAD.sub("", disp).strip()
        key = _clean(disp)
        if _valid(key):
            out.append((key, disp))
    return out


def _score(row: ImageRow) -> float:
    """封面排序分：人工评分 / 收藏是最终信号，新鲜度只做微弱加成。"""
    created = row.created_at or dt.datetime.now()
    age_days = max(0.0, (dt.datetime.now() - created).total_seconds() / 86400.0)
    fresh = max(0.0, 1.0 - age_days / 30.0) * 0.5
    return float((row.rating or 0) * 2 + (5 if row.favorite else 0) + fresh)


def _upsert(concepts: dict, key: str, disp: str, kind: str, pool: str,
            filterable: bool) -> None:
    cur = concepts.get(key)
    if cur is None:
        concepts[key] = {"key": key, "label": disp, "kind": kind,
                         "pool": pool, "filterable": filterable}
        return
    # 具体类别 > 泛化 tag；可点选 > 仅展示的信息卡片
    if (filterable and not cur["filterable"]) or (
            filterable == cur["filterable"]
            and kind != "tag" and cur["kind"] == "tag"):
        cur.update({"kind": kind, "pool": pool, "filterable": filterable,
                    "label": disp})


def concept_keys_for_image(db: Session, image_id: int) -> list[dict]:
    """从关系表抽出这张图对应的全部概念；不解析任何 JSON、不切整段 prompt。"""
    asset = db.scalar(select(ImageAsset).where(ImageAsset.image_id == image_id))
    kinds = {str(k) for k in db.execute(select(Pool.kind)).scalars() if k}
    found: dict[str, dict] = {}

    if asset and asset.draw_id:
        slots = db.scalars(select(DrawSlot).where(DrawSlot.draw_id == asset.draw_id)
                           .order_by(DrawSlot.idx)).all()
        for slot in slots:
            raw = str(slot.slot or "").strip()
            # 模板固定段不是「抽到的概念」，不能进索引，更不能变成裸关键字过滤
            if raw.lower() in ("fixed_head", "fixed_tail", "template") or slot.empty:
                continue
            kind = ALIAS.get(raw.lower()) or (raw if raw in kinds else "")
            pool = kind if kind in kinds else ""
            tags = db.scalars(select(DrawSlotTag.tag)
                              .where(DrawSlotTag.slot_id == slot.id)
                              .order_by(DrawSlotTag.idx)).all()
            for tag in tags:
                for key, disp in _split(tag):
                    _upsert(found, key, disp, kind or "tag", pool, True)
            label = str(slot.label or "").strip()
            if label and label not in {str(t) for t in tags}:
                for key, disp in _split(label):
                    _upsert(found, key, disp, kind or "tag", pool, True)

    if asset and asset.session_id:
        profile = db.scalar(select(SessionProfile)
                            .where(SessionProfile.session_id == asset.session_id))
        if profile:
            cp = str(profile.checkpoint or "").strip()
            if cp:
                _upsert(found, _clean(cp), cp, "底模", "", False)
            loras = db.scalars(select(SessionLora)
                               .where(SessionLora.profile_id == profile.id)
                               .order_by(SessionLora.idx)).all()
            for lora in loras:
                name = str(lora.name or "").strip()
                if name:
                    _upsert(found, _clean(name), name, "LoRA", "", False)
        recipe = db.scalar(select(SessionRecipe)
                           .where(SessionRecipe.session_id == asset.session_id))
        if recipe and recipe.name:
            _upsert(found, _clean(recipe.name), recipe.name, "配方", "", False)

    return [v for k, v in found.items() if _valid(k)]


def _concept_row(db: Session, key: str) -> Concept | None:
    norm = _clean(key)
    row = db.scalar(select(Concept).where(Concept.key == norm))
    if row:
        return row
    if not norm:
        return None
    cand = db.scalars(select(Concept).where(Concept.key.like(norm + "%"))
                      .order_by(Concept.image_count.desc()).limit(1)).first()
    return cand


def _recount(db: Session, concept: Concept) -> None:
    sub = select(func.count()).select_from(ConceptImage).where(
        ConceptImage.concept_id == concept.id)
    concept.image_count = int(db.scalar(sub) or 0)
    draws = db.scalar(select(func.count(func.distinct(ConceptImage.draw_id)))
                      .where(ConceptImage.concept_id == concept.id)) or 0
    concept.draw_count = int(draws)
    best = db.scalar(select(ConceptImage.image_id)
                     .where(ConceptImage.concept_id == concept.id)
                     .order_by(ConceptImage.score.desc(),
                               ConceptImage.image_id.desc()).limit(1))
    concept.cover_image_id = int(best) if best else None


def index_image(db: Session, image_id: int) -> int:
    """出图落库时增量写入概念索引；失败由调用方决定降级，绝不拖垮出图。"""
    image = db.get(ImageRow, image_id)
    if image is None or image.status != "active":
        return 0
    asset = db.scalar(select(ImageAsset).where(ImageAsset.image_id == image_id))
    keys = concept_keys_for_image(db, image_id)
    stamp = image.created_at or dt.datetime.now()
    for item in keys:
        concept = db.scalar(select(Concept).where(Concept.key == item["key"]))
        if concept is None:
            concept = Concept(key=item["key"], label=item["label"],
                              kind=item["kind"], pool=item["pool"],
                              filterable=item["filterable"],
                              first_seen_at=stamp)
            db.add(concept)
            db.flush()
        link = db.scalar(select(ConceptImage).where(
            ConceptImage.concept_id == concept.id,
            ConceptImage.image_id == image.id))
        if link is None:
            db.add(ConceptImage(concept_id=concept.id, image_id=image.id,
                                draw_id=asset.draw_id if asset else None,
                                score=_score(image), created_at=stamp))
        else:
            link.score = _score(image)
            link.draw_id = asset.draw_id if asset else None
        concept.last_seen_at = stamp
        db.flush()
        _recount(db, concept)
    db.flush()
    return len(keys)


def refresh_covers(db: Session, image_id: int) -> int:
    """评分 / 收藏变化后，只重算这张图涉及的概念封面。"""
    image = db.get(ImageRow, image_id)
    if image is None:
        return 0
    links = db.scalars(select(ConceptImage)
                       .where(ConceptImage.image_id == image_id)).all()
    for link in links:
        link.score = _score(image)
    affected = {link.concept_id for link in links}
    for cid in affected:
        concept = db.get(Concept, cid)
        if concept:
            _recount(db, concept)
    db.flush()
    return len(affected)


def rebuild(db: Session) -> dict:
    """全量重建：清空物化表后按关系表逐图重建（幂等，可随时执行）。"""
    db.query(ConceptImage).delete()
    db.query(Concept).delete()
    db.flush()
    ids = db.scalars(select(ImageRow.id).where(ImageRow.status == "active")
                     .order_by(ImageRow.id)).all()
    linked = 0
    for iid in ids:
        linked += index_image(db, int(iid))
    db.commit()
    return {"images": len(ids), "links": linked,
            "concepts": int(db.scalar(select(func.count()).select_from(Concept)) or 0)}


def _image_brief(db: Session, image_id: int) -> dict | None:
    row = db.get(ImageRow, image_id)
    if row is None:
        return None
    asset = db.scalar(select(ImageAsset).where(ImageAsset.image_id == image_id))
    return {
        "id": row.id,
        "url": THUMB_URL.format(id=row.id),
        "original_url": FILE_URL.format(id=row.id),
        "rating": row.rating or 0, "favorite": bool(row.favorite),
        "prompt": asset.prompt if asset else "",
        "width": row.width, "height": row.height,
        "created_at": row.created_at.isoformat(timespec="seconds")
        if row.created_at else "",
    }


def _kinds(db: Session) -> list[dict]:
    rows = db.execute(select(Concept.kind, func.count())
                      .group_by(Concept.kind)
                      .order_by(func.count().desc())).all()
    return [{"kind": str(k), "count": int(n)} for k, n in rows]


def status(db: Session) -> dict:
    images = int(db.scalar(select(func.count()).select_from(ImageRow)
                           .where(ImageRow.status == "active")) or 0)
    return {"ready": images > 0, "image_count": images,
            "concept_count": int(db.scalar(select(func.count())
                                           .select_from(Concept)) or 0),
            "kinds": _kinds(db),
            "source": "draw_slots + draw_profiles + image_assets (v2 relational)"}


def wall(db: Session, *, limit: int = 12, kind: str = "", q: str = "",
         include_info: bool = False) -> dict:
    """概念墙：只返回文字与计数，按类别轮转；图片由 /cover 按需悬浮加载。"""
    stmt = select(Concept)
    show_info = include_info or kind in INFO_KINDS
    if not show_info:
        stmt = stmt.where(Concept.filterable.is_(True))
    if kind:
        stmt = stmt.where(Concept.kind == kind)
    needle = _clean(q)
    all_rows = db.scalars(stmt).all()
    rows = [r for r in all_rows
            if not needle or needle in r.key or needle in _clean(r.label)]
    rows.sort(key=lambda r: (r.kind != "tag", r.image_count, r.draw_count),
              reverse=True)
    cap = max(1, min(60, limit))
    if kind:
        picked = rows[:cap]
    else:
        groups = defaultdict(list)
        for r in rows:
            groups[r.kind].append(r)
        ordered = sorted(groups, key=lambda k: -groups[k][0].image_count)
        picked = []
        for i in range(max((len(g) for g in groups.values()), default=0)):
            for k in ordered:
                if i < len(groups[k]) and len(picked) < cap:
                    picked.append(groups[k][i])
            if len(picked) >= cap:
                break
    items = [{"key": r.key, "label": r.label, "kind": r.kind, "pool": r.pool,
              "filterable": bool(r.filterable), "image_count": r.image_count,
              "draw_count": r.draw_count, "cover_image_id": r.cover_image_id,
              "has_cover": bool(r.cover_image_id)} for r in picked]
    return {"total": len(rows),
            "image_count": int(db.scalar(select(func.count()).select_from(ImageRow)
                                         .where(ImageRow.status == "active")) or 0),
            "kinds": _kinds(db), "items": items}


def cover(db: Session, key: str) -> dict:
    """单张代表图：卡片 hover / focus 时才调用，结果由前端按 key 缓存。"""
    concept = _concept_row(db, key)
    if concept is None:
        return {"key": key, "found": False, "image_count": 0, "draw_count": 0,
                "image": None}
    iid = concept.cover_image_id
    if not iid:
        iid = db.scalar(select(ConceptImage.image_id)
                        .where(ConceptImage.concept_id == concept.id)
                        .order_by(ConceptImage.score.desc(),
                                  ConceptImage.image_id.desc()).limit(1))
    return {"key": concept.key, "found": True,
            "kind": concept.kind, "pool": concept.pool,
            "image_count": concept.image_count, "draw_count": concept.draw_count,
            "image": _image_brief(db, int(iid)) if iid else None}


def images_for(db: Session, key: str, *, limit: int = 50,
               offset: int = 0) -> dict:
    """概念详情页：按封面分排序，首屏最多 50 张，更多靠 offset 滚动加载。"""
    concept = _concept_row(db, key)
    if concept is None:
        return {"key": key, "found": False, "total": 0, "limit": limit,
                "offset": offset, "items": []}
    cap = max(1, min(50, limit))
    total = int(db.scalar(select(func.count()).select_from(ConceptImage)
                          .where(ConceptImage.concept_id == concept.id)) or 0)
    ids = db.scalars(select(ConceptImage.image_id)
                     .where(ConceptImage.concept_id == concept.id)
                     .order_by(ConceptImage.score.desc(),
                               ConceptImage.image_id.desc())
                     .limit(cap).offset(max(0, offset))).all()
    items = [x for x in (_image_brief(db, int(i)) for i in ids) if x]
    return {"key": concept.key, "label": concept.label, "kind": concept.kind,
            "pool": concept.pool, "found": True, "total": total,
            "limit": cap, "offset": max(0, offset), "items": items}


def thumbs_for(db: Session, key: str, limit: int = 1) -> dict:
    """兼容旧调用（语义检索取「我用它出过几张图」）：最多返回一张封面。"""
    c = cover(db, key)
    return {"key": c["key"], "found": c["found"],
            "image_count": c["image_count"], "draw_count": c["draw_count"],
            "thumbs": ([{"id": c["image"]["id"], "url": c["image"]["url"],
                         "rating": c["image"]["rating"],
                         "favorite": c["image"]["favorite"]}]
                       if c["image"] else [])}


def thumbs_batch(db: Session, keys: list[str], limit: int = 1) -> dict:
    return {"items": [thumbs_for(db, str(k), limit)
                      for k in keys[:40] if str(k or "").strip()]}
