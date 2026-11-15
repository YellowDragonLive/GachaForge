# 改动文件清单

## `C:\Users\13410\.codex\skills\z-image-turbo\scripts\main.py`

### 改动内容

- 新增 LoRA 规格解析函数 `parse_lora_spec()`。
- 新增模型链路注入函数 `inject_custom_loras()`。
- 扩展 `build_api_prompt()`，支持注入多个自定义 LoRA，并支持绕过默认 LoRA。
- 新增 CLI 参数：
  - `--lora`
  - `--disable-default-lora`
- 修正脚本退出方式，改为 `raise SystemExit(main())`，确保错误码可透传。

### 变更理由

- 让 `z-image-turbo` 技能具备运行时自由追加 LoRA 的能力。
- 与 `X:\image\_run_songyu_jade_face.py` 的动态节点注入方式保持一致，但升级为可重复传入、多 LoRA 串联。
- 保持默认工作流兼容性，不破坏已有 `zit_fdpo_v1.safetensors` 行为。

## `C:\Users\13410\.codex\skills\z-image-turbo\SKILL.md`

### 改动内容

- 新增单个 LoRA 的调用示例。
- 新增多个 LoRA + 禁用默认 LoRA 的调用示例。
- 在参数说明中加入 `--lora` 与 `--disable-default-lora`。
- 在注意事项中说明默认 LoRA 叠加逻辑与完全自定义组合方式。

### 变更理由

- 让技能文档与实际脚本能力保持一致。
- 降低后续调用时的试错成本。

## 任务文档

- 新增 `X:\image\01_analysis.md`
- 新增 `X:\image\02_test_plan.md`

### 变更理由

- 满足本次任务要求的分析、测试设计与工程闭环文档输出。
