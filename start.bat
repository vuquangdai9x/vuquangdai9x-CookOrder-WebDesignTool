@echo off
cd /d "%~dp0"
start "" cmd /c "npm run dev"
timeout /t 3 /nobreak >nul
start "" http://localhost:5173
