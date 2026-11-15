@echo off
chcp 65001 >nul
cd /d "%~dp0.."
setlocal EnableDelayedExpansion

echo ============================================================
echo   Gacha Studio / ComfyUI local gacha tool
echo ============================================================

if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo [start] .env created from .env.example
)

REM Pick the Python that ALREADY has the core deps. Double-click resolves python
REM from the system PATH - miniconda 3.13.13, which has none of them - while the
REM deps are installed in the WorkBuddy bundled Python. Never auto-install.
set "PY="
set "CORECHECK=import fastapi,uvicorn,sqlalchemy,alembic,httpx,websockets,PIL"

if defined GACHA_PYTHON (
  "%GACHA_PYTHON%" -c "%CORECHECK%" >nul 2>&1
  if not errorlevel 1 set "PY=%GACHA_PYTHON%"
)
if not defined PY if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" -c "%CORECHECK%" >nul 2>&1
  if not errorlevel 1 set "PY=.venv\Scripts\python.exe"
)
if not defined PY (
  python -c "%CORECHECK%" >nul 2>&1
  if not errorlevel 1 set "PY=python"
)
if not defined PY (
  for /d %%D in ("%USERPROFILE%\.workbuddy\binaries\python\versions\*") do (
    if exist "%%~D\python.exe" (
      "%%~D\python.exe" -c "%CORECHECK%" >nul 2>&1
      if not errorlevel 1 if not defined PY set "PY=%%~D\python.exe"
    )
  )
)
if not defined PY (
  echo [start] No Python with the core dependencies was found. No auto-download.
  echo [start] Checked PATH python, project .venv and WorkBuddy bundled Python.
  echo [start] Fix 1 - set GACHA_PYTHON to a python that has fastapi etc.
  echo [start] Fix 2 - run once - python -m pip install -r requirements.txt
  goto :fail
)
echo [start] Python: %PY%

REM Local ONNX deps are vendored from an existing site-packages, never downloaded
set "PYDEPS=%CD%\vendor\pydeps"
if not exist "%PYDEPS%\onnxruntime" (
  echo [start] Vendoring local ONNX deps - no download
  "%PY%" scripts\vendor_deps.py --if-missing
)
if exist "%PYDEPS%\onnxruntime" set "PYTHONPATH=%PYDEPS%;%PYTHONPATH%"

"%PY%" -c "import sys;sys.path.insert(0,'.');import httpx;from backend.app.config import get_settings;s=get_settings();sys.exit(0 if httpx.get(s.comfy_url+'/system_stats',timeout=2).status_code==200 else 1)" >nul 2>&1
if errorlevel 1 (
  echo [start] ComfyUI is offline - switching to MOCK mode - placeholder images
  set GACHA_COMFY_MOCK=1
) else (
  echo [start] ComfyUI online - real generation mode
)

"%PY%" scripts\init_db.py || goto :fail
"%PY%" scripts\migrate_legacy.py --if-empty || goto :fail

REM Build artist semantic index offline on first run; warns only, never blocks startup
"%PY%" scripts\build_semantics.py --if-missing

echo [start] Starting server - browser opens automatically...
"%PY%" scripts\run_server.py
goto :eof

:fail
echo [start] FAILED. See the error above.
pause
