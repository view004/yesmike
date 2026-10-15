@echo off
setlocal
rem short (8.3) path = no spaces, so wt needs no quoting
for %%I in ("%~dp0.") do set "DIR=%%~sfI"
where wt >nul 2>nul
if %errorlevel%==0 (
  start "" wt -w new --size 82,26 --title yesmike --suppressApplicationTitle -d %DIR% cmd /c %DIR%\run.cmd %*
) else (
  mode con cols=82 lines=26
  title yesmike
  call "%DIR%\run.cmd" %*
)
