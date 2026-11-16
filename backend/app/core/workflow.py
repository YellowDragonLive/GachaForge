# -*- coding: utf-8 -*-
"""Workflow 规格：把「节点角色 / 参数来源 / LoRA 注入 / 结果解析」从 Python 代码搬到数据文件。

设计要点：
- 一份 `<id>.json`（ComfyUI API 格式节点图）+ 一份可选的 `<id>.spec.json`（本模块的描述）。
- 没有 spec 的老 workflow 按 SDXL 兼容模式处理——老预设无需改一个字。
- 本模块纯逻辑、不碰 HTTP/DB：`core` 层可独立单测。

spec 字段见 docs/架构_模块化与多模型.md §4。
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..errors import NotFoundError

# 没有 spec 时使用的 SDXL 兼容描述：等价于历史上的硬编码行为。
LEGACY_SPEC: dict[str, Any] = {
    "id": "sdxl_minimal",
    "label": "SDXL（兼容模式）",
    "params": {
        "CKPT": {"source": "profile", "key": "checkpoint"},
        "PROMPT": {"source": "prompt"},
        "NEGATIVE": {"source": "negative"},
        "SEED": {"source": "seed"},
        "WIDTH": {"source": "profile", "key": "width", "default": 1024},
        "HEIGHT": {"source": "profile", "key": "height", "default": 1360},
        "STEPS": {"source": "profile", "key": "steps", "default": 20},
        "CFG": {"source": "profile", "key": "cfg", "default": 6.0},
        "SAMPLER": {"source": "profile", "key": "sampler", "default": "euler_ancestral"},
        "SCHEDULER": {"source": "profile", "key": "scheduler", "default": "normal"},
        "MODEL_SRC": {"source": "lora_chain", "slot": "model", "default": "1"},
        "CLIP_SRC": {"source": "lora_chain", "slot": "clip", "default": "1"},
        "PREFIX": {"source": "prefix"},
    },
    "lora": {
        "class_type": "LoraLoader",
        "node_prefix": 100,
        "name_input": "lora_name",
        "model_input": "model", "model_slot": 0,
        "clip_input": "clip", "clip_slot": 1,
        "weight_model": "strength_model", "weight_clip": "strength_clip",
    },
    "result_nodes": [],  # 空 = 兼容旧行为，扫所有节点的 images[]
    "capabilities": ["lora", "negative"],
}


@dataclass(frozen=True)
class WorkflowSpec:
    """一份 workflow 的声明式描述。纯值对象。"""
    id: str
    label: str
    template: str
    params: dict[str, dict[str, Any]]
    lora: dict[str, Any] | None
    result_nodes: tuple[str, ...] = ()
    capabilities: tuple[str, ...] = ()
    legacy: bool = False

    def resolve_params(self, *, profile: dict, prompt: str, negative: str,
                       seed: int, prefix: str, model_src: str, clip_src: str) -> dict[str, Any]:
        """按 spec 声明把上下文解析成占位符字典；未知 source 直接报错（防呆）。"""
        ctx: dict[str, Any] = {
            "prompt": prompt, "negative": negative, "seed": int(seed),
            "prefix": prefix,
            "profile": profile or {},
            "lora_chain": {"model": model_src, "clip": clip_src},
        }
        out: dict[str, Any] = {}
        for key, rule in self.params.items():
            src = rule.get("source")
            if src == "const":
                out[key] = rule.get("value")
            elif src in ("prompt", "negative", "seed", "prefix"):
                out[key] = ctx[src]
            elif src == "profile":
                val = ctx["profile"].get(rule.get("key", ""))
                out[key] = val if val not in (None, "") else rule.get("default", "")
            elif src == "lora_chain":
                out[key] = ctx["lora_chain"].get(rule.get("slot", ""), rule.get("default", ""))
            else:
                raise ValueError(f"workflow spec {self.id}: 占位符 {key} 的来源未知: {src!r}")
        return out

    def lora_node(self, node_id: str, name: str, weight: float,
                  model_src: str, clip_src: str) -> dict[str, Any] | None:
        """生成一条 LoRA 节点；spec 声明不支持 LoRA 时返回 None。"""
        r = self.lora
        if not r or not name:
            return None
        inputs = {
            r["name_input"]: name,
            r["weight_model"]: weight,
            r["model_input"]: [model_src, r.get("model_slot", 0)],
        }
        if r.get("weight_clip"):
            inputs[r["weight_clip"]] = weight
        if r.get("clip_input"):
            inputs[r["clip_input"]] = [clip_src, r.get("clip_slot", 1)]
        return {"class_type": r["class_type"], "inputs": inputs}


def _normalize(data: dict[str, Any], *, template: str) -> WorkflowSpec:
    """校验 spec 最小结构并补默认值。坏 spec 宁可报错，不静默走错分支。"""
    params = data.get("params")
    if not isinstance(params, dict) or not params:
        raise ValueError(f"{template}.spec.json: 缺少 params")
    for key, rule in params.items():
        if not isinstance(rule, dict) or rule.get("source") not in (
                "prompt", "negative", "seed", "prefix", "profile", "lora_chain", "const"):
            raise ValueError(f"{template}.spec.json: 占位符 {key} 的 source 非法: {rule!r}")
    lora = data.get("lora")
    if lora is not None and (not isinstance(lora, dict) or not lora.get("class_type")):
        raise ValueError(f"{template}.spec.json: lora 策略缺 class_type")
    return WorkflowSpec(
        id=str(data.get("id") or Path(template).stem),
        label=str(data.get("label") or Path(template).stem),
        template=template,
        params=params,
        lora=lora,
        result_nodes=tuple(str(x) for x in data.get("result_nodes") or []),
        capabilities=tuple(str(x) for x in data.get("capabilities") or []),
        legacy=False,
    )


class WorkflowRegistry:
    """工作流目录注册表：枚举 + 按文件名加载 spec。懒加载，文件改动即时可见。"""

    def __init__(self, directory: Path):
        self.dir = Path(directory)

    def templates(self) -> list[str]:
        if not self.dir.is_dir():
            return []
        return sorted(p.name for p in self.dir.glob("*.json")
                      if not p.name.endswith(".spec.json"))

    def load(self, name: str) -> WorkflowSpec:
        if not name or Path(name).name != name or not name.endswith(".json"):
            raise NotFoundError(f"非法 workflow 名: {name!r}")
        path = self.dir / name
        if not path.is_file() or name.endswith(".spec.json"):
            raise NotFoundError(f"workflow 模板不存在: {name}")
        spec_path = self.dir / (Path(name).stem + ".spec.json")
        if spec_path.is_file():
            data = json.loads(spec_path.read_text(encoding="utf-8"))
            try:
                return _normalize(data, template=name)
            except ValueError as exc:
                raise ValueError(f"workflow spec 损坏（{spec_path.name}）: {exc}") from exc
        return WorkflowSpec(
            id=Path(name).stem, label=Path(name).stem, template=name,
            params=dict(LEGACY_SPEC["params"]),
            lora=dict(LEGACY_SPEC["lora"]) if LEGACY_SPEC["lora"] else None,
            capabilities=tuple(LEGACY_SPEC["capabilities"]),
            legacy=True,
        )

    def describe(self) -> list[dict[str, Any]]:
        """给 /api/config 用：列表 + 是否有 spec + 能力声明。"""
        out = []
        for name in self.templates():
            try:
                spec = self.load(name)
                out.append({"name": name, "id": spec.id, "label": spec.label,
                            "spec": not spec.legacy, "capabilities": list(spec.capabilities)})
            except (ValueError, OSError):
                out.append({"name": name, "id": Path(name).stem,
                            "label": Path(name).stem, "spec": False, "capabilities": []})
        return out
