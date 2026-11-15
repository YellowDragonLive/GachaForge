# 问题定义

## 现象

- `C:\Users\13410\.codex\skills\z-image-turbo\scripts\main.py` 当前只支持修改提示词、分辨率、步数、CFG、种子和输出目录。
- LoRA 没有 CLI 参数入口，用户无法像参考脚本 `X:\image\_run_songyu_jade_face.py` 那样，在运行时自由追加自定义 LoRA。
- 当前技能的 LoRA 仅存在于工作流 `resources/workflow.json` 的固定节点 `64`，名称为 `z\zit_fdpo_v1.safetensors`，强度 `0.5`。

## 影响范围

- 影响 `z-image-turbo` 技能的所有调用场景。
- 影响需要临时叠加人物 LoRA、风格 LoRA、项目专属 LoRA 的工作流复用能力。
- 不影响 ComfyUI 服务本身，也不影响工作流默认输出链路。

## 复现条件

1. 执行 `z-image-turbo/scripts/main.py`。
2. 观察参数列表，不存在 `--lora` 一类的入口。
3. 阅读 `build_api_prompt()`，可见其只改写节点 `45`、`41`、`44`，未注入新的 `LoraLoaderModelOnly` 节点。

## 初步假设清单

- 假设 1：脚本层未暴露 LoRA 参数，是不能自由追加 LoRA 的直接原因。
- 假设 2：工作流默认 LoRA 节点 `64` 仍可继续复用，只需在 `46 -> 64` 之间插入新的 LoRA 链即可。
- 假设 3：若用户需要完全自定义 LoRA 组合，还需要提供“禁用默认 LoRA”的可选开关。

## 根因

- 根因是 `scripts/main.py` 缺少 LoRA 规格解析与工作流节点注入逻辑，导致工作流只能依赖模板里预置的固定 LoRA。

## 非根因（已排除项）

- 不是 ComfyUI API 不支持 LoRA：参考脚本已证明可通过 API 动态插入 `LoraLoaderModelOnly` 节点。
- 不是工作流没有模型链路：现有链路为 `46 -> 64 -> 47 -> 44`，可安全插入额外 LoRA 节点。
- 不是资源文件缺失：`resources/workflow.json` 与默认 LoRA 节点均存在。

## 改动策略

- 采用最小改动方案，仅修改 `scripts/main.py` 与 `SKILL.md`。
- 增加重复参数 `--lora`，允许一次传入多个 LoRA。
- 允许 LoRA 规格携带强度，默认强度为 `1.0`。
- 提供可选开关绕过默认 LoRA，满足“自由增加/自由组合”需求。
