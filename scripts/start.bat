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

REM ---- ComfyUI: probe, and autostart the portable build when it is down ------
REM One double-click should bring up the whole stack. If 8188 is already
REM answering we reuse it; otherwise we launch the portable build in its own
REM window and wait for /system_stats before touching the DB, so the gacha
REM server always starts in real mode when the weights are actually there.
REM   GACHA_COMFY_AUTO=0  -> skip autostart, keep the old "offline => mock"
REM   GACHA_COMFY_DIR=... -> point at another ComfyUI portable folder
if not defined COMFY_DIR set "COMFY_DIR=%GACHA_COMFY_DIR%"
if not defined COMFY_DIR set "COMFY_DIR=X:\ai_tool\ComfyUI_windows_portable_nvidia\ComfyUI_windows_portable"

REM ---- Model link bridge -----------------------------------------------------
REM Civitai downloads land in models\checkpoints, but UNETLoader only enumerates
REM models\unet and models\diffusion_models - so pure-UNet weights (Anima, Flux,
REM Mochi...) would never appear in the picker. Hardlink them over: same bytes,
REM no second copy. Must run BEFORE ComfyUI starts, it scans folders at startup.
"%PY%" scripts\link_unet_models.py --models-dir "%COMFY_DIR%\ComfyUI\models" --quiet

call :probe_comfy
if not errorlevel 1 goto :comfy_ready
if "%GACHA_COMFY_AUTO%"=="0" goto :comfy_checked
if not exist "%COMFY_DIR%\run_nvidia_gpu.bat" goto :comfy_noinstall

REM Hint only - never set GACHA_COMFY_URL here, that would override .env
set "COMFY_HINT=%GACHA_COMFY_URL%"
if not defined COMFY_HINT set "COMFY_HINT=http://127.0.0.1:8188"
echo [start] ComfyUI is offline - launching it from %COMFY_DIR%
echo [start] A separate ComfyUI window will open and stay open - that is expected.
start "ComfyUI" /D "%COMFY_DIR%" "%COMFY_DIR%\run_nvidia_gpu.bat"

set /a COMFY_TRIES=0
:comfy_wait
"%SystemRoot%\System32\ping.exe" -n 3 127.0.0.1 >nul
call :probe_comfy
if not errorlevel 1 goto :comfy_ready
set /a COMFY_TRIES+=1
if !COMFY_TRIES! GEQ 60 goto :comfy_timeout
echo [start] waiting for ComfyUI at !COMFY_HINT! - !COMFY_TRIES!/60
goto :comfy_wait

:comfy_timeout
echo [start] ComfyUI did not answer after ~5 min. Check the ComfyUI window for
echo [start] errors - usually a missing checkpoint or a stale Nvidia driver.
echo [start] Continuing in MOCK mode - placeholder images.
set "GACHA_COMFY_MOCK=1"
goto :comfy_checked

:comfy_noinstall
echo [start] ComfyUI is offline and no portable build was found at:
echo [start]   %COMFY_DIR%
echo [start] Set GACHA_COMFY_DIR to your ComfyUI folder, or set
echo [start] GACHA_COMFY_AUTO=0 to silence this. Continuing in MOCK mode.
set "GACHA_COMFY_MOCK=1"
goto :comfy_checked

:comfy_ready
echo [start] ComfyUI online - real generation mode
goto :comfy_checked

:comfy_checked

"%PY%" scripts\init_db.py || goto :fail
"%PY%" scripts\migrate_legacy.py --if-empty || goto :fail

REM Build artist semantic index offline on first run; warns only, never blocks startup
"%PY%" scripts\build_semantics.py --if-missing

REM ---- Already running? -----------------------------------------------------
REM uvicorn exits immediately when the port is taken and the old bat went
REM straight to :eof - the window just flashed. Probe first: if the server is
REM already up, open the browser, explain how to restart, and wait for a key.
"%PY%" scripts\probe_server.py --open
REM Use goto labels, not a multi-line if block: cmd mis-parses those on LF bats.
if errorlevel 1 goto :server_down
echo [start] Server is already running - browser opened, nothing to start.
echo [start] To restart with new code, close the old server window first.
if not "%GACHA_NO_PAUSE%"=="1" pause
goto :eof

:server_down
echo [start] Starting server - browser opens automatically...
REM Any launch failure must land in :fail (which pauses), so the error is readable.
"%PY%" scripts\run_server.py || goto :fail
goto :eof

:fail
echo [start] FAILED. See the error above.
if not "%GACHA_NO_PAUSE%"=="1" pause
goto :eof

REM ---- helpers ---------------------------------------------------------------
REM Reachability check lives in scripts/probe_comfy.py: it reads comfy_url from
REM the backend config (so a custom GACHA_COMFY_URL in .env is honoured) and
REM falls back to 127.0.0.1:8188, so a broken config can never make us launch a
REM second ComfyUI on the same port. exit code 0 = up, 1 = down.
:probe_comfy
"%PY%" scripts\probe_comfy.py >nul 2>&1
if errorlevel 1 exit /b 1
exit /b 0
