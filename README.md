# 抽卡工作台

本机单人的抽卡生图工具：**词卡 → prompt → ComfyUI 出图 → 反哺概念图库**。
双击 `start.bat` 即可，不需要 npm、不需要联网、不需要 API key。

## 快速开始

```bat
start.bat
```

它会自动挑一个装好依赖的 Python、探测 ComfyUI（离线就自己拉起来）、建库、起服务，
最后打开 <http://127.0.0.1:8765>。首次运行会生成 `.env`。

不想自动拉 ComfyUI：`set GACHA_COMFY_AUTO=0` 后再启动，会走 mock 模式（占位图，链路照常可用）。

## 七个视图

| 视图 | 做什么 |
|---|---|
| 抽卡台 | 场景 + 人物 N 张 + 画风构图，点部位进池选词；一抽一张任务卡 |
| 概念 | 抽象概念的缩略图墙，点进去看这个概念出过的所有图 |
| 卡池 | 568 池 / 3.2 万条目的字典，可导入、编辑、启停 |
| 配方 | 可复用的槽位模板，`__池__` 语法，支持预览 |
| 任务 | 生图队列：排队 / 进度 / 取消 / 重试 |
| 画廊 | 出图结果，评分与收藏影响概念封面 |
| 设置 | 预设、checkpoint / LoRA / workflow、负向词、模型参数 |

## 文档

- **[docs/架构_总览.md](docs/架构_总览.md)** — 技术栈、目录、一次抽卡的完整链路、数据表、API、硬约定
- [docs/运维_启动与验收.md](docs/运维_启动与验收.md) — 启动、验收、排障（唯一操作口径）
- [docs/运维_数据迁移.md](docs/运维_数据迁移.md) — 旧数据导入与清空重建
- [docs/运维_清理权重.md](docs/运维_清理权重.md) — 条目权重括号审计

## 验证

```bash
python scripts/smoke_test.py       # 后端 113 项，mock + 临时库，不碰正式库
node scripts/test_frontend.mjs     # 前端 62 项，含 data-act / 引用 / 补全三道契约
node scripts/ui_shot.mjs           # 六视图 CDP 探针（契约全绿也可能整页空数据）
python scripts/live_test.py        # 真实 ComfyUI 端到端，需 8188 在线
```

## 目录

```
backend/   FastAPI + SQLite + 后台 Worker，22 张表
frontend/  零构建 ESM + Vue 3（vendor 内本地版），由后端托管
scripts/   固定入口脚本，start.bat 是唯一启动方式
data/      数据库 / 出图 / 缩略图 / 语义索引（不进 git）
docs/      架构总览 + 三本运维手册
```

根目录的 `action.json`、`zh_TW.json`、`wai_characters.csv`、`noobai_data.json`、`wai_tag_assist.json`
是建库数据源，`scripts/reset_db.py` 清库后会读它们重建字典，**不要删**。
