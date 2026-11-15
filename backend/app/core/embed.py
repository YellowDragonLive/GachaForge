# -*- coding: utf-8 -*-
"""本地 ONNX 文本编码器：构建期与运行期共用，保证索引向量与查询向量同空间。

与 ChromaDB 默认嵌入 all-MiniLM-L6-v2 完全一致的 mean pooling + L2 归一化，
但只依赖 onnxruntime / tokenizers / numpy，不引入 chromadb 全家桶。
模型与推理包都由本机已有文件「剪切/搬入」项目（scripts/vendor_deps.py、
scripts/build_semantics.py），全程零联网、零 pip 下载。
"""
from __future__ import annotations

import os
import sys
from functools import lru_cache
from pathlib import Path

import numpy as np

from ..config import ROOT

DIM = 384
MAX_TOKENS = 256
DEFAULT_MODEL_DIR = ROOT / "data" / "models" / "minilm"
CACHE_MODEL_DIR = (Path.home() / ".cache" / "chroma" / "onnx_models"
                   / "all-MiniLM-L6-v2" / "onnx")


class EmbedUnavailable(RuntimeError):
    """编码器依赖或模型缺失；调用方应降级而不是让整个服务不可用。"""


@lru_cache(maxsize=1)
def _vendor_on_path() -> bool:
    """让随项目携带的 vendor/pydeps 优先于系统 site-packages。

    start.bat 已设 PYTHONPATH；这里再兜一层，保证单跑脚本 / 冒烟测试
    也能直接用本机搬来的依赖，不需要重新 pip 安装。
    """
    d = ROOT / "vendor" / "pydeps"
    if not (d / "onnxruntime").is_dir():
        return False
    p = str(d)
    if p not in sys.path:
        sys.path.insert(0, p)
    return True


def model_dir() -> Path:
    raw = os.environ.get("GACHA_EMBED_MODEL_DIR", "").strip()
    p = Path(raw) if raw else DEFAULT_MODEL_DIR
    return p if p.is_absolute() else (ROOT / p)


def cache_model_dir() -> Path:
    raw = os.environ.get("GACHA_EMBED_CACHE_DIR", "").strip()
    return Path(raw) if raw else CACHE_MODEL_DIR


def is_ready() -> bool:
    d = model_dir()
    return all((d / name).is_file()
               for name in ("model.onnx", "tokenizer.json"))


@lru_cache(maxsize=1)
def _session():
    if not is_ready():
        raise EmbedUnavailable(
            f"本地嵌入模型未就绪：{model_dir()}，请运行 python scripts/build_semantics.py")
    _vendor_on_path()
    try:
        import onnxruntime as ort
        from tokenizers import Tokenizer
    except ImportError as exc:
        raise EmbedUnavailable(
            f"缺少本地推理依赖 onnxruntime/tokenizers：{exc}；"
            "执行 python scripts/vendor_deps.py 从本机已有环境搬入（不联网）") from exc
    d = model_dir()
    tok = Tokenizer.from_file(str(d / "tokenizer.json"))
    # 与 ChromaDB ONNXMiniLM_L6_V2 保持一致：256 固定长度
    tok.enable_truncation(max_length=MAX_TOKENS)
    tok.enable_padding(pad_id=0, pad_token="[PAD]", length=MAX_TOKENS)
    opts = ort.SessionOptions()
    opts.log_severity_level = 3
    sess = ort.InferenceSession(str(d / "model.onnx"), opts,
                                providers=["CPUExecutionProvider"])
    return tok, sess


def encode(texts: list[str]) -> np.ndarray:
    """返回 (n, 384) 的 L2 归一化 float32 向量；纯 CPU、纯本地。"""
    if not texts:
        return np.zeros((0, DIM), dtype=np.float32)
    tok, sess = _session()
    encoded = [tok.encode(str(t or "")) for t in texts]
    ids = np.array([e.ids for e in encoded], dtype=np.int64)
    mask = np.array([e.attention_mask for e in encoded], dtype=np.int64)
    hidden = sess.run(None, {
        "input_ids": ids,
        "attention_mask": mask,
        "token_type_ids": np.zeros_like(ids),
    })[0]
    expanded = np.broadcast_to(np.expand_dims(mask, -1), hidden.shape)
    vec = np.sum(hidden * expanded, axis=1) / np.clip(
        expanded.sum(axis=1), a_min=1e-9, a_max=None)
    norm = np.linalg.norm(vec, axis=1)
    norm[norm == 0] = 1e-12
    return (vec / norm[:, np.newaxis]).astype(np.float32)


def prepare_model(force: bool = False) -> Path:
    """把本机 Chroma 缓存里的 ONNX 权重「剪切」进项目：不下载、不留两份。

    权重本机早就存在（`~/.cache/chroma/.../onnx.tar.gz` 解出来的那份），
    所以直接搬进来即可；搬空后若缓存目录被清理，可从同目录 tar.gz 本地解包，
    仍然全程离线。
    """
    d = model_dir()
    if is_ready() and not force:
        return d
    src = cache_model_dir()
    names = ("model.onnx", "tokenizer.json", "tokenizer_config.json",
             "special_tokens_map.json", "config.json", "vocab.txt")
    if not (src / "model.onnx").is_file():
        tar = src.parent / "onnx.tar.gz"
        if tar.is_file():
            import tarfile
            with tarfile.open(tar, "r:gz") as tf:
                tf.extractall(src.parent, filter="data")
        if not (src / "model.onnx").is_file():
            raise EmbedUnavailable(
                f"本机找不到 all-MiniLM-L6-v2 ONNX 权重：{src}；"
                "可用 GACHA_EMBED_CACHE_DIR 指向已解压目录，"
                "或 GACHA_EMBED_MODEL_DIR 直接指向项目里已有的一份（不联网）")
    d.mkdir(parents=True, exist_ok=True)
    import shutil
    for name in names:
        s = src / name
        if not s.is_file():
            continue
        t = d / name
        if t.is_file() and t.stat().st_size == s.stat().st_size:
            s.unlink()          # 项目内已有同尺寸文件：视为已搬入，移除缓存副本
        else:
            shutil.move(str(s), str(t))
    _session.cache_clear()
    return d
