# ============================================================
#  Douyin Live Recorder - Build Script (PowerShell)
#  Auto-detect environment, install dependencies, build EXE
# ============================================================

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Continue"

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$LogFile = Join-Path $ProjectDir "build_log.txt"
$NodeMinVersion = 18

# ---------- Logging ----------
function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$timestamp] [$Level] $Message"
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
    
    switch ($Level) {
        "OK"    { Write-Host "  [OK] " -NoNewline -ForegroundColor Green; Write-Host $Message }
        "WARN"  { Write-Host "  [WARN] " -NoNewline -ForegroundColor Yellow; Write-Host $Message }
        "ERROR" { Write-Host "  [ERROR] " -NoNewline -ForegroundColor Red; Write-Host $Message }
        "STEP"  { Write-Host "  >> " -NoNewline -ForegroundColor Cyan; Write-Host $Message }
        "DL"    { Write-Host "  [DOWNLOAD] " -NoNewline -ForegroundColor Magenta; Write-Host $Message }
        default { Write-Host "  $Message" }
    }
}

function Write-Banner {
    Write-Host ""
    Write-Host "  ============================================================" -ForegroundColor White
    Write-Host "       Douyin Live Recorder - One-click Build Tool" -ForegroundColor White
    Write-Host "  ============================================================" -ForegroundColor White
    Write-Host ""
    Write-Host "  This tool will:" -ForegroundColor Gray
    Write-Host "    1. Detect Node.js environment" -ForegroundColor Gray
    Write-Host "    2. Detect pnpm package manager" -ForegroundColor Gray
    Write-Host "    3. Install project dependencies" -ForegroundColor Gray
    Write-Host "    4. Build Windows EXE package" -ForegroundColor Gray
    Write-Host ""
    Write-Host "  Log file: $LogFile" -ForegroundColor DarkGray
    Write-Host ""
}

# ---------- Initialize ----------
# Clear old log
"============================================================" | Out-File -FilePath $LogFile -Encoding UTF8
"  Douyin Live Recorder - Build Log" | Out-File -FilePath $LogFile -Append -Encoding UTF8
"  Time: $(Get-Date)" | Out-File -FilePath $LogFile -Append -Encoding UTF8
"  Directory: $ProjectDir" | Out-File -FilePath $LogFile -Append -Encoding UTF8
"============================================================" | Out-File -FilePath $LogFile -Append -Encoding UTF8
"" | Out-File -FilePath $LogFile -Append -Encoding UTF8

Write-Banner

$buildSuccess = $true

# ============================================================
#  Step 1: Detect Node.js
# ============================================================
Write-Host "  ------------------------------------------------------------" -ForegroundColor DarkGray
Write-Log "Step 1/5: Detecting Node.js..." "STEP"

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Log "Node.js not found. Starting auto-download..." "WARN"
    
    $nodeVersion = "v20.18.0"
    $nodeUrl = "https://npmmirror.com/mirrors/node/$nodeVersion/node-$nodeVersion-x64.msi"
    $nodeInstaller = Join-Path $env:TEMP "node-$nodeVersion-x64.msi"
    
    Write-Log "Downloading Node.js $nodeVersion from npmmirror..." "DL"
    Write-Log "URL: $nodeUrl" "DL"
    
    try {
        # Download with progress
        $webClient = New-Object System.Net.WebClient
        $webClient.DownloadFile($nodeUrl, $nodeInstaller)
        Write-Log "Download complete: $nodeInstaller" "OK"
    }
    catch {
        Write-Log "Download failed: $($_.Exception.Message)" "ERROR"
        Write-Log "Please download manually: https://nodejs.org/" "ERROR"
        $buildSuccess = $false
    }
    
    if ($buildSuccess) {
        Write-Log "Installing Node.js (may require admin privileges)..." "STEP"
        
        try {
            $process = Start-Process -FilePath "msiexec.exe" -ArgumentList "/i `"$nodeInstaller`" /qn /norestart ADDLOCAL=ALL" -Wait -PassThru -NoNewWindow
            if ($process.ExitCode -ne 0) {
                Write-Log "Silent install failed (exit code: $($process.ExitCode)), trying interactive install..." "WARN"
                Start-Process -FilePath "msiexec.exe" -ArgumentList "/i `"$nodeInstaller`" ADDLOCAL=ALL" -Wait
            }
            Write-Log "Node.js installation complete" "OK"
        }
        catch {
            Write-Log "Installation failed: $($_.Exception.Message)" "ERROR"
            $buildSuccess = $false
        }
        
        # Cleanup installer
        Remove-Item $nodeInstaller -Force -ErrorAction SilentlyContinue
        
        # Refresh PATH
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
        
        # Verify
        $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
        if (-not $nodeCmd) {
            Write-Log "Node.js still not detected after installation." "ERROR"
            Write-Log "Please close this window and run the script again." "ERROR"
            $buildSuccess = $false
        }
    }
}

if ($buildSuccess -and $nodeCmd) {
    $nodeVersionRaw = & node -v 2>&1
    $nodeMajor = [int]($nodeVersionRaw -replace 'v(\d+)\..*', '$1')
    Write-Log "Node.js detected: $nodeVersionRaw" "OK"
    
    if ($nodeMajor -lt $NodeMinVersion) {
        Write-Log "Node.js version too low (need v${NodeMinVersion}+). Please upgrade." "WARN"
        $continue = Read-Host "  Continue anyway? (Y/N)"
        if ($continue -ne 'Y' -and $continue -ne 'y') {
            $buildSuccess = $false
        }
    }
}

# ============================================================
#  Step 2: Detect pnpm
# ============================================================
if ($buildSuccess) {
    Write-Host ""
    Write-Host "  ------------------------------------------------------------" -ForegroundColor DarkGray
    Write-Log "Step 2/5: Detecting pnpm..." "STEP"
    
    $pnpmCmd = Get-Command pnpm -ErrorAction SilentlyContinue
    if (-not $pnpmCmd) {
        Write-Log "pnpm not found. Installing via npm..." "WARN"
        
        try {
            & npm install -g pnpm 2>&1 | ForEach-Object { Write-Log $_ "INFO" }
            
            # Refresh PATH
            $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User") + ";$env:APPDATA\npm"
            
            $pnpmCmd = Get-Command pnpm -ErrorAction SilentlyContinue
            if (-not $pnpmCmd) {
                Write-Log "pnpm still not detected. Please close this window and retry." "ERROR"
                $buildSuccess = $false
            } else {
                $pnpmVer = & pnpm -v 2>&1
                Write-Log "pnpm installed: v$pnpmVer" "OK"
            }
        }
        catch {
            Write-Log "pnpm install failed: $($_.Exception.Message)" "ERROR"
            $buildSuccess = $false
        }
    } else {
        $pnpmVer = & pnpm -v 2>&1
        Write-Log "pnpm detected: v$pnpmVer" "OK"
    }
}

# ============================================================
#  Step 3: Configure mirrors & install dependencies
# ============================================================
if ($buildSuccess) {
    Write-Host ""
    Write-Host "  ------------------------------------------------------------" -ForegroundColor DarkGray
    Write-Log "Step 3/5: Installing project dependencies..." "STEP"
    
    Set-Location $ProjectDir
    
    # Configure mirrors for faster downloads in China
    Write-Log "Configuring npmmirror for faster downloads..." "STEP"
    & npm config set registry https://registry.npmmirror.com 2>&1 | Out-Null
    & pnpm config set registry https://registry.npmmirror.com 2>&1 | Out-Null
    & npm config set electron_mirror https://npmmirror.com/mirrors/electron/ 2>&1 | Out-Null
    Write-Log "Mirror configured: npmmirror.com" "OK"
    
    # Approve build scripts for packages that need postinstall (electron, ffmpeg, etc.)
    # Required for pnpm v11+ which blocks build scripts by default
    Write-Log "Ensuring .npmrc configuration for pnpm v11+..." "INFO"
    $npmrcPath = Join-Path $ProjectDir ".npmrc"
    # Always recreate .npmrc to ensure correct settings
    $npmrcContent = "onlyBuiltDependencies[]=electron`nonlyBuiltDependencies[]=@ffmpeg-installer/ffmpeg`nonlyBuiltDependencies[]=electron-builder"
    Set-Content -Path $npmrcPath -Value $npmrcContent -Encoding UTF8 -Force
    Write-Log ".npmrc created at: $npmrcPath" "OK"
    
    Write-Log "Running pnpm install (first time may take several minutes)..." "STEP"
    Write-Host ""
    
    $installOutput = & pnpm install --config.confirmModulesPurge=false 2>&1
    $installExitCode = $LASTEXITCODE
    
    $installOutput | ForEach-Object {
        $line = $_.ToString()
        if ($line -match "error|ERR|fail") {
            Write-Log $line "ERROR"
        } elseif ($line -match "warn|WARN") {
            Write-Log $line "WARN"
        } else {
            Write-Log $line "INFO"
        }
    }
    
    if ($installExitCode -ne 0) {
        Write-Log "Dependency installation failed! Check build_log.txt" "ERROR"
        $buildSuccess = $false
    } else {
        Write-Log "Dependencies installed successfully" "OK"
    }
}

# ============================================================
#  Step 4: Build EXE
# ============================================================
if ($buildSuccess) {
    Write-Host ""
    Write-Host "  ------------------------------------------------------------" -ForegroundColor DarkGray
    Write-Log "Step 4/5: Building EXE package..." "STEP"
    
    Write-Log "Running electron-builder (first build downloads Electron binary)..." "STEP"
    Write-Host ""
    
    $buildOutput = & pnpm run build 2>&1
    $buildExitCode = $LASTEXITCODE
    
    $buildOutput | ForEach-Object {
        $line = $_.ToString()
        if ($line -match "error|ERR|fail") {
            Write-Log $line "ERROR"
        } elseif ($line -match "warn|WARN") {
            Write-Log $line "WARN"
        } elseif ($line -match "building|packaging|creating") {
            Write-Log $line "STEP"
        } else {
            Write-Log $line "INFO"
        }
    }
    
    if ($buildExitCode -ne 0) {
        Write-Log "Build failed! Check build_log.txt for details" "ERROR"
        $buildSuccess = $false
    } else {
        Write-Log "EXE build complete!" "OK"
    }
}

# ============================================================
#  Step 5: Output results
# ============================================================
Write-Host ""
Write-Host "  ------------------------------------------------------------" -ForegroundColor DarkGray
Write-Log "Step 5/5: Checking output..." "STEP"

$distDir = Join-Path $ProjectDir "dist"
$exeFiles = @()
if (Test-Path $distDir) {
    $exeFiles = Get-ChildItem -Path $distDir -Filter "*.exe" -ErrorAction SilentlyContinue
}

Write-Host ""
if ($buildSuccess) {
    Write-Host "  ============================================================" -ForegroundColor Green
    Write-Host "                    BUILD SUCCESSFUL!" -ForegroundColor Green
    Write-Host "  ============================================================" -ForegroundColor Green
    Write-Host ""
    
    if ($exeFiles.Count -gt 0) {
        Write-Host "  Output files:" -ForegroundColor White
        foreach ($exe in $exeFiles) {
            $sizeMB = [math]::Round($exe.Length / 1MB, 1)
            Write-Host "    - $($exe.Name) ($sizeMB MB)" -ForegroundColor Yellow
        }
        Write-Host ""
        Write-Host "  Output directory: $distDir" -ForegroundColor Gray
    } else {
        Write-Host "  Output directory: $distDir" -ForegroundColor Gray
        Write-Host "  (Check directory for output files)" -ForegroundColor Gray
    }
    
    Write-Host ""
    Write-Host "  Log file: $LogFile" -ForegroundColor Gray
    Write-Host ""
    
    # Open dist directory
    if (Test-Path $distDir) {
        Start-Explorer $distDir
    }
} else {
    Write-Host "  ============================================================" -ForegroundColor Red
    Write-Host "                    BUILD FAILED" -ForegroundColor Red
    Write-Host "  ============================================================" -ForegroundColor Red
    Write-Host ""
    Write-Host "  Please check the log file for details:" -ForegroundColor Yellow
    Write-Host "  $LogFile" -ForegroundColor White
    Write-Host ""
    Write-Host "  Common issues:" -ForegroundColor Yellow
    Write-Host "    1. Network - Check internet connection or try different mirror" -ForegroundColor Gray
    Write-Host "    2. Permission - Run this script as Administrator" -ForegroundColor Gray
    Write-Host "    3. Disk space - Ensure at least 2GB free space" -ForegroundColor Gray
    Write-Host "    4. Antivirus - Temporarily disable antivirus software" -ForegroundColor Gray
    Write-Host ""
}

Write-Log "Build process finished at $(Get-Date). Success: $buildSuccess" "STEP"
Write-Host ""
Read-Host "  Press Enter to exit"
