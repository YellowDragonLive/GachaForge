# -*- coding: utf-8 -*-
"""配方 / 参数预设 / 抽卡会话服务。业务规则在这里，不接触 HTTP 对象。

v2：抽卡结果与会话快照写入关系表（draw_slots / draw_slot_tags /
draw_profiles / session_loras / session_recipes），不再存重复 JSON。
对外的 API 响应形状与 v1 保持一致，前端结果区与复现逻辑无需重写。
"""
from __future__ import annotations

import copy
import json
import random
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..core import recipes as recipe_core
from ..core.pools import apply_filter_spec, build_prompt, draw_pull, pick_pools
from ..errors import ConflictError, NotFoundError
from ..models import (Draw, DrawSession, DrawSlot, DrawSlotTag, GenProfile, Pool,
                      Recipe, SessionLora, SessionProfile, SessionRecipe,
                      SessionRecipeSlot)
from . import pools as pool_svc


# ---------------- 配方 ----------------

def _dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def recipe_out(row: Recipe) -> dict:
    return {"id": row.id, "name": row.name,
            "definition": json.loads(row.definition_json or "{}"),
            "gen_profile_id": row.gen_profile_id, "version": row.version,
            "is_builtin": row.is_builtin}


def list_recipes(db: Session) -> list[dict]:
    return [recipe_out(r) for r in db.scalars(select(Recipe).order_by(Recipe.id)).all()]


def get_recipe(db: Session, recipe_id: int) -> Recipe:
    r = db.get(Recipe, recipe_id)
    if not r:
        raise NotFoundError(f"配方不存在: id={recipe_id}")
    return r


def upsert_recipe(db: Session, data: dict, *, recipe_id: int | None = None) -> dict:
    name = data["name"].strip()
    existing = db.scalar(select(Recipe).where(Recipe.name == name))
    if existing and existing.id != recipe_id:
        raise ConflictError(f"配方名已存在: {name}")
    definition = data.get("definition") or {}
    if recipe_id:
        row = get_recipe(db, recipe_id)
        row.name = name
        row.definition_json = _dump(definition)
        row.gen_profile_id = data.get("gen_profile_id")
        row.version += 1
    else:
        row = Recipe(name=name, definition_json=_dump(definition),
                     gen_profile_id=data.get("gen_profile_id"),
                     is_builtin=bool(data.get("is_builtin", False)))
        db.add(row)
    db.commit()
    db.refresh(row)
    return recipe_out(row)


def delete_recipe(db: Session, recipe_id: int) -> None:
    db.delete(get_recipe(db, recipe_id))
    db.commit()


# ---------------- 参数预设 ----------------

DEFAULT_PROFILE = {
    "name": "默认 SDXL", "checkpoint": "", "loras": [], "steps": 20, "cfg": 6.0,
    "sampler": "euler_ancestral", "scheduler": "normal", "width": 1024,
    "height": 1360, "negative": "worst quality, low quality",
    "workflow": "sdxl_minimal.json",
}


def profile_out(row: GenProfile) -> dict:
    return {"id": row.id, "name": row.name, "checkpoint": row.checkpoint,
            "loras": json.loads(row.loras_json or "[]"), "steps": row.steps,
            "cfg": row.cfg, "sampler": row.sampler, "scheduler": row.scheduler,
            "width": row.width, "height": row.height, "negative": row.negative,
            "workflow": row.workflow}


def list_profiles(db: Session) -> list[dict]:
    return [profile_out(r) for r in db.scalars(select(GenProfile).order_by(GenProfile.id)).all()]


def ensure_default_profile(db: Session) -> GenProfile:
    row = db.scalar(select(GenProfile).where(GenProfile.name == DEFAULT_PROFILE["name"]))
    if row:
        return row
    fields = {k: v for k, v in DEFAULT_PROFILE.items() if k != "loras"}
    row = GenProfile(**fields, loras_json="[]")
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def upsert_profile(db: Session, data: dict) -> dict:
    name = data["name"].strip()
    row = db.scalar(select(GenProfile).where(GenProfile.name == name))
    if row is None:
        row = GenProfile(name=name)
        db.add(row)
    for key in ("checkpoint", "steps", "cfg", "sampler", "scheduler", "width",
                "height", "negative", "workflow"):
        if key in data:
            setattr(row, key, data[key])
    row.loras_json = _dump(data.get("loras", []))
    db.commit()
    db.refresh(row)
    return profile_out(row)


def resolve_profile(db: Session, profile_id: int | None) -> dict:
    row = db.get(GenProfile, profile_id) if profile_id else None
    if row is None:
        row = ensure_default_profile(db)
    return profile_out(row)


# ---------------- 会话快照（关系表） ----------------

def _write_profile_snapshot(db: Session, session_id: int, profile: dict,
                            recipe_name: str = "", recipe_def: dict | None = None) -> None:
    p = SessionProfile(
        session_id=session_id, name=str(profile.get("name") or ""),
        checkpoint=str(profile.get("checkpoint") or ""),
        steps=int(profile.get("steps") or 20), cfg=float(profile.get("cfg") or 6.0),
        sampler=str(profile.get("sampler") or ""),
        scheduler=str(profile.get("scheduler") or ""),
        width=int(profile.get("width") or 1024),
        height=int(profile.get("height") or 1360),
        negative=str(profile.get("negative") or ""),
        workflow=str(profile.get("workflow") or "sdxl_minimal.json"),
        seed_policy=str(profile.get("seed_policy") or "draw_seed"))
    db.add(p)
    db.flush()
    for i, lora in enumerate(profile.get("loras") or []):
        if isinstance(lora, dict):
            db.add(SessionLora(profile_id=p.id, idx=i,
                               name=str(lora.get("name") or ""),
                               weight=float(lora.get("weight") or 1.0)))
    definition = recipe_def or {}
    r = SessionRecipe(session_id=session_id, name=recipe_name,
                      fixed_head=str(definition.get("fixed_head") or ""),
                      fixed_tail=str(definition.get("fixed_tail") or ""),
                      template=str(definition.get("template") or ""))
    db.add(r)
    db.flush()
    for i, slot in enumerate(definition.get("slots") or []):
        if not isinstance(slot, dict):
            continue
        db.add(SessionRecipeSlot(
            recipe_snapshot_id=r.id, idx=i, pool=str(slot.get("pool") or ""),
            count=int(slot.get("count") or 1),
            weight=float(slot.get("weight") or 1.0),
            filter=str(slot.get("filter") or ""),
            template=str(slot.get("template") or "")))


def session_profile_dict(db: Session, session_id: int) -> dict:
    """给生成 Worker 用：从关系表还原成 build_workflow 需要的字典。"""
    p = db.scalar(select(SessionProfile).where(SessionProfile.session_id == session_id))
    if p is None:
        return dict(DEFAULT_PROFILE)
    loras = db.scalars(select(SessionLora).where(SessionLora.profile_id == p.id)
                       .order_by(SessionLora.idx)).all()
    return {"name": p.name, "checkpoint": p.checkpoint,
            "loras": [{"name": x.name, "weight": x.weight} for x in loras],
            "steps": p.steps, "cfg": p.cfg, "sampler": p.sampler,
            "scheduler": p.scheduler, "width": p.width, "height": p.height,
            "negative": p.negative, "workflow": p.workflow}


def session_recipe_dict(db: Session, session_id: int) -> dict:
    r = db.scalar(select(SessionRecipe).where(SessionRecipe.session_id == session_id))
    if r is None:
        return {}
    slots = db.scalars(select(SessionRecipeSlot)
                       .where(SessionRecipeSlot.recipe_snapshot_id == r.id)
                       .order_by(SessionRecipeSlot.idx)).all()
    return {"name": r.name, "fixed_head": r.fixed_head,
            "fixed_tail": r.fixed_tail, "template": r.template,
            "slots": [{"pool": s.pool, "count": s.count, "weight": s.weight,
                       "filter": s.filter, "template": s.template} for s in slots]}


def _write_detail(db: Session, draw_id: int, detail: list[dict]) -> None:
    for i, item in enumerate(detail or []):
        if not isinstance(item, dict):
            continue
        slot = DrawSlot(draw_id=draw_id, idx=i,
                        slot=str(item.get("slot") or item.get("friendly") or "条目"),
                        pool=str(item.get("pool") or ""),
                        label=str(item.get("label") or ""),
                        empty=bool(item.get("empty")),
                        reason=str(item.get("reason") or ""))
        db.add(slot)
        db.flush()
        raw = item.get("tags")
        tags = raw if isinstance(raw, list) else ([raw] if raw else [])
        for j, tag in enumerate(tags):
            if tag is None or str(tag) == "":
                continue
            db.add(DrawSlotTag(slot_id=slot.id, idx=j, tag=str(tag)))


def detail_for_draws(db: Session, draw_ids: list[int]) -> dict[int, list[dict]]:
    """一次查询组装 detail，避免 N+1；输出仍是 v1 的 {slot,pool,label,tags} 契约。"""
    out: dict[int, list[dict]] = {int(i): [] for i in draw_ids}
    if not draw_ids:
        return out
    slots = db.scalars(select(DrawSlot).where(DrawSlot.draw_id.in_(draw_ids))
                       .order_by(DrawSlot.draw_id, DrawSlot.idx)).all()
    by_slot: dict[int, list[str]] = {}
    if slots:
        ids = [s.id for s in slots]
        for slot_id, tag in db.execute(
                select(DrawSlotTag.slot_id, DrawSlotTag.tag)
                .where(DrawSlotTag.slot_id.in_(ids))
                .order_by(DrawSlotTag.slot_id, DrawSlotTag.idx)).all():
            by_slot.setdefault(int(slot_id), []).append(str(tag))
    for s in slots:
        item = {"slot": s.slot, "pool": s.pool, "label": s.label,
                "tags": by_slot.get(s.id, [])}
        if s.empty:
            item["empty"] = True
            item["reason"] = s.reason
        out.setdefault(int(s.draw_id), []).append(item)
    return out


# ---------------- 抽卡 ----------------

def create_session(db: Session, params: dict) -> dict:
    """一次抽卡 = 关系化快照 + N 条 Draw（可复现）。"""
    recipe_def: dict = {}
    recipe_name = ""
    recipe_id = params.get("recipe_id")
    if recipe_id:
        row = get_recipe(db, recipe_id)
        recipe_def = json.loads(row.definition_json or "{}")
        recipe_name = row.name
        profile_id = params.get("gen_profile_id") or row.gen_profile_id
    else:
        recipe_def = params.get("definition") or {}
        profile_id = params.get("gen_profile_id")
    profile = resolve_profile(db, profile_id)
    filter_spec = str(params.get("filter") or "").strip()

    # 会话级表单过滤优先于配方槽位里写死的 filter：两层做 AND 时，
    # 用户填「角色:asuna」会被槽位残留的 filter:fate 全部筛掉，且极难自查。
    # 这里只改本次执行用的副本（快照如实记录被覆盖后的定义），不改数据库里的配方。
    overridden_filters: list[str] = []
    if recipe_def and filter_spec:
        recipe_def = copy.deepcopy(recipe_def)
        for slot in recipe_def.get("slots") or []:
            if str(slot.get("filter") or "").strip():
                overridden_filters.append(f"{slot.get('pool')}={slot['filter']}")
                slot["filter"] = ""

    all_pools = pool_svc.pools_for_draw(db, params.get("pool_slugs") or None)
    if not all_pools:
        raise ConflictError("没有可用的卡池，请先在「卡池管理」导入或启用卡池")
    raw_selected = pick_pools(all_pools, params.get("pool_slugs") or "")
    selected = apply_filter_spec(raw_selected, filter_spec)
    if not selected:
        raise ConflictError("过滤后没有任何可用条目")
    removed_pools = len(raw_selected) - len(selected)

    seed = params.get("seed")
    pulls = int(params.get("pulls", 3))
    count = int(params.get("count", 1))
    rng = random.Random(seed)
    used_hist: dict = {}
    negative = profile.get("negative", "")
    cards: list[dict] = []
    for i in range(pulls):
        if recipe_def:
            drawn = recipe_core.run_recipe(recipe_def, selected, rng)
            prompt, detail = drawn["prompt"], drawn["detail"]
        else:
            card = draw_pull(rng, selected, count, bool(params.get("no_repeat")),
                             used_hist, all_pools=all_pools)
            prompt = build_prompt(card)
            # 统一 detail 契约：无论是否用配方，每个槽位都是
            # {slot, pool, label, tags: list[str]}。
            # 全池随机时 PoolItem.tags 常为空，真正抽到的是 label；
            # 写进 tags 才能让结果区 chip 与关系表概念索引都拿到内容。
            detail = [
                {"slot": it.get("friendly") or it.get("pool") or "条目",
                 "pool": it.get("pool") or "",
                 "label": it.get("label") or "",
                 "tags": ([str(it["tags"])] if it.get("tags")
                          else ([str(it["label"])] if it.get("label") else []))}
                for it in card
            ]
        cards.append({"idx": i + 1,
                      "seed": (int(seed) + i) if seed is not None else None,
                      "prompt": prompt, "negative": negative, "detail": detail})

    session = DrawSession(recipe_id=recipe_id, seed=seed, pulls=pulls, count=count,
                          workflow_version=profile.get("workflow", "sdxl_minimal.json"))
    db.add(session)
    db.flush()
    _write_profile_snapshot(db, session.id, profile, recipe_name, recipe_def)
    rows = []
    for c in cards:
        row = Draw(session_id=session.id, idx=c["idx"], seed=c["seed"],
                   prompt=c["prompt"], negative=c["negative"])
        db.add(row)
        db.flush()
        _write_detail(db, row.id, c["detail"])
        rows.append({"id": row.id, **c})
    db.commit()

    # 裸关键字会作用于全部卡池，配方槽位因此静默变空是历史故障的根因。
    empty_slots = sorted({str(x["slot"]) for c in cards
                          for x in c["detail"] if x.get("empty")})
    bare_kws = [p.strip() for p in filter_spec.split(",")
                if p.strip() and ":" not in p and "：" not in p]
    warnings: list[str] = []
    if bare_kws and recipe_def:
        warnings.append(
            f"「按池过滤」里的裸关键字 {'、'.join(bare_kws)} 会作用于全部卡池："
            f"本次移除了 {removed_pools} 个无匹配条目的池，配方槽位可能因此变空。"
            "只想筛某个池请写「角色:fate」，或留空让配方槽位自己的 filter 生效。")
    if overridden_filters:
        warnings.append(
            f"表单过滤 '{filter_spec}' 本次优先，已临时覆盖配方槽位自带的 filter"
            f"（{'、'.join(overridden_filters)}）；想按槽位 filter 抽请把表单留空。")
    if empty_slots:
        warnings.append("本次没有抽到内容的槽位：" + "、".join(empty_slots) +
                        "（原因见卡片里的 ⚠ 标记）")

    return {"session_id": session.id, "seed": seed, "recipe": recipe_def,
            "profile": profile, "pool_count": len(selected),
            "filter": filter_spec, "warnings": warnings, "draws": rows}


def get_session(db: Session, session_id: int) -> dict:
    s = db.get(DrawSession, session_id)
    if not s:
        raise NotFoundError(f"抽卡会话不存在: id={session_id}")
    r = session_recipe_dict(db, session_id)
    # v1 的 recipe_snapshot 不含 name 字段，组装时去掉，保持响应兼容
    recipe_snapshot = {k: v for k, v in r.items() if k != "name"}
    return {"id": s.id, "recipe_id": s.recipe_id,
            "recipe_snapshot": recipe_snapshot,
            "profile_snapshot": session_profile_dict(db, session_id),
            "seed": s.seed, "pulls": s.pulls, "count": s.count,
            "workflow_version": s.workflow_version,
            "created_at": s.created_at.isoformat(timespec="seconds")}


def list_draws(db: Session, *, session_id: int | None = None,
               limit: int = 200) -> list[dict]:
    stmt = select(Draw).order_by(Draw.id.desc()).limit(min(500, limit))
    if session_id:
        stmt = stmt.where(Draw.session_id == session_id).order_by(Draw.idx)
    rows = db.scalars(stmt).all()
    details = detail_for_draws(db, [d.id for d in rows])
    return [{"id": d.id, "session_id": d.session_id, "idx": d.idx, "seed": d.seed,
             "prompt": d.prompt, "negative": d.negative,
             "detail": details.get(d.id, [])} for d in rows]


def preview_recipe(db: Session, definition: dict, *, pulls: int = 3,
                   seed: int | None = None) -> list[dict]:
    pools = pool_svc.pools_for_draw(db)
    rng = random.Random(seed)
    return [recipe_core.run_recipe(definition, pools, rng) for _ in range(pulls)]
