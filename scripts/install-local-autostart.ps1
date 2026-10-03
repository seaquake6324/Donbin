$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot -Parent
$runner = Join-Path $PSScriptRoot 'run-local.ps1'
$account = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -File "' + $runner + '"') -WorkingDirectory $project
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $account
$principal = New-ScheduledTaskPrincipal -UserId $account -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'Donbin Local' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Start Donbin and its HTTPS website at Windows login.' -Force | Out-Null
Write-Output 'Donbin will start when this Windows user signs in.'
