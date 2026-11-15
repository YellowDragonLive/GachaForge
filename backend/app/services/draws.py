# -*- coding: utf-8 -*-
"""配方 / 参数预设 / 抽卡会话服务。业务规则在这里，不接触 HTTP 对象。"""
from __future__ import annotations

import json
import random
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..core import recipes as recipe_core
from ..core.pools import apply_filter_spec, build_prompt, draw_pull, pick_pools
from ..errors import ConflictError, NotFoundError
from ..models import Draw, DrawSession, GenProfile, Recipe
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


# ---------------- 抽卡 ----------------

def create_session(db: Session, params: dict) -> dict:
    """一次抽卡 = 配方快照 + 参数快照 + N 条 Draw（可复现）。"""
    recipe_def: dict = {}
    recipe_id = params.get("recipe_id")
    if recipe_id:
        row = get_recipe(db, recipe_id)
        recipe_def = json.loads(row.definition_json or "{}")
        profile_id = params.get("gen_profile_id") or row.gen_profile_id
    else:
        recipe_def = params.get("definition") or {}
        profile_id = params.get("gen_profile_id")
    profile = resolve_profile(db, profile_id)

    all_pools = pool_svc.pools_for_draw(db, params.get("pool_slugs") or None)
    if not all_pools:
        raise ConflictError("没有可用的卡池，请先在「卡池管理」导入或启用卡池")
    selected = pick_pools(all_pools, params.get("pool_slugs") or "")
    selected = apply_filter_spec(selected, params.get("filter", ""))
    if not selected:
        raise ConflictError("过滤后没有任何可用条目")

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
            prompt, detail = build_prompt(card), card
        cards.append({"idx": i + 1,
                      "seed": (int(seed) + i) if seed is not None else None,
                      "prompt": prompt, "negative": negative, "detail": detail})

    session = DrawSession(
        recipe_id=recipe_id,
        recipe_snapshot_json=_dump(recipe_def),
        profile_snapshot_json=_dump(profile),
        seed=seed, pulls=pulls, count=count,
        workflow_version=profile.get("workflow", "sdxl_minimal.json"))
    db.add(session)
    db.flush()
    rows = []
    for c in cards:
        row = Draw(session_id=session.id, idx=c["idx"], seed=c["seed"],
                   prompt=c["prompt"], negative=c["negative"],
                   detail_json=_dump(c["detail"]))
        db.add(row)
        db.flush()
        rows.append({"id": row.id, **c})
    db.commit()
    return {"session_id": session.id, "seed": seed, "recipe": recipe_def,
            "profile": profile, "pool_count": len(selected), "draws": rows}


def get_session(db: Session, session_id: int) -> dict:
    s = db.get(DrawSession, session_id)
    if not s:
        raise NotFoundError(f"抽卡会话不存在: id={session_id}")
    return {"id": s.id, "recipe_id": s.recipe_id,
            "recipe_snapshot": json.loads(s.recipe_snapshot_json or "{}"),
            "profile_snapshot": json.loads(s.profile_snapshot_json or "{}"),
            "seed": s.seed, "pulls": s.pulls, "count": s.count,
            "workflow_version": s.workflow_version,
            "created_at": s.created_at.isoformat(timespec="seconds")}


def list_draws(db: Session, *, session_id: int | None = None,
               limit: int = 200) -> list[dict]:
    stmt = select(Draw).order_by(Draw.id.desc()).limit(min(500, limit))
    if session_id:
        stmt = stmt.where(Draw.session_id == session_id).order_by(Draw.idx)
    rows = db.scalars(stmt).all()
    return [{"id": d.id, "session_id": d.session_id, "idx": d.idx, "seed": d.seed,
             "prompt": d.prompt, "negative": d.negative,
             "detail": json.loads(d.detail_json or "[]")} for d in rows]


def preview_recipe(db: Session, definition: dict, *, pulls: int = 3,
                   seed: int | None = None) -> list[dict]:
    pools = pool_svc.pools_for_draw(db)
    rng = random.Random(seed)
    return [recipe_core.run_recipe(definition, pools, rng) for _ in range(pulls)]
