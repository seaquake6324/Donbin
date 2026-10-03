$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot -Parent
$runner = Join-Path $PSScriptRoot 'run-local.ps1'
$pidFile = Join-Path $project 'data\local-supervisor.pid'
if (Test-Path -LiteralPath $pidFile) {
    $runnerId = 0
    if ([int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(), [ref]$runnerId)) {
        $existing = Get-CimInstance Win32_Process -Filter "ProcessId=$runnerId"
        if ($existing -and $existing.CommandLine -and $existing.CommandLine.Contains($runner)) { Write-Output 'Donbin is already running.'; exit 0 }
    }
}
Start-Process powershell.exe -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "' + $runner + '"') -WorkingDirectory $project -WindowStyle Hidden
Write-Output 'Donbin started. Logs: data/local-bot.stderr.log and data/local-https.stderr.log'
