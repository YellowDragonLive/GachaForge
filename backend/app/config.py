# -*- coding: utf-8 -*-
"""集中配置：全部来自环境变量 / .env，启动时校验、快速失败。

不引入 python-dotenv，自己读 .env，保持依赖最小。
"""
from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def load_dotenv(path: Path | None = None) -> None:
    """把 .env 读入环境变量，已存在的环境变量优先（不覆盖）。"""
    p = path or (ROOT / ".env")
    if not p.is_file():
        return
    for line in p.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, val = line.split("=", 1)
        os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))


def _as_bool(value: str | None, default: bool = False) -> bool:
    if value is None or value == "":
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")


def _as_path(value: str | None, default: str) -> Path:
    p = Path(value or default)
    return p if p.is_absolute() else (ROOT / p)


@dataclass(frozen=True)
class Settings:
    root: Path
    host: str
    port: int
    log_level: str
    comfy_url: str
    comfy_mock: bool
    comfy_timeout: int
    db_path: Path
    outputs_dir: Path
    thumbs_dir: Path
    workflow_dir: Path
    wildcards_dir: Path
    frontend_dir: Path
    token: str
    worker_poll: float

    @property
    def db_url(self) -> str:
        return f"sqlite:///{self.db_path.as_posix()}"

    def validate(self) -> None:
        """启动时集中校验；目录自动创建，关键资源缺失直接报错。"""
        for d in (self.db_path.parent, self.outputs_dir, self.thumbs_dir):
            d.mkdir(parents=True, exist_ok=True)
        if not self.workflow_dir.is_dir():
            raise RuntimeError(f"workflow 模板目录不存在: {self.workflow_dir}")
        if not list(self.workflow_dir.glob("*.json")):
            raise RuntimeError(f"workflow 模板目录里没有 .json: {self.workflow_dir}")
        if not self.frontend_dir.is_dir():
            raise RuntimeError(f"前端目录不存在: {self.frontend_dir}")
        if not (self.frontend_dir / "index.html").is_file():
            raise RuntimeError(f"前端缺少 index.html: {self.frontend_dir}")
        if not self.comfy_url.startswith(("http://", "https://")):
            raise RuntimeError(f"GACHA_COMFY_URL 不是合法地址: {self.comfy_url}")
        if not self.comfy_mock and self.comfy_timeout < 10:
            raise RuntimeError("GACHA_COMFY_TIMEOUT 太小，至少 10 秒")
        if not self.wildcards_dir.is_dir():
            print(f"[config] WARN 词卡目录不存在，词卡池将为空: {self.wildcards_dir}",
                  file=sys.stderr)

    def public(self) -> dict:
        return {
            "host": self.host,
            "port": self.port,
            "comfy_url": self.comfy_url,
            "comfy_mock": self.comfy_mock,
            "comfy_timeout": self.comfy_timeout,
            "db_path": str(self.db_path),
            "outputs_dir": str(self.outputs_dir),
            "thumbs_dir": str(self.thumbs_dir),
            "workflow_dir": str(self.workflow_dir),
            "wildcards_dir": str(self.wildcards_dir),
            "wildcards_ready": self.wildcards_dir.is_dir(),
            "workflows": sorted(p.name for p in self.workflow_dir.glob("*.json")),
            "auth_required": bool(self.token),
        }


_settings: Settings | None = None


def get_settings() -> Settings:
    global _settings
    if _settings is None:
        load_dotenv()
        _settings = Settings(
            root=ROOT,
            host=os.environ.get("GACHA_HOST", "127.0.0.1"),
            port=int(os.environ.get("GACHA_PORT", "8765")),
            log_level=os.environ.get("GACHA_LOG_LEVEL", "INFO").upper(),
            comfy_url=os.environ.get("GACHA_COMFY_URL", "http://127.0.0.1:8188").rstrip("/"),
            comfy_mock=_as_bool(os.environ.get("GACHA_COMFY_MOCK"), False),
            comfy_timeout=int(os.environ.get("GACHA_COMFY_TIMEOUT", "900")),
            db_path=_as_path(os.environ.get("GACHA_DB_PATH"), "data/gacha.db"),
            outputs_dir=_as_path(os.environ.get("GACHA_OUTPUTS_DIR"), "data/outputs"),
            thumbs_dir=_as_path(os.environ.get("GACHA_THUMBS_DIR"), "data/thumbs"),
            workflow_dir=_as_path(os.environ.get("GACHA_WORKFLOW_DIR"), "backend/workflows"),
            wildcards_dir=_as_path(
                os.environ.get("GACHA_WILDCARDS_DIR"),
                "vendor/stable-diffusion-webui-wildcards/wildcards"),
            frontend_dir=ROOT / "frontend",
            token=os.environ.get("GACHA_TOKEN", "").strip(),
            worker_poll=float(os.environ.get("GACHA_WORKER_POLL", "0.4")),
        )
    return _settings
