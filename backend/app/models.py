# -*- coding: utf-8 -*-
"""全部 ORM 表。表结构变更一律走 backend/migrations 里的 Alembic 版本。"""
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
    __tablename__ = "draw_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    recipe_id: Mapped[int | None] = mapped_column(ForeignKey("recipes.id"), nullable=True)
    recipe_snapshot_json: Mapped[str] = mapped_column(Text, default="{}")
    profile_snapshot_json: Mapped[str] = mapped_column(Text, default="{}")
    seed: Mapped[int | None] = mapped_column(Integer, nullable=True)
    pulls: Mapped[int] = mapped_column(Integer, default=1)
    count: Mapped[int] = mapped_column(Integer, default=1)
    workflow_version: Mapped[str] = mapped_column(String(80), default="sdxl_minimal")
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=now)


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
    detail_json: Mapped[str] = mapped_column(Text, default="[]")


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
    __tablename__ = "images"
    __table_args__ = (Index("ix_images_sha256", "sha256"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    job_id: Mapped[int | None] = mapped_column(ForeignKey("generation_jobs.id"), nullable=True)
    origin: Mapped[str] = mapped_column(String(24), default="generated")
    file_path: Mapped[str] = mapped_column(Text)
    thumb_path: Mapped[str] = mapped_column(Text, default="")
    width: Mapped[int] = mapped_column(Integer, default=0)
    height: Mapped[int] = mapped_column(Integer, default=0)
    file_size: Mapped[int] = mapped_column(Integer, default=0)
    sha256: Mapped[str] = mapped_column(String(64), default="")
    meta_json: Mapped[str] = mapped_column(Text, default="{}")
    rating: Mapped[int] = mapped_column(Integer, default=0)
    favorite: Mapped[bool] = mapped_column(Boolean, default=False)
    note: Mapped[str] = mapped_column(Text, default="")
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
