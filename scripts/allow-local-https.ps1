$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot -Parent
$binary = Join-Path $project '.tools\caddy.exe'
if (!(Test-Path -LiteralPath $binary)) { throw 'Install .tools/caddy.exe before running this script.' }
$ruleName = 'Donbin-HTTPS'
if (Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue) { Remove-NetFirewallRule -Name $ruleName }
New-NetFirewallRule -Name $ruleName -DisplayName 'Donbin HTTPS website' -Direction Inbound -Action Allow -Program $binary -Protocol TCP -LocalPort 80,443 -Profile Any | Out-Null
Write-Output 'Caddy may receive TCP connections on ports 80 and 443. Bot port 3000 stays local.'
