@echo off
chcp 65001 >nul 2>&1
setlocal EnableDelayedExpansion

:: ============================================================
::  抖音直播录制工具 - 一键封装脚本
::  功能：环境检测 → 自动安装缺失依赖 → 封装EXE → 输出日志
:: ============================================================

:: ---------- 配置变量 ----------
set "PROJECT_DIR=%~dp0"
set "LOG_FILE=%PROJECT_DIR%build_log.txt"
set "NODE_MIN_VERSION=18"
set "PNPM_VERSION=9"
set "ELECTRON_BUILDER_VERSION=25.1.8"

:: ---------- 初始化日志 ----------
echo ============================================================ > "%LOG_FILE%"
echo   抖音直播录制工具 - 封装日志 >> "%LOG_FILE%"
echo   时间: %date% %time% >> "%LOG_FILE%"
echo   工作目录: %PROJECT_DIR% >> "%LOG_FILE%"
echo ============================================================ >> "%LOG_FILE%"
echo. >> "%LOG_FILE%"

:: ---------- 控制台样式 ----------
color 0A
title  抖音直播录制工具 - 一键封装
cls

echo.
echo  ╔══════════════════════════════════════════════════════╗
echo  ║          抖音直播录制工具 - 一键封装程序             ║
echo  ║                                                      ║
echo  ║  本程序将自动检测并配置封装环境，然后打包为EXE       ║
echo  ╚══════════════════════════════════════════════════════╝
echo.
echo  [信息] 日志文件: %LOG_FILE%
echo.

:: ============================================================
::  步骤1: 检测 Node.js
:: ============================================================
echo  ──────────────────────────────────────────────────────
echo  [1/5] 检测 Node.js 环境...
echo  ──────────────────────────────────────────────────────
echo [步骤1] 检测 Node.js 环境... >> "%LOG_FILE%"

where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo.
    echo  [错误] 未检测到 Node.js!
    echo  [操作] 正在自动下载 Node.js v20 LTS...
    echo [步骤1] 未检测到 Node.js，开始自动下载 >> "%LOG_FILE%"
    
    :: 下载 Node.js
    set "NODE_INSTALLER=%TEMP%\node-v20.18.0-x64.msi"
    set "NODE_URL=https://npmmirror.com/mirrors/node/v20.18.0/node-v20.18.0-x64.msi"
    
    echo  [下载] 从 npmmirror 镜像下载 Node.js v20.18.0...
    echo [步骤1] 下载URL: %NODE_URL% >> "%LOG_FILE%"
    
    :: 使用 PowerShell 下载（带进度）
    powershell -Command "& { \
        $url = '%NODE_URL%'; \
        $output = '%NODE_INSTALLER%'; \
        Write-Host '  [下载] 正在下载...'; \
        try { \
            $webclient = New-Object System.Net.WebClient; \
            $webclient.DownloadFile($url, $output); \
            Write-Host '  [完成] 下载成功'; \
        } catch { \
            Write-Host '  [错误] 下载失败: ' $_.Exception.Message; \
            exit 1; \
        } \
    }" >> "%LOG_FILE%" 2>&1
    
    if %ERRORLEVEL% neq 0 (
        echo  [错误] Node.js 下载失败！
        echo  [建议] 请手动下载安装: https://nodejs.org/
        echo [步骤1] 下载失败 >> "%LOG_FILE%"
        goto :build_failed
    )
    
    echo  [安装] 正在安装 Node.js（可能需要管理员权限）...
    echo [步骤1] 开始安装 Node.js >> "%LOG_FILE%"
    
    :: 静默安装
    msiexec /i "%NODE_INSTALLER%" /qn /norestart ADDLOCAL=ALL >> "%LOG_FILE%" 2>&1
    
    if %ERRORLEVEL% neq 0 (
        echo  [警告] 静默安装失败，尝试交互式安装...
        echo [步骤1] 静默安装失败，启动交互式安装 >> "%LOG_FILE%"
        start /wait msiexec /i "%NODE_INSTALLER%" ADDLOCAL=ALL
    )
    
    :: 清理安装包
    del "%NODE_INSTALLER%" >nul 2>&1
    
    :: 刷新环境变量
    echo  [信息] 刷新环境变量...
    call refreshenv >nul 2>&1
    
    :: 重新检测
    set "PATH=%ProgramFiles%\nodejs;%PATH%"
    where node >nul 2>&1
    if %ERRORLEVEL% neq 0 (
        echo.
        echo  [错误] Node.js 安装后仍无法检测到
        echo  [建议] 请关闭此窗口，重新打开后再运行
        echo [步骤1] 安装后仍无法检测 >> "%LOG_FILE%"
        goto :build_failed
    )
)

:: 检测版本
for /f "tokens=1 delims=v" %%a in ('node -v') do set "NODE_RAW=%%a"
for /f "tokens=1 delims=." %%a in ('node -v') do set "NODE_MAJOR=%%a"
set "NODE_MAJOR=!NODE_MAJOR:v=!"

echo  [通过] Node.js 已安装: v!NODE_MAJOR!
echo [步骤1] Node.js 版本: v!NODE_MAJOR! >> "%LOG_FILE%"

if !NODE_MAJOR! lss %NODE_MIN_VERSION% (
    echo  [警告] Node.js 版本过低 (需要 v%NODE_MIN_VERSION%+)
    echo  [建议] 请手动升级: https://nodejs.org/
    echo [步骤1] 版本过低警告 >> "%LOG_FILE%"
    echo.
    set /p "CONTINUE=  是否继续? (Y/N): "
    if /i not "!CONTINUE!"=="Y" goto :build_failed
)

:: ============================================================
::  步骤2: 检测 pnpm
:: ============================================================
echo.
echo  ──────────────────────────────────────────────────────
echo  [2/5] 检测 pnpm 包管理器...
echo  ──────────────────────────────────────────────────────
echo [步骤2] 检测 pnpm... >> "%LOG_FILE%"

where pnpm >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo  [操作] 未检测到 pnpm，正在安装...
    echo [步骤2] 未检测到 pnpm，开始安装 >> "%LOG_FILE%"
    
    echo  [安装] 通过 npm 全局安装 pnpm...
    call npm install -g pnpm >> "%LOG_FILE%" 2>&1
    
    if %ERRORLEVEL% neq 0 (
        echo  [错误] pnpm 安装失败
        echo [步骤2] pnpm 安装失败 >> "%LOG_FILE%"
        goto :build_failed
    )
    
    :: 刷新
    set "PATH=%APPDATA%\npm;%PATH%"
    where pnpm >nul 2>&1
    if %ERRORLEVEL% neq 0 (
        echo  [错误] pnpm 安装后无法检测
        echo  [建议] 请关闭此窗口，重新打开后再运行
        echo [步骤2] 安装后无法检测 >> "%LOG_FILE%"
        goto :build_failed
    )
)

for /f "tokens=1 delims=." %%a in ('pnpm -v') do set "PNPM_MAJOR=%%a"
echo  [通过] pnpm 已安装: v%PNPM_MAJOR%
echo [步骤2] pnpm 版本: v%PNPM_MAJOR% >> "%LOG_FILE%"

:: ============================================================
::  步骤3: 安装项目依赖
:: ============================================================
echo.
echo  ──────────────────────────────────────────────────────
echo  [3/5] 安装项目依赖...
echo  ──────────────────────────────────────────────────────
echo [步骤3] 开始安装项目依赖... >> "%LOG_FILE%"

cd /d "%PROJECT_DIR%"

:: 配置 npm 镜像加速
echo  [配置] 设置 npmmirror 镜像加速...
call pnpm config set registry https://registry.npmmirror.com >> "%LOG_FILE%" 2>&1
call npm config set registry https://registry.npmmirror.com >> "%LOG_FILE%" 2>&1
call npm config set electron_mirror https://npmmirror.com/mirrors/electron/ >> "%LOG_FILE%" 2>&1

echo  [安装] 正在安装项目依赖（首次安装可能需要几分钟）...
echo  [提示] 使用 npmmirror 镜像加速下载...
echo.

call pnpm install >> "%LOG_FILE%" 2>&1

if %ERRORLEVEL% neq 0 (
    echo  [错误] 依赖安装失败！请查看日志文件了解详情
    echo  [日志] %LOG_FILE%
    echo [步骤3] 依赖安装失败 >> "%LOG_FILE%"
    goto :build_failed
)

echo  [通过] 项目依赖安装完成
echo [步骤3] 依赖安装完成 >> "%LOG_FILE%"

:: ============================================================
::  步骤4: 封装 EXE
:: ============================================================
echo.
echo  ──────────────────────────────────────────────────────
echo  [4/5] 开始封装 EXE 程序...
echo  ──────────────────────────────────────────────────────
echo [步骤4] 开始封装 EXE... >> "%LOG_FILE%"

echo  [封装] 正在打包 Windows EXE（可能需要几分钟）...
echo  [提示] 首次封装需要下载 Electron 二进制文件，请耐心等待...
echo.

call pnpm run build >> "%LOG_FILE%" 2>&1

if %ERRORLEVEL% neq 0 (
    echo  [错误] 封装失败！请查看日志文件了解详情
    echo  [日志] %LOG_FILE%
    echo [步骤4] 封装失败 >> "%LOG_FILE%"
    goto :build_failed
)

echo  [通过] EXE 封装完成
echo [步骤4] 封装完成 >> "%LOG_FILE%"

:: ============================================================
::  步骤5: 输出结果
:: ============================================================
echo.
echo  ──────────────────────────────────────────────────────
echo  [5/5] 输出结果...
echo  ──────────────────────────────────────────────────────
echo [步骤5] 检查输出文件... >> "%LOG_FILE%"

:: 查找生成的EXE/安装包
set "FOUND_EXE=0"
if exist "%PROJECT_DIR%dist\*.exe" (
    for %%f in ("%PROJECT_DIR%dist\*.exe") do (
        echo  [输出] %%~nxf
        echo [步骤5] 输出文件: %%f >> "%LOG_FILE%"
        set "FOUND_EXE=1"
        set "OUTPUT_FILE=%%f"
    )
)

echo.
echo  ╔══════════════════════════════════════════════════════╗
echo  ║                  封装完成!                           ║
echo  ╠══════════════════════════════════════════════════════╣
echo  ║                                                      ║
if %FOUND_EXE% equ 1 (
echo  ║  输出目录: %PROJECT_DIR%dist\
echo  ║  日志文件: %LOG_FILE%
) else (
echo  ║  输出目录: %PROJECT_DIR%dist\
echo  ║  日志文件: %LOG_FILE%
)
echo  ║                                                      ║
echo  ║  提示: 将 dist 目录中的安装包复制到目标机器即可使用  ║
echo  ╚══════════════════════════════════════════════════════╝
echo.
echo [完成] 封装流程结束 %date% %time% >> "%LOG_FILE%"

:: 打开输出目录
explorer "%PROJECT_DIR%dist" 2>nul

goto :end

:: ============================================================
::  失败处理
:: ============================================================
:build_failed
echo.
echo  ╔══════════════════════════════════════════════════════╗
echo  ║                  封装失败                            ║
echo  ╠══════════════════════════════════════════════════════╣
echo  ║                                                      ║
echo  ║  请查看日志文件获取详细错误信息:                     ║
echo  ║  %LOG_FILE%
echo  ║                                                      ║
echo  ║  常见问题:                                           ║
echo  ║  1. 网络问题 - 检查网络连接或更换镜像源              ║
echo  ║  2. 权限问题 - 以管理员身份运行此脚本                ║
echo  ║  3. 磁盘空间 - 确保有足够磁盘空间(至少2GB)          ║
echo  ║  4. 杀毒软件 - 临时关闭杀毒软件后重试                ║
echo  ╚══════════════════════════════════════════════════════╝
echo.
echo [失败] 封装流程异常结束 %date% %time% >> "%LOG_FILE%"

:end
echo.
echo  按任意键退出...
pause >nul
endlocal
