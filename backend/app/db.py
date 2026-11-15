# -*- coding: utf-8 -*-
"""SQLAlchemy engine / session / Base。SQLite 开启 WAL 与外键。"""
from __future__ import annotations

from collections.abc import Generator

from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import get_settings


class Base(DeclarativeBase):
    pass


_settings = get_settings()
engine = create_engine(
    _settings.db_url,
    connect_args={"check_same_thread": False},
    pool_pre_ping=True,
    future=True,
)


@event.listens_for(engine, "connect")
def _sqlite_pragmas(dbapi_conn, _record):
    cur = dbapi_conn.cursor()
    cur.execute("PRAGMA journal_mode=WAL")
    cur.execute("PRAGMA foreign_keys=ON")
    cur.execute("PRAGMA busy_timeout=5000")
    cur.close()


SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False,
                            class_=Session)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    """由 Alembic 迁移建表；这里只做兜底（开发期直接跑也安全）。"""
    from . import models  # noqa: F401  确保模型注册到 metadata
    Base.metadata.create_all(bind=engine)
