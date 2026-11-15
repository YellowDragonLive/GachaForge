# 测试报告

## 测试范围

- 技能脚本语法正确性
- CLI 参数暴露正确性
- 多 LoRA 串联逻辑
- 禁用默认 LoRA 逻辑
- 技能目录结构合法性
- ComfyUI 真实生成链路

## 执行记录

### 1. 语法检查

- 命令：`python -X utf8 _run_py_compile_z_turbo.py`
- 结果：通过
- 关键输出：`py_compile: ok`

### 2. CLI 参数检查

- 命令：`python _run_z_turbo_help.py`
- 结果：通过
- 关键输出：
  - 已出现 `--lora`
  - 已出现 `--disable-default-lora`

### 3. 函数级回归测试

- 命令：`python -X utf8 _run_z_turbo_functional_tests.py`
- 结果：通过
- 覆盖点：
  - 默认行为保持不变
  - 单个 LoRA 追加
  - 多个 LoRA 串联
  - 禁用默认 LoRA
  - 非法强度报错
- 关键输出：`functional tests: ok`

### 4. 技能结构校验

- 命令：`python -X utf8 C:/Users/13410/.codex/skills/.system/skill-creator/scripts/quick_validate.py C:/Users/13410/.codex/skills/z-image-turbo`
- 结果：通过
- 关键输出：`Skill is valid!`

### 5. 环境可用性检查

- 命令：`python -X utf8 _run_check_comfyui_loras.py`
- 结果：通过
- 关键输出：
  - `comfyui: online`
  - `z\zit_fdpo_v1.safetensors: FOUND`
  - `z\sy.safetensors: FOUND`
  - `z\E5AE8BE78E8911.Jcn8.safetensors: FOUND`

### 6. 真实烟雾测试

- 命令：`python -X utf8 C:/Users/13410/.codex/skills/z-image-turbo/scripts/main.py --prompt "高精度宋玉古风人像，白玉发冠，面部特写，摄影写真，柔和暖光，皮肤细节清晰" --width 640 --height 960 --steps 6 --cfg 1.1 --lora "z\E5AE8BE78E8911.Jcn8.safetensors:1.0" --disable-default-lora --output X:/image/outputs/z_turbo_smoke --project . --filename smoke_custom_lora`
- 结果：通过
- 关键输出：
  - 成功提交任务，ID：`825d1f18-d853-492f-8cb4-87643ca2780d`
  - 成功生成并保存图片：
    `X:\image\outputs\z_turbo_smoke\smoke_custom_lora_212309_z-image_00355_.png`

## 修复前 vs 修复后

- 修复前：
  - 技能脚本无法通过 CLI 追加自定义 LoRA。
  - 用户只能依赖工作流内置默认 LoRA。
- 修复后：
  - 技能脚本支持重复传入 `--lora`，可自由叠加多个 LoRA。
  - 支持为每个 LoRA 指定强度。
  - 支持通过 `--disable-default-lora` 完全切换到自定义 LoRA 组合。
  - 实际 ComfyUI 生成链路已验证通过。

## 残余风险

- 当前 LoRA 规格解析默认把 `:`、`=`、`@` 作为强度分隔符。若未来 LoRA 文件名本身包含这些字符，需改为更严格的解析协议。
- 动态 LoRA 节点当前仅作用于模型链，不涉及 CLIP 链；若后续工作流改为需要 `LoraLoader`（同时处理 model/clip），需要再扩展。

## 回滚方案

- 回滚 `C:\Users\13410\.codex\skills\z-image-turbo\scripts\main.py`
- 回滚 `C:\Users\13410\.codex\skills\z-image-turbo\SKILL.md`
- 删除本次新增的任务文档：
  - `X:\image\01_analysis.md`
  - `X:\image\02_test_plan.md`
  - `X:\image\03_change_list.md`
  - `X:\image\04_test_report.md`

## 前端/浏览器测试说明

- 本次任务仅涉及本地 Python 技能脚本与 ComfyUI API，不存在前端页面改动，因此浏览器测试不适用。
