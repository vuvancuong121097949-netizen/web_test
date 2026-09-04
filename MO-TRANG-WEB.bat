@echo off
cd /d "%~dp0"

set "PYTHON_EXE=C:\Users\Asus\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
set "PREVIEW_URL=http://127.0.0.1:4173/"

start "Tai Khoan Xin - Preview" /min "%PYTHON_EXE%" -m http.server 4173 --bind 127.0.0.1
timeout /t 2 /nobreak >nul
start "" "%PREVIEW_URL%"
