$project = Split-Path $PSScriptRoot -Parent
$stopFile = Join-Path $project 'data\local.stop'
$pidFile = Join-Path $project 'data\local-supervisor.pid'
New-Item -ItemType File -Path $stopFile -Force | Out-Null
for ($attempt = 0; $attempt -lt 15; $attempt++) {
    if (!(Test-Path -LiteralPath $pidFile)) { Write-Output 'Donbin stopped.'; exit 0 }
    Start-Sleep -Seconds 1
}
throw 'Supervisor did not stop. Inspect data/local-supervisor.pid before stopping any process manually.'
