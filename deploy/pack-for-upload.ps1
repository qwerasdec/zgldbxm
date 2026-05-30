# 在项目根目录 PowerShell 执行：  .\deploy\pack-for-upload.ps1
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$out = Join-Path $root "deploy-upload.zip"
$temp = Join-Path $env:TEMP "meeting-upload-pack"
if (Test-Path $temp) { Remove-Item $temp -Recurse -Force }
New-Item -ItemType Directory -Path $temp -Force | Out-Null
robocopy $root $temp /E /XD node_modules .git /XF deploy-upload.zip | Out-Null
if (Test-Path $out) { Remove-Item $out -Force }
Compress-Archive -Path "$temp\*" -DestinationPath $out -Force
Remove-Item $temp -Recurse -Force
Write-Host "已生成: $out"
Write-Host "WinSCP 上传到 112.124.13.31:/opt/meeting-app/ 后，终端执行 unzip -o deploy-upload.zip"
