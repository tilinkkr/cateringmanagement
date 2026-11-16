@echo off
title Catering Manager
cd /d "%~dp0"
start "" http://localhost:5500
python -m http.server 5500 --directory web
pause
