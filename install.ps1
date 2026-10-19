# trenchscope installer for Windows. One line, in PowerShell:
#   irm https://raw.githubusercontent.com/trenchscopeapp/trenchscope/main/install.ps1 | iex
#
# User-level, no admin, no PATH edits. It:
#   1. checks for Node 22.18 or newer, and offers to install Node LTS with winget when it is missing;
#   2. installs the `trenchscope` npm package globally when it is published,
#      otherwise downloads the source into ~/.dexterm/app and links its workspace packages
#      (no third-party runtime dependencies, so no npm registry is needed);
#   3. puts `trenchscope` (and the old `dexterm` alias) next to npm's own global commands, which are already on PATH.
# Re-running is safe. TRENCHSCOPE_REPO / TRENCHSCOPE_REF pick another fork or branch;
# TRENCHSCOPE_SOURCE=1 skips npm and installs from source; TRENCHSCOPE_ZIP (a local zip), DEXTERM_PREFIX and
# TRENCHSCOPE_BIN redirect the download, the app folder and the launchers (used by the install test).
$ErrorActionPreference = 'Stop'

function Say($m) { Write-Host "  $m" }
function Ok($m) { Write-Host '  ' -NoNewline; Write-Host 'ok' -ForegroundColor Green -NoNewline; Write-Host " $m" }
function Warn($m) { Write-Host '  ' -NoNewline; Write-Host '!' -ForegroundColor Yellow -NoNewline; Write-Host " $m" }
function Die($m) { Write-Host "x $m" -ForegroundColor Red; throw $m }

Write-Host 'Installing trenchscope' -ForegroundColor White

# --- 1. Node -----------------------------------------------------------------
function Test-Node {
  $n = Get-Command node -ErrorAction SilentlyContinue
  if (-not $n) { return $false }
  $v = (& node -v) -replace '^v', ''
  $p = $v.Split('.') | ForEach-Object { [int]$_ }
  return ($p[0] -gt 22) -or ($p[0] -eq 22 -and $p[1] -ge 18)
}
if (-not (Test-Node)) {
  Warn 'trenchscope needs Node 22.18 or newer, and none was found.'
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    $a = Read-Host '  Install Node LTS with winget now? [Y/n]'
    if ($a -match '^(n|no)$') { Die 'install Node 22.18+ from https://nodejs.org and run this again.' }
    winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not (Test-Node)) { Die 'Node was installed but is not on PATH yet. Open a new terminal and run this again.' }
  } else {
    Die 'install Node 22.18+ from https://nodejs.org and run this again.'
  }
}
Ok "Node $(node -v)"

$npmBin = if ($env:TRENCHSCOPE_BIN) { $env:TRENCHSCOPE_BIN } else { (& npm prefix -g).Trim() }

# --- 2a. the npm package -------------------------------------------------------
$published = $false
if ($env:TRENCHSCOPE_SOURCE -ne '1') {
  & npm view trenchscope version *> $null
  $published = ($LASTEXITCODE -eq 0)
}
if ($published) {
  Say 'installing the trenchscope package from npm'
  & npm install -g trenchscope
  if ($LASTEXITCODE -ne 0) { Die 'npm install -g trenchscope failed (see above).' }
  Ok "installed trenchscope $(& npm view trenchscope version)"
} else {
  # --- 2b. from source ----------------------------------------------------------
  $repo = if ($env:TRENCHSCOPE_REPO) { $env:TRENCHSCOPE_REPO } else { 'trenchscopeapp/trenchscope' }
  $ref = if ($env:TRENCHSCOPE_REF) { $env:TRENCHSCOPE_REF } else { 'main' }
  $home_ = if ($env:DEXTERM_PREFIX) { $env:DEXTERM_PREFIX } else { Join-Path $HOME '.dexterm' }
  $app = Join-Path $home_ 'app'
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("trenchscope-" + [guid]::NewGuid())
  New-Item -ItemType Directory -Force $tmp | Out-Null
  Say "downloading $repo@$ref"
  if ($env:TRENCHSCOPE_ZIP) { Copy-Item $env:TRENCHSCOPE_ZIP (Join-Path $tmp 'src.zip') }
  else { Invoke-WebRequest "https://codeload.github.com/$repo/zip/$ref" -OutFile (Join-Path $tmp 'src.zip') -UseBasicParsing }
  Expand-Archive (Join-Path $tmp 'src.zip') -DestinationPath $tmp -Force
  $src = Get-ChildItem $tmp -Directory | Select-Object -First 1
  if (Test-Path $app) { Remove-Item $app -Recurse -Force }
  New-Item -ItemType Directory -Force $home_ | Out-Null
  Move-Item $src.FullName $app
  Remove-Item $tmp -Recurse -Force
  # link every workspace package except cli into node_modules/@dexterm (junctions need no admin)
  $mods = Join-Path $app 'node_modules\@dexterm'
  New-Item -ItemType Directory -Force $mods | Out-Null
  Get-ChildItem (Join-Path $app 'packages') -Directory | Where-Object { $_.Name -ne 'cli' -and (Test-Path (Join-Path $_.FullName 'package.json')) } | ForEach-Object {
    New-Item -ItemType Junction -Path (Join-Path $mods $_.Name) -Target $_.FullName -Force | Out-Null
  }
  Ok "source in $app"
  # --- 3. launchers next to npm's global commands (already on PATH) ------------
  foreach ($name in 'trenchscope', 'dexterm') {
    $js = Join-Path $app "packages\cli\bin\$name.mjs"
    Set-Content -Path (Join-Path $npmBin "$name.cmd") -Value "@echo off`r`nnode `"$js`" %*" -Encoding ascii
    Set-Content -Path (Join-Path $npmBin "$name.ps1") -Value "& node `"$js`" @args" -Encoding ascii
  }
  Ok "wrote trenchscope and dexterm into $npmBin"
}

Write-Host ''
Write-Host 'Next: ' -NoNewline -ForegroundColor White
Write-Host 'run "trenchscope doctor" to check your machine, then "trenchscope" to start (open a new terminal first if the command is not found).'
