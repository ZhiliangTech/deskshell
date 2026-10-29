@echo off
setlocal
rem 不开 www.npmjs.com 也能拿 npm token。先把 NPM_USER / NPM_PASS / NPM_EMAIL 设成环境变量，再双击本文件。
rem 如果 node 不在 PATH，先 set NODE=完整路径\node.exe
if defined NODE (
  "%NODE%" "%~dp0scripts\npm-token.ts" %*
) else (
  node "%~dp0scripts\npm-token.ts" %*
)
echo.
pause
