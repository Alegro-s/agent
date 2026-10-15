@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Tochka Sborki - DEMO without LLM
set EDU_LLM=mock
set PORT=8788
start "" cmd /c "timeout /t 2 >nul & start http://localhost:8788"
node server.js
pause
