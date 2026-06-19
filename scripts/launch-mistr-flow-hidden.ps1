$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$LogPath = Join-Path $RepoRoot 'mistr-flow-launch.log'
$ElectronPath = Join-Path $RepoRoot 'node_modules\electron\dist\electron.exe'

Set-Location $RepoRoot

if (-not (Test-Path $ElectronPath)) {
  npm install *>> $LogPath
}

npm run start *>> $LogPath
