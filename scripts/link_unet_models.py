# -*- coding: utf-8 -*-
"""把 checkpoints/ 里「纯 UNet」的权重链接进 diffusion_models/。

背景
----
Civitai 的底模默认下载到 ``ComfyUI/models/checkpoints/``，但 Anima / Mochi / Flux
这类「只有 UNet、没有 VAE 和文本编码器」的权重必须由 ``UNETLoader`` 加载，而
``UNETLoader`` 只枚举 ``models/unet`` 和 ``models/diffusion_models``（见
ComfyUI 的 ``folder_paths.py``）。于是两份目录之间需要一座桥。

用硬链接而不是复制：同一份数据、不占第二份空间、删掉一边另一边仍在。
（``CheckpointLoaderSimple`` 加载这种文件会报「Could not detect model type」，
因为它要找 ``first_stage_model`` / ``cond_stage_model``。）

判据按**内容**而不是文件名：读 safetensors 头部（只有几 KB），
有 ``model.diffusion_model.*`` 或 ``diffusion_model.*``，且不含
``first_stage_model`` / ``cond_stage_model`` / ``vae.`` / ``text_encoders.``
才算纯 UNet。以后下任何 diffusion model 到 checkpoints 都会被自动带过去。

用法
----
    python scripts/link_unet_models.py             # 建链接（幂等，可反复跑）
    python scripts/link_unet_models.py --dry-run   # 只看会做什么
    python scripts/link_unet_models.py --models-dir <ComfyUI/models>
"""
from __future__ import annotations

import argparse
import json
import os
import struct
import sys
from pathlib import Path

DEFAULT_COMFY_DIR = Path(r"X:\ai_tool\ComfyUI_windows_portable_nvidia\ComfyUI_windows_portable")

# 纯 UNet 不该有的前缀（有任何一个就说明是完整 checkpoint，CheckpointLoaderSimple 能直接吃）
FULL_CHECKPOINT_PREFIXES = ("first_stage_model", "cond_stage_model", "vae.", "text_encoders.")
UNET_PREFIXES = ("model.diffusion_model.", "diffusion_model.")


def _models_dir(explicit: str | None) -> Path:
    if explicit:
        return Path(explicit)
    env = os.environ.get("GACHA_COMFY_MODELS")
    if env:
        return Path(env)
    comfy = os.environ.get("GACHA_COMFY_DIR") or str(DEFAULT_COMFY_DIR)
    return Path(comfy) / "ComfyUI" / "models"


def header_keys(path: Path, limit_bytes: int = 8 * 1024 * 1024) -> list[str]:
    """只读 safetensors 头部，拿张量名列表；不做任何权重加载。"""
    with path.open("rb") as f:
        raw = f.read(8)
        if len(raw) < 8:
            return []
        (n,) = struct.unpack("<Q", raw)
        if n <= 0 or n > limit_bytes:
            return []
        head = json.loads(f.read(n))
    return [k for k in head if k != "__metadata__"]


def classify(path: Path) -> str:
    """返回 'unet' / 'full' / 'unknown'。"""
    try:
        keys = header_keys(path)
    except Exception as exc:  # 损坏文件、非 safetensors、权限问题
        print(f"  [skip] {path.name}: 读头部失败 ({exc.__class__.__name__})")
        return "unknown"
    if not keys:
        return "unknown"
    if any(k.startswith(FULL_CHECKPOINT_PREFIXES) for k in keys):
        return "full"
    if any(k.startswith(UNET_PREFIXES) for k in keys):
        return "unet"
    return "unknown"


def link_into(src: Path, dst_dir: Path, dry_run: bool) -> str:
    """建硬链接；返回 created / exists / cross_volume / failed。"""
    dst = dst_dir / src.name
    if dst.exists():
        return "exists"
    if dry_run:
        return "created"
    try:
        os.link(src, dst)          # 同卷硬链接，秒级、零额外空间
        return "created"
    except OSError as exc:
        # EXDEV = 跨卷；Windows 上跨卷会报 winerror 17
        if getattr(exc, "errno", None) == 18 or getattr(exc, "winerror", None) == 17:
            return "cross_volume"
        print(f"  [fail] {src.name}: {exc}")
        return "failed"


def main() -> int:
    ap = argparse.ArgumentParser(description="把 checkpoints/ 里的纯 UNet 权重硬链接进 diffusion_models/")
    ap.add_argument("--models-dir", help="ComfyUI/models 目录；默认从 GACHA_COMFY_DIR 推导")
    ap.add_argument("--dry-run", action="store_true", help="只打印，不改动")
    ap.add_argument("--quiet", action="store_true", help="什么都没做时不输出（给 start.bat 用）")
    args = ap.parse_args()

    models = _models_dir(args.models_dir)
    ckpt_dir = models / "checkpoints"
    unet_dir = models / "diffusion_models"
    if not ckpt_dir.is_dir():
        if not args.quiet:
            print(f"[link] 跳过：{ckpt_dir} 不存在（ComfyUI 装在别处？用 --models-dir 指定）")
        return 0
    unet_dir.mkdir(parents=True, exist_ok=True)

    stats = {"created": 0, "exists": 0, "cross_volume": 0, "failed": 0}
    changed: list[str] = []
    for src in sorted(ckpt_dir.rglob("*.safetensors")):
        kind = classify(src)
        if kind != "unet":
            continue
        res = link_into(src, unet_dir, args.dry_run)
        stats[res] += 1
        if res == "created":
            changed.append(src.name)
        elif res == "cross_volume":
            print(f"  [跨卷] {src.name}: 硬链接要求同盘，请手动复制到 {unet_dir}")

    if changed:
        verb = "将建立" if args.dry_run else "已建立"
        print(f"[link] {verb} {len(changed)} 条硬链接 -> {unet_dir}")
        for name in changed:
            print(f"  + {name}")
    elif not args.quiet:
        print(f"[link] 无需处理（checkpoints 里没有待链接的纯 UNet；已有 {stats['exists']} 条）")

    if stats["cross_volume"] or stats["failed"]:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
