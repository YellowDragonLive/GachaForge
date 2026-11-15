@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem 词卡库根目录（stable-diffusion-webui-wildcards 扩展的 wildcards 文件夹）
set GACHA_WILDCARDS_DIR=%~dp0stable-diffusion-webui-wildcards\wildcards
echo ============================================
echo  多 JSON 抽卡器 + 词卡组合 - 启动 Python 服务器
echo  词卡库: %GACHA_WILDCARDS_DIR%
echo ============================================
start "" http://127.0.0.1:8765/
python gacha_server.py 8765
pause
