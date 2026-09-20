#!/usr/bin/env pwsh
# Build and deploy Jarvis to jarvis.eloquentservice.com.
# nginx serves client/dist from the webroot; pm2 runs the API on 127.0.0.1:3001.
# Usage: ./deploy.ps1
$ErrorActionPreference = "Stop"
# Windows PowerShell pipes a UTF-8 BOM into native commands, which the remote
# bash reads as part of the first command. Send plain UTF-8 instead.
$OutputEncoding = New-Object System.Text.UTF8Encoding $false

$root    = $PSScriptRoot
$server  = "root@64.227.153.90"
$webroot = "/var/www/jarvis"
$key     = "$env:USERPROFILE\.ssh\id_ed25519"

Write-Host "==> Building client" -ForegroundColor Cyan
Push-Location $root
try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed (exit $LASTEXITCODE)" }
} finally { Pop-Location }

if (-not (Test-Path "$root\client\dist\index.html")) { throw "Build output missing at client\dist" }

# One tarball rather than per-file scp: the remote side clears and extracts in the
# same step, so a hung transfer can never leave a half-empty webroot behind.
# node_modules, data/ and .env are deliberately excluded — the server owns those.
Write-Host "==> Packaging" -ForegroundColor Cyan
$tar = Join-Path $env:TEMP "jarvis-app.tar.gz"
if (Test-Path $tar) { Remove-Item $tar -Force }
Push-Location $root
try {
    tar -czf $tar server scripts tests package.json package-lock.json README.md client/dist
    if ($LASTEXITCODE -ne 0) { throw "tar failed (exit $LASTEXITCODE)" }
} finally { Pop-Location }

Write-Host "==> Uploading to $server`:$webroot" -ForegroundColor Cyan
scp -i $key -o BatchMode=yes -o ConnectTimeout=15 $tar "$server`:/tmp/jarvis-app.tar.gz"
if ($LASTEXITCODE -ne 0) { throw "scp failed" }

$remote = @'
set -e
cd /var/www/jarvis
rm -rf server scripts tests client package.json package-lock.json README.md
tar -xzf /tmp/jarvis-app.tar.gz -C /var/www/jarvis
rm -f /tmp/jarvis-app.tar.gz
# onnxruntime otherwise pulls ~1GB of CUDA runtimes onto a droplet with no GPU
export ONNXRUNTIME_NODE_INSTALL_CUDA=skip
npm install --omit=dev --no-audit --no-fund --onnxruntime-node-install-cuda=skip
# onnxruntime-node ships prebuilt binaries for every platform; the win32 and darwin
# sets are ~220MB of dead weight on a Linux droplet with an 8.7GB disk.
rm -rf node_modules/onnxruntime-node/bin/napi-v6/win32 node_modules/onnxruntime-node/bin/napi-v6/darwin
pm2 restart jarvis --update-env
'@
# Shipped as a file rather than piped: Windows PowerShell would send it with a
# UTF-8 BOM and CRLF line endings, both of which break bash on the first line.
$sh = Join-Path $env:TEMP "jarvis-remote.sh"
[System.IO.File]::WriteAllText($sh, $remote.Replace("`r`n", "`n"), (New-Object System.Text.UTF8Encoding $false))
scp -i $key -o BatchMode=yes $sh "$server`:/tmp/jarvis-remote.sh"
if ($LASTEXITCODE -ne 0) { throw "scp of deploy script failed" }
ssh -i $key -o BatchMode=yes $server "bash /tmp/jarvis-remote.sh && rm -f /tmp/jarvis-remote.sh"
if ($LASTEXITCODE -ne 0) { throw "remote deploy failed" }
Remove-Item $tar, $sh -Force

Write-Host "==> Verifying" -ForegroundColor Cyan
Start-Sleep -Seconds 6
$code = curl.exe -s -o NUL -w "%{http_code}" https://jarvis.eloquentservice.com/
if ($code -ne "200") { throw "site returned HTTP $code" }
curl.exe -s https://jarvis.eloquentservice.com/api/auth/me
Write-Host "`n==> Done - https://jarvis.eloquentservice.com" -ForegroundColor Green
