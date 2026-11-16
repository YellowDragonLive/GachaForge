# -*- coding: utf-8 -*-
"""Pydantic 边界校验：客户端输入一律先过这里，服务层不接触 HTTP 对象。"""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class _Out(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class PoolIn(BaseModel):
    slug: str = Field(min_length=1, max_length=160)
    name: str = Field(min_length=1, max_length=200)
    kind: str = "条目"
    source: str = "manual"
    source_ref: str = ""
    enabled: bool = True
    weight: float = 1.0


class PoolUpdate(BaseModel):
    name: str | None = None
    kind: str | None = None
    enabled: bool | None = None
    weight: float | None = None


class PoolItemIn(BaseModel):
    label: str = Field(min_length=1)
    tags: str = ""
    weight: float = 1.0
    enabled: bool = True


class PoolOut(_Out):
    id: int
    slug: str
    name: str
    kind: str
    source: str
    source_ref: str
    enabled: bool
    weight: float
    item_count: int = 0


class PoolItemOut(_Out):
    id: int
    pool_id: int
    label: str
    tags: str
    weight: float
    enabled: bool


class Slot(BaseModel):
    pool: str = ""
    count: int = Field(default=1, ge=1, le=20)
    weight: float = Field(default=1.0, ge=0.0, le=1.0)
    filter: str = ""
    # 锁定到具体条目（按 label 匹配）：填了就取这一条、不随机，也不吃 filter。
    pick: str = ""


class RecipeDefinition(BaseModel):
    fixed_head: str = ""
    fixed_tail: str = ""
    template: str = ""
    # 人数 tag（"1girl, 1boy, multiple girls"）：由装配面板按人物卡张数算好注入，
    # 空表示沿用旧行为（人数仍由角色条目自带）。
    count_tags: str = ""
    slots: list[Slot] = []


class RecipeIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    definition: RecipeDefinition
    gen_profile_id: int | None = None
    is_builtin: bool = False


class RecipeOut(_Out):
    id: int
    name: str
    definition_json: str
    gen_profile_id: int | None
    version: int
    is_builtin: bool


class GenProfileIn(BaseModel):
    # 带 id = 就地更新（允许改名）；不带 = 按名字 upsert（同名即更新，异名即新建）。
    # 之前没有 id，改预设名会被当成新预设，库里越积越多。
    id: int | None = None
    name: str = Field(min_length=1, max_length=160)
    checkpoint: str = ""
    loras: list[dict[str, Any]] = []
    steps: int = Field(default=20, ge=1, le=150)
    cfg: float = Field(default=6.0, ge=0.0, le=30.0)
    sampler: str = "euler_ancestral"
    scheduler: str = "normal"
    width: int = Field(default=1024, ge=64, le=4096)
    height: int = Field(default=1360, ge=64, le=4096)
    negative: str = "worst quality, low quality"
    workflow: str = "sdxl_minimal.json"


class GenProfileOut(_Out):
    id: int
    name: str
    checkpoint: str
    loras_json: str
    steps: int
    cfg: float
    sampler: str
    scheduler: str
    width: int
    height: int
    negative: str
    workflow: str


class DrawSessionIn(BaseModel):
    recipe_id: int | None = None
    definition: RecipeDefinition | None = None
    pulls: int = Field(default=3, ge=1, le=50)
    count: int = Field(default=1, ge=1, le=20)
    seed: int | None = None
    pool_slugs: list[str] = []
    filter: str = ""
    no_repeat: bool = False
    gen_profile_id: int | None = None


class JobsIn(BaseModel):
    draw_ids: list[int] = Field(min_length=1, max_length=50)
    gen_profile_id: int | None = None
    force: bool = False


class ImagePatch(BaseModel):
    rating: int | None = Field(default=None, ge=0, le=5)
    favorite: bool | None = None
    note: str | None = None


class ImportIn(BaseModel):
    path: str = Field(min_length=1)
    kind: str = "auto"
    pool_slug: str = ""


class ScanDirIn(BaseModel):
    path: str = Field(min_length=1)


class ConceptBatchIn(BaseModel):
    keys: list[str] = Field(default_factory=list, max_length=40)
    limit: int = Field(default=3, ge=1, le=12)
