# -*- coding: utf-8 -*-
"""配方、生成参数预设、配方预览接口。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from ..db import get_db
from ..errors import ok
from ..schemas import GenProfileIn, RecipeDefinition, RecipeIn
from ..services import draws as svc

router = APIRouter(prefix="/api", tags=["recipes"])


@router.get("/recipes")
def list_recipes(db: Session = Depends(get_db)):
    return ok(svc.list_recipes(db))


@router.post("/recipes")
def upsert_recipe(body: RecipeIn, db: Session = Depends(get_db)):
    return ok(svc.upsert_recipe(db, body.model_dump()))


@router.put("/recipes/{recipe_id}")
def update_recipe(recipe_id: int, body: RecipeIn, db: Session = Depends(get_db)):
    return ok(svc.upsert_recipe(db, body.model_dump(), recipe_id=recipe_id))


@router.delete("/recipes/{recipe_id}")
def delete_recipe(recipe_id: int, db: Session = Depends(get_db)):
    svc.delete_recipe(db, recipe_id)
    return ok({"deleted": recipe_id})


@router.post("/recipes/preview")
def preview(definition: RecipeDefinition,
            pulls: int = Query(3, ge=1, le=10), seed: int | None = None,
            db: Session = Depends(get_db)):
    return ok(svc.preview_recipe(db, definition.model_dump(), pulls=pulls, seed=seed))


@router.get("/gen-profiles")
def list_profiles(db: Session = Depends(get_db)):
    return ok(svc.list_profiles(db))


@router.post("/gen-profiles")
def upsert_profile(body: GenProfileIn, db: Session = Depends(get_db)):
    return ok(svc.upsert_profile(db, body.model_dump()))
