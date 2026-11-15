# -*- coding: utf-8 -*-
"""把本机已有的 ONNX 推理依赖搬进项目 vendor/pydeps（全程零联网、零 pip）。

背景：语义抽卡的编码器只用 onnxruntime + tokenizers + numpy。这三个包本机
「艺术家智能选择」项目的 .venv 里早就装好了，Python 同为 3.13 / cp313，
二进制可直接复用；不需要也不应该重新下载。

用法：
    python scripts/vendor_deps.py                # 搬运（已存在则跳过）
    python scripts/vendor_deps.py --force        # 覆盖重搬
    python scripts/vendor_deps.py --if-missing   # 仅供 start.bat 调用

源目录可用环境变量 GACHA_DEPS_SOURCE 指定（指向某个 site-packages）。
"""
from __future__ import annotations

import argparse
import os
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TARGET = ROOT / "vendor" / "pydeps"
PACKAGES = ("onnxruntime", "tokenizers")

# 本机已有的 site-packages，按优先级探测；全部离线，不触发任何下载
DEFAULT_SOURCES = (
    Path("X:/game/noobaiStyleCollection_v12/艺术家智能选择/.venv/Lib/site-packages"),
    Path.home() / ".workbuddy" / "binaries" / "python" / "versions" / "3.13.12" / "Lib" / "site-packages",
)


def _sources() -> list[Path]:
    raw = os.environ.get("GACHA_DEPS_SOURCE", "").strip()
    if raw:
        p = Path(raw)
        return [p if p.is_absolute() else (ROOT / p)]
    return [p for p in DEFAULT_SOURCES if p.is_dir()]


def _pkg_dirs(src: Path) -> list[Path]:
    """找出包目录 + 对应 dist-info（便于版本识别与卸载）。"""
    out: list[Path] = []
    for name in PACKAGES:
        d = src / name
        if not (d / "__init__.py").is_file():
            return []
        out.append(d)
        # 只搬最新的一份 dist-info（源环境可能残留旧版元数据）
        metas = sorted(p for p in src.glob(f"{name}-*.dist-info") if p.is_dir())
        if metas:
            out.append(metas[-1])
    return out


def is_ready() -> bool:
    return all((TARGET / name / "__init__.py").is_file() for name in PACKAGES)


def vendor(force: bool = False) -> dict:
    if is_ready() and not force:
        return {"ok": True, "skipped": True, "target": str(TARGET),
                "reason": "vendor/pydeps 已就绪"}
    for src in _sources():
        dirs = _pkg_dirs(src)
        if not dirs:
            continue
        TARGET.mkdir(parents=True, exist_ok=True)
        if force:
            for name in PACKAGES:
                old = TARGET / name
                if old.is_dir():
                    shutil.rmtree(old)
            for meta in TARGET.glob("*-*.dist-info"):
                if meta.is_dir():
                    shutil.rmtree(meta)
        for d in dirs:
            shutil.copytree(d, TARGET / d.name, dirs_exist_ok=True)
        return {"ok": True, "skipped": False, "source": str(src),
                "target": str(TARGET),
                "packages": [d.name for d in dirs],
                "onnxruntime": _version(TARGET / "onnxruntime"),
                "tokenizers": _version(TARGET / "tokenizers")}
    return {"ok": False, "target": str(TARGET),
            "searched": [str(p) for p in _sources()],
            "reason": "本机未找到现成的 onnxruntime/tokenizers；"
                      "可用 GACHA_DEPS_SOURCE 指向已装的 site-packages。"
                      "（不会自动联网下载，语义面板会降级，抽卡主流程不受影响）"}


def _version(pkg: Path) -> str:
    f = pkg / "__init__.py"
    if not f.is_file():
        return "?"
    for line in f.read_text(encoding="utf-8", errors="ignore").splitlines():
        if "__version__" in line and "=" in line:
            return line.split("=", 1)[1].strip().strip("'\"")
    return "unknown"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="覆盖重搬")
    ap.add_argument("--if-missing", action="store_true",
                    help="已就绪则静默跳过（供 start.bat 使用）")
    args = ap.parse_args()
    if args.if_missing and is_ready():
        return 0
    r = vendor(force=args.force)
    if not r["ok"]:
        print("[vendor-deps] WARN " + r["reason"], file=sys.stderr)
        return 0  # 语义功能可降级，绝不阻断启动
    if r.get("skipped"):
        print("[vendor-deps] 已就绪，跳过：" + r["target"])
    else:
        print("[vendor-deps] 从本机搬入（零下载）：" + r["source"])
        print("[vendor-deps] -> " + r["target"])
        print("[vendor-deps] 包：" + ", ".join(r["packages"]))
        print("[vendor-deps] 版本：onnxruntime=%s tokenizers=%s"
              % (r["onnxruntime"], r["tokenizers"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
