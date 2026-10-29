@echo off
setlocal
rem 不开 www.npmjs.com 也能拿 npm token。先把 NPM_USER / NPM_PASS / NPM_EMAIL 设成环境变量，再双击本文件。
where node >nul 2>nul
if %errorlevel%==0 (
  node "%~dp0scripts\npm-token.ts" %*
) else (
  set "NODE=C:\Users\zhili\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
  if exist "%NODE%" (
    "%NODE%" "%~dp0scripts\npm-token.ts" %*
  ) else (
    echo 找不到 node，也没有内置运行时。
  )
)
echo.
pause
