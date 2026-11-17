@echo off
chcp 65001 >nul
cd /d "%~dp0.."
REM Double-click entry for clean_db.py. The manual requires the server to be
REM stopped first, so we clear the port before touching the database.
title Clean Runtime Data - dictionaries and config are kept
setlocal EnableDelayedExpansion

echo ============================================================
echo   Gacha Studio / clean runtime data
echo   Clears draws / jobs / images / concepts. Keeps pools, recipes, presets.
echo ============================================================
echo.

REM Same interpreter probe as start.bat: the system PATH python (miniconda)
REM has none of the core deps; never auto-download anything.
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
  echo [clean] FAILED: no Python with the core dependencies was found.
  echo [clean] Set GACHA_PYTHON to a python that has fastapi etc. No auto-download.
  goto :fail
)

REM ---- Stop the server first (manual: cleaning while it runs can lock VACUUM) --
REM --kill only touches a process whose command line is run_server.py/uvicorn.
echo [clean] Stopping the server on our port, if any...
"%PY%" scripts\probe_server.py --kill
if errorlevel 1 goto :fail

REM Explicit args = caller knows what it wants (e.g. clean.bat --yes --keep-images).
REM No args = interactive: preview the list, then ask before writing.
if not "%~1"=="" goto :args

:interactive
"%PY%" scripts\clean_db.py
if errorlevel 1 goto :fail
echo.
choice /C YN /N /T 20 /D N /M "  Execute the clean above? [Y/N] (default N) "
if errorlevel 2 goto :cancelled
if errorlevel 1 goto :execute
goto :cancelled

:args
"%PY%" scripts\clean_db.py %*
if errorlevel 1 goto :fail
goto :done

:execute
echo.
"%PY%" scripts\clean_db.py --yes
if errorlevel 1 goto :fail
goto :done

:cancelled
echo [clean] Cancelled - nothing changed.
goto :done

:fail
echo [clean] FAILED. See the message above; nothing was changed by this script.
goto :done

:done
echo.
if "%GACHA_NO_PAUSE%"=="1" goto :eof
pause
goto :eof
