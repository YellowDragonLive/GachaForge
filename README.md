# SDXL Image Generation Workspace

这是一个用于图像生成、调试以及模型优化的工作区。

## 核心特性

- **SDXL 极速绘图 (Z-Image Turbo)**：集成 8-10 步的高速 SD3/AuraFlow 生成流。
- **SDXL 高清文生图 (sdxl-text2img)**：采用 illustrious 等高级 CKPT 进行高质量艺术生成。
- **SDXL 后期重绘 (sdxl-img2img)**：提供脸部、手部修复及局部重绘能力。

## 默认配置升级 (2026-05-17)

根据最新的艺术审美与算力开销平衡策略，我们将系统级默认参数进行了以下调优：

- **默认 CKPT**：升级至 `waiIllustriousSDXL_v170.safetensors`
- **默认步数 (Steps)**：调整为 `20` 步 (官方推荐：`15-30` 步，使用 `Euler a` 采样器)
- **人脸修复 (Face Fix)**：默认关闭 (避免重绘引起的画风断层，完美释出原生手绘五官)

## 目录结构

- `outputs/`：图像生成结果文件夹
- `_run_*.py`：临时执行脚本（自动忽略，无需提交）
- `_run_random_scene.py`：**双重随机探索与精致生图脚本**，一键从 `action.json` 和 `wai_characters.csv` 中双重随机抽取姿势与角色，自适应匹配性别并进行电影级奢华场景构图生图。
- `CHANGELOG.md`：改动记录

## 随机探索与精致生图使用指南

为方便“伟大的人工智能驾驭者”快速探索多样化高难度姿势、精美二次元角色与绝佳的光影插画，您只需在工作区运行：

```powershell
python _run_random_scene.py
```

脚本将为您全自动完成：
1. **本地数据库深度整合**：
   - 解析 `action.json` 提取 650+ 种有效动作标签。
   - 解析 `wai_characters.csv` 提取 5100+ 条中文角色与英文 SD Tag 的配对数据集。
2. **双重随机精准抽取**：随机挑选一个动作与一位角色，带来绝对未知与探索性的生图体验。
3. **极智兼容性处理**：
   - **自动识别性别**：分析角色 Tag 属性，智能匹配 `1girl` 或 `1boy` 等最贴切的提示词前缀。
   - **智能权重避让**：通过正则表达式安全转义角色 Tag 中的半角括号（如将 `(azur lane)` 转为 `\(azur lane\)`），规避 SD 对括号权重的解析错误。
4. **影院级画质强化**：结合电影级温暖豪华卧室光影色调。
5. **规范项目归档**：成果自动命名为 `{char_name}_random_{action_name}_result.png`，并同步留存在 `random_scene_generation_YYYYMMDD/` 项目文件夹中。

### 成果一键同步工具
如需将生成的所有精美大图一键提取至会话的 artifacts 归档文件夹以供离线审阅或在报告中嵌入，只需在工作区运行：
```powershell
python _run_copy_result.py
```
