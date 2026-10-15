@echo off
cd /d "%~dp0"
if not exist node_modules call npm install --silent
node yesmike.mjs %*
if errorlevel 1 pause
