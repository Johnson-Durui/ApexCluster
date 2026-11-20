# 环境探测（Windows PowerShell）
#   .\scripts\probe-windows.ps1              只读检查：不调用模型、不产生费用
#   .\scripts\probe-windows.ps1 -Live        最小真实调用（消耗订阅额度），默认测 claude、astra、sol:max、sol:ultra
#   .\scripts\probe-windows.ps1 -Live -Targets "claude,sol:max"
param(
  [switch]$Live,
  [string]$Targets = "claude,astra,sol:max,sol:ultra"
)
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location (Split-Path $PSScriptRoot -Parent)

Write-Host "PowerShell $($PSVersionTable.PSVersion)  $([System.Environment]::OSVersion.VersionString)"
foreach ($cmd in @("node", "npm", "git", "claude", "codex")) {
  $c = Get-Command $cmd -ErrorAction SilentlyContinue
  if ($c) { Write-Host ("{0,-7} {1}" -f $cmd, $c.Source) } else { Write-Host ("{0,-7} (未找到)" -f $cmd) }
}

if ($Live) {
  Write-Host "`n即将进行真实调用，会消耗订阅额度：$Targets"
  $answer = Read-Host "确认继续？输入 yes"
  if ($answer -ne "yes") { Write-Host "已取消"; exit 2 }
  npx tsx src/cli/probe.ts "--live=$Targets" --yes
} else {
  npx tsx src/cli/probe.ts
}
exit $LASTEXITCODE
