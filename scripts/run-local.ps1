$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $project
$data = Join-Path $project 'data'
New-Item -ItemType Directory -Path $data -Force | Out-Null
$lock = $null
$children = @{}
try {
    try { $lock = [System.IO.File]::Open((Join-Path $data 'local-supervisor.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
    catch { exit 0 }
    $PID | Set-Content -LiteralPath (Join-Path $data 'local-supervisor.pid')
    $stopFile = Join-Path $data 'local.stop'
    if (Test-Path -LiteralPath $stopFile) { Remove-Item -LiteralPath $stopFile }
    $env:NODE_ENV = 'production'
    $nodePath = Join-Path $project '.tools\node.exe'
    if (!(Test-Path -LiteralPath $nodePath)) { $nodePath = (Get-Command node -ErrorAction Stop).Source }
    $services = @(@{ Name = 'bot'; Binary = $nodePath; Arguments = 'dist/index.js' })
    $caddyConfig = Join-Path $data 'Caddyfile.local'
    if (Test-Path -LiteralPath $caddyConfig) {
        $services += @{ Name = 'https'; Binary = (Join-Path $project '.tools\caddy.exe'); Arguments = 'run --config "' + $caddyConfig + '" --adapter caddyfile' }
    }
    foreach ($service in $services) { if (!(Test-Path -LiteralPath $service.Binary)) { throw "Missing runtime: $($service.Binary)" } }
    while (!(Test-Path -LiteralPath $stopFile)) {
        foreach ($service in $services) {
            $child = $children[$service.Name]
            if (!$child -or $child.HasExited) {
                if ($child) { $child.Dispose() }
                $children[$service.Name] = Start-Process -FilePath $service.Binary -ArgumentList $service.Arguments -WorkingDirectory $project -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $data "local-$($service.Name).stdout.log") -RedirectStandardError (Join-Path $data "local-$($service.Name).stderr.log")
            }
        }
        Start-Sleep -Seconds 5
    }
} finally {
    foreach ($child in $children.Values) {
        if (!$child.HasExited) { & taskkill.exe /PID $child.Id /T /F | Out-Null }
        $child.Dispose()
    }
    if ($lock) {
        $lock.Dispose()
        Remove-Item -LiteralPath (Join-Path $data 'local-supervisor.pid') -ErrorAction SilentlyContinue
    }
}
