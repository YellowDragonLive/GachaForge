# -*- coding: utf-8 -*-
"""全部 ORM 表。v2 关系模型：抽卡结果 / 参数快照 / 图片元数据不再存重复 JSON。

单一事实源：
  draws → draw_slots → draw_slot_tags   每次抽到的结构化概念
  draw_sessions → draw_profiles(+session_loras) / session_recipes(+slots)  出图参数快照
  images → image_assets                  图片的业务归属与原始 prompt
  concepts → concept_images             由上面三处增量维护的概念物化索引

表结构变更一律走 backend/migrations 里的 Alembic 版本。
"""
from __future__ import annotations

import datetime as dt

from sqlalchemy import (Boolean, DateTime, Float, ForeignKey, Index, Integer,
                        String, Text, UniqueConstraint)
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


def now() -> dt.datetime:
    return dt.datetime.now()


class Pool(Base):
    __tablename__ = "pools"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    slug: Mapped[str] = mapped_column(String(160), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(200))
    kind: Mapped[str] = mapped_column(String(40), default="条目", index=True)
    source: Mapped[str] = mapped_column(String(40), default="import")
    source_ref: Mapped[str] = mapped_column(String(400), default="")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    weight: Mapped[float] = mapped_column(Float, default=1.0)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=now)


class PoolItem(Base):
    __tablename__ = "pool_items"
    __table_args__ = (Index("ix_items_pool_enabled", "pool_id", "enabled"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    pool_id: Mapped[int] = mapped_column(ForeignKey("pools.id", ondelete="CASCADE"),
                                         index=True)
    label: Mapped[str] = mapped_column(Text)
    tags: Mapped[str] = mapped_column(Text, default="")
    payload_json: Mapped[str] = mapped_column(Text, default="{}")
    weight: Mapped[float] = mapped_column(Float, default=1.0)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    content_hash: Mapped[str] = mapped_column(String(64), default="", index=True)


class GenProfile(Base):
    __tablename__ = "gen_profiles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(160), unique=True)
    checkpoint: Mapped[str] = mapped_column(String(300), default="")
    loras_json: Mapped[str] = mapped_column(Text, default="[]")
    steps: Mapped[int] = mapped_column(Integer, default=20)
    cfg: Mapped[float] = mapped_column(Float, default=6.0)
    sampler: Mapped[str] = mapped_column(String(80), default="euler_ancestral")
    scheduler: Mapped[str] = mapped_column(String(80), default="normal")
    width: Mapped[int] = mapped_column(Integer, default=1024)
    height: Mapped[int] = mapped_column(Integer, default=1360)
    negative: Mapped[str] = mapped_column(Text, default="worst quality, low quality")
    seed_policy: Mapped[str] = mapped_column(String(40), default="draw_seed")
    workflow: Mapped[str] = mapped_column(String(160), default="sdxl_minimal.json")
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=now)


class Recipe(Base):
    __tablename__ = "recipes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(200), unique=True)
    definition_json: Mapped[str] = mapped_column(Text, default="{}")
    gen_profile_id: Mapped[int | None] = mapped_column(
        ForeignKey("gen_profiles.id", ondelete="SET NULL"), nullable=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    is_builtin: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=now)


class DrawSession(Base):
    """一次抽卡会话。具体参数与配方定义在下面的关系表里，不存 JSON 快照。"""
    __tablename__ = "draw_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    recipe_id: Mapped[int | None] = mapped_column(ForeignKey("recipes.id"), nullable=True)
    seed: Mapped[int | None] = mapped_column(Integer, nullable=True)
    pulls: Mapped[int] = mapped_column(Integer, default=1)
    count: Mapped[int] = mapped_column(Integer, default=1)
    workflow_version: Mapped[str] = mapped_column(String(80), default="sdxl_minimal")
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=now)


class SessionProfile(Base):
    """会话级出图参数快照：结构化列，任意维度可直接 SQL 统计。"""
    __tablename__ = "draw_profiles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    session_id: Mapped[int] = mapped_column(
        ForeignKey("draw_sessions.id", ondelete="CASCADE"), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(160), default="")
    checkpoint: Mapped[str] = mapped_column(String(300), default="", index=True)
    steps: Mapped[int] = mapped_column(Integer, default=20)
    cfg: Mapped[float] = mapped_column(Float, default=6.0)
    sampler: Mapped[str] = mapped_column(String(80), default="euler_ancestral")
    scheduler: Mapped[str] = mapped_column(String(80), default="normal")
    width: Mapped[int] = mapped_column(Integer, default=1024)
    height: Mapped[int] = mapped_column(Integer, default=1360)
    negative: Mapped[str] = mapped_column(Text, default="")
    workflow: Mapped[str] = mapped_column(String(160), default="sdxl_minimal.json")
    seed_policy: Mapped[str] = mapped_column(String(40), default="draw_seed")


class SessionLora(Base):
    __tablename__ = "session_loras"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    profile_id: Mapped[int] = mapped_column(
        ForeignKey("draw_profiles.id", ondelete="CASCADE"), index=True)
    idx: Mapped[int] = mapped_column(Integer, default=0)
    name: Mapped[str] = mapped_column(String(300), default="", index=True)
    weight: Mapped[float] = mapped_column(Float, default=1.0)


class SessionRecipe(Base):
    """配方定义快照：固定头尾、模板与槽位全部结构化。"""
    __tablename__ = "session_recipes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    session_id: Mapped[int] = mapped_column(
        ForeignKey("draw_sessions.id", ondelete="CASCADE"), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(200), default="")
    fixed_head: Mapped[str] = mapped_column(Text, default="")
    fixed_tail: Mapped[str] = mapped_column(Text, default="")
    template: Mapped[str] = mapped_column(Text, default="")


class SessionRecipeSlot(Base):
    __tablename__ = "session_recipe_slots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    recipe_snapshot_id: Mapped[int] = mapped_column(
        ForeignKey("session_recipes.id", ondelete="CASCADE"), index=True)
    idx: Mapped[int] = mapped_column(Integer, default=0)
    pool: Mapped[str] = mapped_column(String(160), default="")
    count: Mapped[int] = mapped_column(Integer, default=1)
    weight: Mapped[float] = mapped_column(Float, default=1.0)
    filter: Mapped[str] = mapped_column(Text, default="")
    template: Mapped[str] = mapped_column(Text, default="")


class Draw(Base):
    __tablename__ = "draws"
    __table_args__ = (Index("ix_draws_session_idx", "session_id", "idx"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("draw_sessions.id", ondelete="CASCADE"),
                                            index=True)
    idx: Mapped[int] = mapped_column(Integer)
    seed: Mapped[int | None] = mapped_column(Integer, nullable=True)
    prompt: Mapped[str] = mapped_column(Text, default="")
    negative: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=now)


class DrawSlot(Base):
    """一条抽卡结果里的一个槽位。取代 v1 的 draws.detail_json。"""
    __tablename__ = "draw_slots"
    __table_args__ = (Index("ix_slots_draw_idx", "draw_id", "idx"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    draw_id: Mapped[int] = mapped_column(ForeignKey("draws.id", ondelete="CASCADE"),
                                        index=True)
    idx: Mapped[int] = mapped_column(Integer, default=0)
    slot: Mapped[str] = mapped_column(String(120), default="条目")
    pool: Mapped[str] = mapped_column(String(160), default="")
    label: Mapped[str] = mapped_column(Text, default="")
    empty: Mapped[bool] = mapped_column(Boolean, default=False)
    reason: Mapped[str] = mapped_column(Text, default="")


class DrawSlotTag(Base):
    """槽位里真正抽到的 tag，一行一个：概念索引直接以此为粒度。"""
    __tablename__ = "draw_slot_tags"
    __table_args__ = (Index("ix_slot_tags_tag", "tag"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    slot_id: Mapped[int] = mapped_column(ForeignKey("draw_slots.id", ondelete="CASCADE"),
                                        index=True)
    idx: Mapped[int] = mapped_column(Integer, default=0)
    tag: Mapped[str] = mapped_column(Text, default="")


class GenerationJob(Base):
    __tablename__ = "generation_jobs"
    __table_args__ = (
        UniqueConstraint("idempotency_key", name="uq_job_idempotency"),
        Index("ix_jobs_status_created", "status", "created_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    draw_id: Mapped[int] = mapped_column(ForeignKey("draws.id", ondelete="CASCADE"),
                                         index=True)
    comfy_prompt_id: Mapped[str] = mapped_column(String(120), default="")
    status: Mapped[str] = mapped_column(String(24), default="queued")
    progress: Mapped[int] = mapped_column(Integer, default=0)
    step: Mapped[int] = mapped_column(Integer, default=0)
    steps_total: Mapped[int] = mapped_column(Integer, default=0)
    retry_count: Mapped[int] = mapped_column(Integer, default=0)
    error_code: Mapped[str] = mapped_column(String(80), default="")
    error_message: Mapped[str] = mapped_column(Text, default="")
    idempotency_key: Mapped[str] = mapped_column(String(160))
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=now)
    started_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)


class Image(Base):
    """图片的物理属性。业务归属在 image_assets；status 支持归档而不物理删除。"""
    __tablename__ = "images"
    __table_args__ = (Index("ix_images_sha256", "sha256"),
                      Index("ix_images_status", "status"))

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    job_id: Mapped[int | None] = mapped_column(ForeignKey("generation_jobs.id"), nullable=True)
    origin: Mapped[str] = mapped_column(String(24), default="generated")
    status: Mapped[str] = mapped_column(String(16), default="active")
    file_path: Mapped[str] = mapped_column(Text)
    thumb_path: Mapped[str] = mapped_column(Text, default="")
    width: Mapped[int] = mapped_column(Integer, default=0)
    height: Mapped[int] = mapped_column(Integer, default=0)
    file_size: Mapped[int] = mapped_column(Integer, default=0)
    sha256: Mapped[str] = mapped_column(String(64), default="")
    rating: Mapped[int] = mapped_column(Integer, default=0)
    favorite: Mapped[bool] = mapped_column(Boolean, default=False)
    note: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=now)


class ImageAsset(Base):
    """图片的业务元数据，取代 v1 的 images.meta_json。"""
    __tablename__ = "image_assets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    image_id: Mapped[int] = mapped_column(
        ForeignKey("images.id", ondelete="CASCADE"), unique=True, index=True)
    job_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    draw_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    session_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    prompt: Mapped[str] = mapped_column(Text, default="")
    seed: Mapped[int | None] = mapped_column(Integer, nullable=True)
    comfy_prompt_id: Mapped[str] = mapped_column(String(120), default="")
    source: Mapped[str] = mapped_column(Text, default="")
    name: Mapped[str] = mapped_column(Text, default="")


class Concept(Base):
    """概念物化表：由 draw_slots / draw_profiles 等关系表增量维护，随时可重建。"""
    __tablename__ = "concepts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    key: Mapped[str] = mapped_column(String(180), unique=True, index=True)
    label: Mapped[str] = mapped_column(Text, default="")
    kind: Mapped[str] = mapped_column(String(40), default="概念", index=True)
    pool: Mapped[str] = mapped_column(String(160), default="", index=True)
    filterable: Mapped[bool] = mapped_column(Boolean, default=True)
    cover_image_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    image_count: Mapped[int] = mapped_column(Integer, default=0)
    draw_count: Mapped[int] = mapped_column(Integer, default=0)
    first_seen_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)
    last_seen_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)


class ConceptImage(Base):
    """概念 ↔ 真实出图，带排序分：评分 / 收藏 / 新鲜度决定谁当封面。"""
    __tablename__ = "concept_images"
    __table_args__ = (
        UniqueConstraint("concept_id", "image_id", name="uq_concept_image"),
        Index("ix_concept_images_score", "concept_id", "score"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    concept_id: Mapped[int] = mapped_column(ForeignKey("concepts.id", ondelete="CASCADE"),
                                            index=True)
    image_id: Mapped[int] = mapped_column(ForeignKey("images.id", ondelete="CASCADE"),
                                          index=True)
    draw_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    score: Mapped[float] = mapped_column(Float, default=0.0)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=now)


class ImportBatch(Base):
    __tablename__ = "import_batches"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    source_path: Mapped[str] = mapped_column(Text)
    kind: Mapped[str] = mapped_column(String(40))
    pool_slug: Mapped[str] = mapped_column(String(160), default="")
    item_count: Mapped[int] = mapped_column(Integer, default=0)
    checksum: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=now)


class EventLog(Base):
    __tablename__ = "event_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    request_id: Mapped[str] = mapped_column(String(40), default="-")
    level: Mapped[str] = mapped_column(String(16), default="INFO")
    feature: Mapped[str] = mapped_column(String(40), default="app")
    message_json: Mapped[str] = mapped_column(Text, default="{}")
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=now)
