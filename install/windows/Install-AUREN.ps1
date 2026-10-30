# Installs what an AUREN node needs on Windows 10/11 and (optionally) keeps it running.
#   Right-click this file -> "Run with PowerShell".
# It: (1) installs Node.js LTS with winget if missing, (2) adds a Start Menu shortcut "AUREN Node",
#     (3) optionally starts the node automatically when you sign in. Nothing is sent anywhere.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

function Has-Node { $n = Get-Command node -ErrorAction SilentlyContinue; if (-not $n) { return $false }; return ([int]((node -v) -replace '^v(\d+)\..*', '$1') -ge 20) }

if (-not (Has-Node)) {
  Write-Host 'Node.js 20+ not found.'
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    $ans = Read-Host 'Install Node.js LTS now with winget? [Y/n]'
    if ($ans -eq '' -or $ans -match '^[Yy]') { winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements }
    Write-Host 'Close this window and run the installer again so Windows picks up Node.js.'
    Read-Host 'Press Enter'; exit
  } else { Write-Host 'Install Node.js LTS from https://nodejs.org, then run this again.'; Read-Host 'Press Enter'; exit 1 }
}

$sm = [Environment]::GetFolderPath('Programs')
$lnk = Join-Path $sm 'AUREN Node.lnk'
$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut($lnk); $s.TargetPath = Join-Path $PSScriptRoot 'Run-AUREN-Node.cmd'; $s.WorkingDirectory = $root; $s.Description = 'Run an AUREN node'; $s.Save()
Write-Host "Created Start Menu shortcut: AUREN Node"

$auto = Read-Host 'Start the testnet node automatically when you sign in? [y/N]'
if ($auto -match '^[Yy]') {
  $cmd = "`"$((Get-Command node).Source)`" `"$root\bin\auren.js`" join testnet"
  schtasks /Create /F /TN 'AUREN Node (testnet)' /SC ONLOGON /TR $cmd | Out-Null
  Write-Host 'Done. The node will start at sign-in. Remove it later with:  schtasks /Delete /TN "AUREN Node (testnet)" /F'
}
Write-Host "`nAll set. Double-click 'AUREN Node' in the Start Menu to run a node."
Read-Host 'Press Enter'
