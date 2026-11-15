# -*- coding: utf-8 -*-
"""通用概念缩略图层：把数据库里「概念 → 它生成的真实图」反查成可点选卡片。

抽象概念（画师 / tag / 动作 / 角色 / 底模 / LoRA / 配方）文字说不清，
但抽卡数据库本身已经把每次抽到的概念和它产出的图一起存下来了：
  draws.prompt / detail_json            抽到的概念
  draw_sessions.profile_snapshot_json  底模 / LoRA
  generation_jobs → images.thumb_path  该次抽卡真实产出的缩略图
因此切词即得到「概念 → 代表图」倒排索引：不复制图片、不新增服务、
不依赖任何 AI 库，也不写数据库。抽得越多，每个概念的样图越贴合本机口味。

池类别直接读 pools.kind，不手写映射表：新增任何类别的抽象概念都自动带上
正确的过滤池，避免退化成「全局裸关键字」把其它槽位筛空。
"""
from __future__ import annotations

import json
import re
import time
from collections import defaultdict
from dataclasses import dataclass

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from ..models import Draw, DrawSession, GenerationJob, Image as ImageRow, Pool, Recipe

# 通用质量词 / 人数词：频次极高，但没有「看一眼就知道是什么」的信息量
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

# 只有历史遗留的英文槽位名需要别名，中文类别直接用数据库里的 pools.kind
ALIAS = {"artist": "画师", "artists": "画师", "gallery:artists": "画师",
         "action": "动作", "character": "角色", "characters": "角色",
         "zh_tw": "角色"}
INFO_KINDS = frozenset({"底模", "LoRA", "配方"})

# prompt 里 "1girl asuna (sao)" 这类人数前缀没有判断价值，剥掉留下真概念
_HEAD = re.compile(
    r"^(?:(?:1girl|2girls|3girls|1boy|2boys|1man|1woman|solo|a couple"
    r"|multiple girls|multiple boys)\s+)+", re.I)


@dataclass
class _Row:
    image_id: int
    rating: int
    favorite: bool
    prompt: str
    detail: list
    profile: dict
    recipe: str
    hay: str


_CACHE: dict = {"sig": None, "at": 0.0, "rows": None, "index": None}
_TTL = 20.0


def _clean(s) -> str:
    """归一化：去 danbooru 转义反斜杠、压缩空白、小写。用于去重与匹配。"""
    return re.sub(r"\s+", " ", str(s or "").replace("\\", "").strip().lower())


def _valid(key: str) -> bool:
    if not key or key in STOP or len(key) < 3 or len(key) > 44:
        return False
    if key.isdigit() or len(key.split()) > 6:
        return False
    if any(f in key for f in BAD_FRAGMENT):
        return False
    if re.fullmatch(r"[a-z0-9_\-]{1,2}", key):
        return False
    return True


def _split(raw) -> list[str]:
    """把一段 prompt / 槽位 tags 切成候选概念，保留原始大小写用于显示。"""
    out = []
    for part in re.split(r"[,，\n]", str(raw or "")):
        disp = re.sub(r"\s+", " ", str(part).replace("\\", "").strip())
        disp = _HEAD.sub("", disp).strip()
        key = _clean(disp)
        if _valid(key):
            out.append((key, disp))
    return out


def _json(raw, fallback):
    try:
        val = json.loads(raw or "")
        return val if isinstance(val, type(fallback)) else fallback
    except (ValueError, TypeError):
        return fallback


def _signature(db: Session) -> tuple:
    """评分 / 收藏 / 新图都会改变签名，实现写后立即失效；TTL 只是兜底。"""
    row = db.execute(text(
        "select (select count(*) from images),"
        " (select coalesce(max(id),0) from images),"
        " (select coalesce(sum(rating),0) from images),"
        " (select coalesce(sum(favorite),0) from images),"
        " (select count(*) from draws),"
        " (select count(*) from pools)")).one()
    return tuple(int(x or 0) for x in row)


def _load_rows(db: Session) -> list[_Row]:
    stmt = (select(ImageRow.id, ImageRow.rating, ImageRow.favorite,
                   Draw.prompt, Draw.detail_json,
                   DrawSession.profile_snapshot_json, Recipe.name)
            .join(GenerationJob, GenerationJob.id == ImageRow.job_id)
            .join(Draw, Draw.id == GenerationJob.draw_id)
            .join(DrawSession, DrawSession.id == Draw.session_id)
            .outerjoin(Recipe, Recipe.id == DrawSession.recipe_id)
            .order_by(ImageRow.id.desc()))
    rows = []
    for r in db.execute(stmt).all():
        detail = _json(r[4], [])
        profile = _json(r[5], {})
        prompt = str(r[3] or "")
        rows.append(_Row(
            image_id=int(r[0]), rating=int(r[1] or 0), favorite=bool(r[2]),
            prompt=prompt, detail=detail if isinstance(detail, list) else [],
            profile=profile if isinstance(profile, dict) else {},
            recipe=str(r[6] or ""),
            hay=_clean(prompt + " " + str(r[4] or "") + " " + str(r[5] or "")),
        ))
    return rows


def _index(db: Session):
    sig = _signature(db)
    now = time.monotonic()
    if (_CACHE["index"] is not None and _CACHE["sig"] == sig
            and now - _CACHE["at"] < _TTL):
        return _CACHE["rows"], _CACHE["index"]
    rows = _load_rows(db)
    kinds = {str(k) for k in db.execute(select(Pool.kind)).scalars() if k}
    idx: dict[str, dict] = {}

    def add(key: str, disp: str, kind: str, pool: str,
            filterable: bool, row: _Row) -> None:
        cur = idx.get(key)
        if cur is None:
            cur = idx[key] = {"key": key, "label": disp, "kind": kind,
                              "pool": pool, "filterable": filterable,
                              "draws": 0, "images": {}}
        elif (filterable and not cur["filterable"]) or (
                filterable == cur["filterable"]
                and kind != "tag" and cur["kind"] == "tag"):
            # 具体类别 > 泛化 tag；可过滤 > 仅展示的信息卡片
            cur["kind"], cur["pool"], cur["filterable"] = kind, pool, filterable
        cur["draws"] += 1
        cur["images"][row.image_id] = row

    for row in rows:
        # 1) prompt 切词 —— 最终送给 ComfyUI 的完整字符串，概念一定在里面
        for key, disp in _split(row.prompt):
            add(key, disp, "tag", "", True, row)
        # 2) detail 槽位 —— 中文槽位名就是 pools.kind，过滤能精确命中
        for slot in row.detail:
            if not isinstance(slot, dict):
                continue
            raw = str(slot.get("slot") or slot.get("friendly") or "").strip()
            if not raw or raw in ("fixed_head", "fixed_tail", "template"):
                continue
            kind = ALIAS.get(raw.lower()) or (raw if raw in kinds else "")
            pool = kind if kind in kinds else ""
            tags = slot.get("tags") or []
            if isinstance(tags, str):
                tags = [tags]
            for t in tags:
                for key, disp in _split(t):
                    add(key, disp, kind or "tag", pool, True, row)
        # 3) 出图预设 —— 底模 / LoRA / 配方不是池过滤能表达的，只做信息卡片
        cp = str(row.profile.get("checkpoint") or "").strip()
        if cp:
            add(_clean(cp), cp, "底模", "", False, row)
        for lora in (row.profile.get("loras") or []):
            name = str((lora or {}).get("name") or "").strip() if isinstance(lora, dict) else ""
            if name:
                add(_clean(name), name, "LoRA", "", False, row)
        if row.recipe:
            add(_clean(row.recipe), row.recipe, "配方", "", False, row)
    _CACHE.update({"sig": sig, "at": now, "rows": rows, "index": idx})
    return rows, idx


def _thumbs(entry: dict | None, limit: int) -> list[dict]:
    if not entry:
        return []
    rows = sorted(entry["images"].values(),
                  key=lambda r: (r.favorite, r.rating, r.image_id), reverse=True)
    return [{"id": r.image_id, "url": f"/api/images/{r.image_id}/thumb",
             "rating": r.rating, "favorite": r.favorite}
            for r in rows[:max(1, min(12, limit))]]


def _card(key: str, entry: dict, thumbs: int) -> dict:
    thumbs_list = _thumbs(entry, thumbs)
    return {
        "key": entry["key"], "label": entry["label"], "kind": entry["kind"],
        "pool": entry["pool"], "filterable": entry["filterable"],
        "draw_count": entry["draws"], "image_count": len(entry["images"]),
        "thumbs": thumbs_list,
        "thumb_url": (thumbs_list or [{}])[0].get("url"),
    }


def _kinds(idx: dict) -> list[dict]:
    counts = defaultdict(int)
    for e in idx.values():
        counts[e["kind"]] += 1
    return [{"kind": k, "count": n}
            for k, n in sorted(counts.items(), key=lambda x: -x[1])]


def status(db: Session) -> dict:
    rows, idx = _index(db)
    return {"ready": bool(rows), "image_count": len(rows),
            "concept_count": len(idx), "kinds": _kinds(idx),
            "source": "draws + generation_jobs + images"}


def wall(db: Session, *, limit: int = 12, kind: str = "", q: str = "",
         thumbs: int = 3, include_info: bool = False) -> dict:
    """概念墙：按「有真实代表图的数量」排序，可按类别 / 关键字筛选。

    默认只给可点选的概念卡片；底模 / LoRA / 配方是信息类，需按类别切换查看，
    避免占满首屏却不产生任何过滤效果。
    """
    rows, idx = _index(db)
    needle = _clean(q)
    show_info = include_info or kind in INFO_KINDS
    needles = [e for e in idx.values()
               if (not kind or e["kind"] == kind)
               and (show_info or e["filterable"])
               and (not needle or needle in e["key"] or needle in _clean(e["label"]))]
    # 具体类别优先，其次代表图多的：让「一眼能判断」的概念排在通用词前面
    needles.sort(key=lambda e: (e["kind"] != "tag", len(e["images"]),
                                e["draws"]), reverse=True)
    cap = max(1, min(60, limit))
    if kind:
        picked = needles[:cap]
    else:
        # 跨类别轮转：不让单一类别（例如动作词条）占满首屏，
        # 让画师 / 角色 / 服装 / 背景 / 风格等不同抽象领域都露出样图。
        groups = defaultdict(list)
        for e in needles:
            groups[e["kind"]].append(e)
        ordered = sorted(groups, key=lambda k: -len(groups[k][0]["images"]))
        picked = []
        for i in range(max((len(g) for g in groups.values()), default=0)):
            for k in ordered:
                if i < len(groups[k]) and len(picked) < cap:
                    picked.append(groups[k][i])
            if len(picked) >= cap:
                break
    return {"total": len(needles), "image_count": len(rows),
            "kinds": _kinds(idx),
            "items": [_card(e["key"], e, thumbs) for e in picked]}


def thumbs_for(db: Session, key: str, limit: int = 4) -> dict:
    """单个概念的代表图；语义检索结果用它补上「我用它出过的图」。"""
    _, idx = _index(db)
    norm = _clean(key)
    entry = idx.get(norm)
    if entry is None and norm:
        cand = [e for k, e in idx.items() if k.startswith(norm) or norm.startswith(k)]
        entry = max(cand, key=lambda e: len(e["images"])) if cand else None
    return {"key": key, "found": entry is not None,
            "image_count": len(entry["images"]) if entry else 0,
            "draw_count": entry["draws"] if entry else 0,
            "thumbs": _thumbs(entry, limit)}


def thumbs_batch(db: Session, keys: list[str], limit: int = 3) -> dict:
    out = []
    for k in keys[:40]:
        if str(k or "").strip():
            out.append(thumbs_for(db, str(k), limit))
    return {"items": out}
