# -*- coding: utf-8 -*-
"""Alembic 环境：使用 backend.app.db.Base 的 metadata 作为迁移目标。"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from alembic import context
from sqlalchemy import engine_from_config, pool

from backend.app import models  # noqa: F401  注册所有表
from backend.app.db import Base

config = context.config
target_metadata = Base.metadata


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.", poolclass=pool.NullPool)
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata,
                          compare_type=True, render_as_batch=True)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    raise RuntimeError("本项目只使用在线迁移（scripts/init_db.py）")
run_migrations_online()
