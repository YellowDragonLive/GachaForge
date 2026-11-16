# -*- coding: utf-8 -*-
"""下载提示词中英对照词表（一次性、可重复执行）。

数据源：Aleiluo/comfyui-danbooru-translate-cn 的 danbooru-cn.json（MIT）
  33071 条 {英文tag: 中文}，纯本地字典，供意群自由输入做双语补全。
  不装 ComfyUI 节点、不调在线翻译 API、不要 key —— 符合本项目本地优先约定。

产物：data/vocab/danbooru-cn.json（不进 git，可重建）

用法：
  python scripts/fetch_vocab.py              # 已存在则跳过
  python scripts/fetch_vocab.py --force      # 强制重下
  python scripts/fetch_vocab.py --min 30000  # 改最低条目数校验

下载通道说明（踩过的坑，别再现场试）：
  本机走内网代理（HTTP(S)_PROXY），raw.githubusercontent.com 与 cdn.jsdelivr.net
  在该代理下握手失败（schannel / unexpected EOF）。实测可用的通道是 ghproxy 前缀。
  脚本按候选顺序试，拿到内容先做 JSON 解析 + 条目数校验再落盘，
  绝不能把代理的错误页当词表存进去（那样补全会静默全空，最难排查）。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "vocab" / "danbooru-cn.json"

SOURCES = [
    "https://ghproxy.net/https://raw.githubusercontent.com/"
    "Aleiluo/comfyui-danbooru-translate-cn/main/danbooru-cn.json",
    "https://raw.githubusercontent.com/Aleiluo/"
    "comfyui-danbooru-translate-cn/main/danbooru-cn.json",
    "https://cdn.jsdelivr.net/gh/Aleiluo/"
    "comfyui-danbooru-translate-cn@main/danbooru-cn.json",
]


def load_json(data: bytes):
    """解析并做基本形状校验：必须是 dict[str, str] 且非空。"""
    obj = json.loads(data.decode("utf-8-sig"))
    if not isinstance(obj, dict) or not obj:
        raise ValueError("词表不是非空 JSON 对象")
    bad = [k for k, v in list(obj.items())[:50] if not isinstance(v, str)]
    if bad:
        raise ValueError(f"词表值不是字符串，例如 {bad[:3]}")
    return obj


def fetch(min_items: int, force: bool) -> int:
    import httpx

    if OUT.is_file() and not force:
        try:
            obj = load_json(OUT.read_bytes())
            print(f"[vocab] 已存在：{OUT}（{len(obj)} 条），跳过；--force 强制重下")
            return 0
        except Exception as exc:
            print(f"[vocab] 现有文件损坏（{exc}），重新下载")

    last = ""
    for url in SOURCES:
        try:
            # verify=False：本机内网代理做了 MITM，证书链不含代理根证书。
            # 只用于这几个固定白名单 URL，不接受用户输入地址。
            with httpx.Client(verify=False, timeout=60, follow_redirects=True) as c:
                r = c.get(url)
            if r.status_code != 200:
                last = f"HTTP {r.status_code}"
                continue
            obj = load_json(r.content)
            if len(obj) < min_items:
                last = f"条目数 {len(obj)} < {min_items}，疑似错误页"
                continue
            OUT.parent.mkdir(parents=True, exist_ok=True)
            OUT.write_bytes(r.content)
            print(f"[vocab] 已下载 {len(obj)} 条 → {OUT}（{len(r.content)/1048576:.2f} MB）")
            print(f"[vocab] 来源：{url}")
            return 0
        except Exception as exc:
            last = f"{type(exc).__name__}: {str(exc)[:100]}"
            continue
    print(f"[vocab] 全部通道失败，最后错误：{last}")
    return 2


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="下载提示词中英对照词表")
    ap.add_argument("--force", action="store_true", help="已存在也强制重下")
    ap.add_argument("--min", type=int, default=30000, help="最低条目数校验，默认 30000")
    args = ap.parse_args()
    return fetch(args.min, args.force)


if __name__ == "__main__":
    sys.exit(main())
