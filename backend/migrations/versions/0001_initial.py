# -*- coding: utf-8 -*-
"""v2 关系模型基线：全部表结构以 ORM metadata 为唯一定义，避免手写 DDL 漂移。

revision: 0001_v2_relational

这是「方案 C 彻底规范化」重做的基线：旧库只做只读归档，不提供从
0001_initial 升级的路径。需要清空重建时跑 scripts/reset_db.py。
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from alembic import op

from backend.app import models  # noqa: F401
from backend.app.db import Base

revision = "0001_v2_relational"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    Base.metadata.create_all(bind=op.get_bind())


def downgrade() -> None:
    Base.metadata.drop_all(bind=op.get_bind())
