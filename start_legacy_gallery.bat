@echo off
title 1025 Super Artist Gallery Server
color 0a

echo ============================================================
echo      1025 SUPER ARTIST GALLERY - PREMIUM WEB PORTAL
echo ============================================================
echo [STATUS] Checking local Node.js environment...
node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed or not in PATH!
    echo Please install Node.js first: https://nodejs.org/
    pause
    exit /b 1
)

echo [STATUS] Environment OK! Launching Native HTTP Server...
echo [STATUS] Automatically opening web portal in default browser...
start http://localhost:3000

echo [STATUS] Running: node server.js
echo [STATUS] Press Ctrl+C in this terminal to stop the server anytime.
echo ============================================================
node server.js
pause
