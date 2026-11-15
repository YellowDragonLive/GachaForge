# 测试集设计

## 目标

验证 `z-image-turbo` 技能在保持默认工作流可用的前提下，支持通过 CLI 自由追加多个 LoRA，并可按需禁用内置默认 LoRA。

## 测试用例

### 用例 1：无自定义 LoRA 时保持默认行为

- 输入：仅提供 `--prompt`
- 预期：
  - 参数解析成功。
  - `build_api_prompt()` 不报错。
  - 默认 LoRA 节点 `64` 仍保持原始链路。

### 用例 2：追加单个 LoRA

- 输入：`--lora z\\sy.safetensors`
- 预期：
  - 成功创建新的 `LoraLoaderModelOnly` 节点。
  - 新节点应接在基础模型与默认 LoRA 之间。
  - 默认 LoRA 仍生效。

### 用例 3：追加多个 LoRA 且带不同强度

- 输入：
  - `--lora z\\sy.safetensors:1.0`
  - `--lora portrait\\face.safetensors=0.65`
- 预期：
  - 多个 LoRA 节点按输入顺序串联。
  - 每个节点的 `strength_model` 与输入一致。

### 用例 4：禁用默认 LoRA

- 输入：
  - `--lora z\\sy.safetensors:0.8`
  - `--disable-default-lora`
- 预期：
  - `ModelSamplingAuraFlow` 应直接连接最后一个自定义 LoRA 节点。
  - 默认节点 `64` 不再参与实际模型链路。

### 用例 5：异常规格校验

- 输入：非法 `--lora` 规格，例如空字符串或非法强度。
- 预期：
  - 参数解析阶段抛出清晰错误。
  - 不进入任务提交阶段。

## 验证方式

- 运行技能校验脚本，确认技能结构未被破坏。
- 运行脚本级回归测试，直接导入 `main.py` 调用解析与工作流构建函数。
- 视环境情况运行 `--help`，确认 CLI 参数已暴露。

## 回归关注点

- 默认工作流不应被破坏。
- 动态新增节点 ID 不应覆盖现有节点。
- 多 LoRA 串联顺序应稳定、可预测。
