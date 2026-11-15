# 项目长期约定 · 抽卡工作台（X:/image）

## 交互 / UI
- **抽象概念优先用缩略图呈现，不要只给文字标签**（用户 2026-11-15 明确提出：「缩略图能帮人类快速判断抽象概念」）。这条是通用的，不限于画风：画师、风格 tag、动作、角色、LoRA、底模、配方、语义命中的「感觉」凡是文字说不清理不清的，都要用样图让人一眼判断。语义检索结果必须是带样图的卡片，而不是文字 chip 列表。缩略图同时是更快的选择控件，不只是装饰。
- **缩略图是通用呈现层，不是某个外部数据源**（用户 2026-11-15 补充：「缩略图可以推广到其它抽象领域，抽卡的时候已经有数据库了」）。主数据源是抽卡数据库自己：`draws.detail_json → generation_jobs → images.thumb_path`，加上 `draw_sessions.profile_snapshot_json` 里的 checkpoint/LoRA。每次抽卡已经把「概念 + 它生成的真实图」存全，任何概念都能反查到代表图，且随使用自生长、越贴合本机口味；外部 1025 张画师风格样图只作冷启动补充，不搬 3.2GB 原图、不常驻服务。`images.rating` / `favorite` 是代表图优选与后续偏好加权的最终人工信号。
- 凡是后端能枚举的值一律点选（下拉 / chip），不让用户手写表达式或 JSON；手写只作为 `<details>` 高级逃生口。自然语言描述（如「想要的感觉」）是 AI 交互入口，不在此限，但要给预设 chip 减少打字。
- 过滤类功能必须让「被过滤掉的东西」可见（warnings + 空槽位标记），否则用户只能看到结果莫名变少。

## 架构
- 前端零框架、零构建（原生 ESM，`widgets.js` 零 import 纯函数层）；后端 FastAPI + SQLite；一条 `scripts/start.bat` 起全套，不新增常驻服务。
- 本地 AI 能力优先：能用本机已有权重/节点就不联网、不装云端 SDK、不要 API key。ComfyUI `:8188` 是现成的本地推理后端。
- 语义抽卡采用「构建期离线预算向量 + 运行期只做 numpy 余弦」：索引存 `data/semantics/`，可重建、不入库；模型权重存 `data/models/`，两者都不进 git。运行时缺依赖要优雅降级，不能拖垮其他功能。
- **依赖也不重新下载**（用户 2026-11-15 明确：「你别重新下载依赖，你直接剪切到这个文件夹就行」）。本机已有的 Python 包 / 模型权重一律直接搬进项目：`scripts/vendor_deps.py` 从本机 `.venv` 的 site-packages 搬到 `vendor/pydeps/`（需 Python ABI 一致，本机都是 3.13/cp313），`embed.prepare_model()` 把 Chroma 缓存的 ONNX 权重**剪切**进 `data/models/minilm/`（不复制两份）。不 `pip install`、不改 requirements 触发下载、`start.bat` 缺依赖只提示手动装一次。模型与包都不进 git、可重建。

## 工程
- 代码改动落盘即 `git commit`，中文提交信息（改了什么 / 为什么改 / 怎么验证）；多个独立改动拆多个 commit。
- 高频操作先写 `scripts/` 脚本 + `docs/运维_*.md` 手册，手册是唯一口径，流程变了改手册和脚本。
- 冒烟测试必须用 `%TEMP%` 临时库副本隔离，绝不污染正式库；验证数据按 id 精确清理。
- **同一台机器有多个 Python，启动脚本不能假设 PATH 里那个装了依赖**（2026-11-15 双击实测踩坑）：双击 bat 走系统 PATH 的 `X:\ProgramData\miniconda3\python.exe` 3.13.13（只有 httpx），终端走 WorkBuddy 自带 `C:\Users\13410\.workbuddy\binaries\python\versions\3.13.12\python.exe` 3.13.14（核心依赖都在这）。`start.bat` 按 `GACHA_PYTHON` → 项目 `.venv` → PATH `python` → WorkBuddy 版本目录的顺序探测「能 import 七个核心模块」的解释器，存 `%PY%` 全程复用并打印。不要给 miniconda 装依赖、不要自动 pip。验证双击场景要用「PATH 只含 miniconda」的临时 bat 干跑，别靠终端环境想当然。
