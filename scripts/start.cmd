@echo off
setlocal
chcp 65001 >nul
title Dual Model Workbench

cd /d "%~dp0.." || goto :bad_path

where node.exe >nul 2>&1
if errorlevel 1 goto :missing_node

node.exe -e "const [major,minor]=process.versions.node.split('.').map(Number);process.exit(major>22||(major===22&&minor>=12)?0:1)"
if errorlevel 1 goto :old_node

if not exist "node_modules\tsx\dist\cli.mjs" goto :missing_dependencies

if not exist "web\dist\index.html" (
  if not exist "web\node_modules\vite\bin\vite.js" goto :missing_web_dependencies
  node.exe -e "console.log('[\u51c6\u5907] \u5c1a\u672a\u627e\u5230\u7f51\u9875\u6784\u5efa\uff0c\u6b63\u5728\u6267\u884c npm run build:web...')"
  call npm.cmd run build:web
  if errorlevel 1 goto :build_failed
)

node.exe -e "console.log('[\u542f\u52a8] \u53cc\u6a21\u578b\u67b6\u6784\u5de5\u4f5c\u53f0\uff1ahttp://127.0.0.1:5170')"
node.exe -e "console.log('[\u505c\u6b62] \u5728\u6b64\u7a97\u53e3\u6309 Ctrl+C\uff0c\u5de5\u4f5c\u53f0\u4f1a\u53d6\u6d88\u6a21\u578b\u4efb\u52a1\u5e76\u91ca\u653e\u7aef\u53e3\u3002')"
echo.
node.exe "node_modules\tsx\dist\cli.mjs" "src\server\main.ts"
set "WORKBENCH_EXIT=%ERRORLEVEL%"
if not "%WORKBENCH_EXIT%"=="0" goto :runtime_failed
echo.
node.exe -e "console.log('\u5de5\u4f5c\u53f0\u5df2\u505c\u6b62\u3002')"
goto :eof

:bad_path
echo [ERROR] Cannot enter project directory: %~dp0..
goto :failed

:missing_node
echo [ERROR] Node.js was not found. Install Node.js 22.12 or newer, then run this file again.
goto :failed

:old_node
node.exe -e "console.log('[\u9519\u8bef] Node.js \u7248\u672c\u8fc7\u65e7\u3002\u9700\u8981 22.12 \u6216\u66f4\u65b0\u7248\u672c\u3002')"
node.exe --version
goto :failed

:missing_dependencies
node.exe -e "console.log('[\u9519\u8bef] \u9879\u76ee\u4f9d\u8d56\u5c1a\u672a\u5b89\u88c5\u3002\u8bf7\u5728\u9879\u76ee\u76ee\u5f55\u6267\u884c\uff1anpm install')"
goto :failed

:missing_web_dependencies
node.exe -e "console.log('[\u9519\u8bef] \u7f51\u9875\u5c1a\u672a\u6784\u5efa\uff0c\u4e14\u7f51\u9875\u4f9d\u8d56\u672a\u5b89\u88c5\u3002\u8bf7\u5148\u6267\u884c\uff1anpm install --prefix web')"
goto :failed

:build_failed
node.exe -e "console.log('[\u9519\u8bef] \u7f51\u9875\u6784\u5efa\u5931\u8d25\u3002\u8bf7\u67e5\u770b\u4e0a\u65b9\u8f93\u51fa\uff0c\u4fee\u590d\u540e\u6267\u884c\uff1anpm run build:web')"
goto :failed

:runtime_failed
echo.
node.exe -e "console.log('[\u9519\u8bef] \u5de5\u4f5c\u53f0\u5f02\u5e38\u9000\u51fa\uff0c\u9000\u51fa\u7801\uff1a' + process.argv[1])" "%WORKBENCH_EXIT%"

:failed
echo.
pause
exit /b 1
