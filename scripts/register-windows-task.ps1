param(
  [string]$TaskName = "TechnoFundaDailyScan",
  [string]$Time = "08:15"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Command = "Set-Location -LiteralPath '$ProjectRoot'; npm run scan -- --telegram"

$Action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -Command `"$Command`""

$Trigger = New-ScheduledTaskTrigger `
  -Weekly `
  -DaysOfWeek Monday, Tuesday, Wednesday, Thursday, Friday `
  -At $Time

$Principal = New-ScheduledTaskPrincipal `
  -UserId $env:USERNAME `
  -LogonType Interactive `
  -RunLevel LeastPrivilege

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $Action `
  -Trigger $Trigger `
  -Principal $Principal `
  -Description "Runs Techno Funda screener once each market morning." `
  -Force

Write-Host "Registered scheduled task '$TaskName' at $Time on weekdays."
