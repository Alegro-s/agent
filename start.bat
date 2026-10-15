@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Tochka Sborki - AI metodist
where node >nul 2>nul || (echo [!] Need Node.js 22+ : https://nodejs.org & pause & exit /b 1)
curl -s -m 3 http://127.0.0.1:11434/api/version >nul 2>nul || (
  echo Starting Ollama...
  start "" "%LOCALAPPDATA%\Programs\Ollama\ollama app.exe"
  timeout /t 6 >nul
)
if "%EDU_MODEL%"=="" set EDU_MODEL=qwen2.5:7b
start "" cmd /c "timeout /t 2 >nul & start http://localhost:8787"
node server.js
pause
