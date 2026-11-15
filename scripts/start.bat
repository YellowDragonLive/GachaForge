@echo off
chcp 65001 >nul
cd /d "%~dp0.."
setlocal

echo ============================================================
echo   Gacha Studio / ComfyUI local gacha tool
echo ============================================================

if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo [start] .env created from .env.example
)

REM Local ONNX deps are vendored from an existing site-packages, never downloaded
set "PYDEPS=%CD%\vendor\pydeps"
if not exist "%PYDEPS%\onnxruntime" (
  echo [start] Vendoring local ONNX deps - no download
  python scripts\vendor_deps.py --if-missing
)
if exist "%PYDEPS%\onnxruntime" set "PYTHONPATH=%PYDEPS%;%PYTHONPATH%"

python -c "import fastapi,uvicorn,sqlalchemy,alembic,httpx,websockets,PIL" >nul 2>&1
if errorlevel 1 (
  echo [start] Core dependencies missing - will NOT auto-download.
  echo [start] Install manually once - python -m pip install -r requirements.txt
  goto :fail
)

python -c "import sys;sys.path.insert(0,'.');import httpx;from backend.app.config import get_settings;s=get_settings();sys.exit(0 if httpx.get(s.comfy_url+'/system_stats',timeout=2).status_code==200 else 1)" >nul 2>&1
if errorlevel 1 (
  echo [start] ComfyUI is offline - switching to MOCK mode - placeholder images
  set GACHA_COMFY_MOCK=1
) else (
  echo [start] ComfyUI online - real generation mode
)

python scripts\init_db.py || goto :fail
python scripts\migrate_legacy.py --if-empty || goto :fail

REM Build artist semantic index offline on first run; warns only, never blocks startup
python scripts\build_semantics.py --if-missing

echo [start] Starting server - browser opens automatically...
python scripts\run_server.py
goto :eof

:fail
echo [start] FAILED. See the error above.
pause
