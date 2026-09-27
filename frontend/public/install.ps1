# Odysseus installer for Windows.
#
#   irm https://cross-vendor-afk-control-plane.vercel.app/install.ps1 | iex
#
# Installs the Odysseus gateway (the `odysseus` command) for the current user.
# No administrator rights, GitHub account or access token are needed.
#
# Optional environment variables:
#   ODYSSEUS_PACKAGE_URL   install from this package instead of the latest release
#   ODYSSEUS_PREFIX        install into this folder instead of npm's global folder
#   ODYSSEUS_NO_PROMPT=1   never ask questions (for scripted installs)
#
# The script is ASCII-only on purpose: Windows PowerShell 5.1 guesses the
# encoding of downloaded scripts, and anything else can arrive garbled.

& {
  # Not 'Stop': in Windows PowerShell 5.1 that turns any npm warning written
  # to stderr into a fatal error. Failures are checked via $LASTEXITCODE.
  $ErrorActionPreference = 'Continue'

  $WebUrl = 'https://cross-vendor-afk-control-plane.vercel.app'
  $PackageUrl = 'https://github.com/Harish-0412/cross-vendor-AFK-control-plane/releases/latest/download/odysseus-gateway.tgz'
  if ($env:ODYSSEUS_PACKAGE_URL) { $PackageUrl = $env:ODYSSEUS_PACKAGE_URL }
  $MinNodeMajor = 20
  $Interactive = -not $env:ODYSSEUS_NO_PROMPT -and [Environment]::UserInteractive

  function Write-Banner {
    $rows = @(
      '   ___  ____  __   __ ____  ____  _____ _   _ ____  ',
      '  / _ \|  _ \ \ \ / // ___|/ ___|| ____| | | / ___| ',
      ' | | | | | | | \ V / \___ \\___ \|  _| | | | \___ \ ',
      ' | |_| | |_| |  | |   ___) |___) | |___| |_| |___) |',
      '  \___/|____/   |_|  |____/|____/|_____|\___/|____/ '
    )
    $colors = @('Magenta', 'Magenta', 'Blue', 'Cyan', 'Cyan')
    Write-Host ''
    for ($i = 0; $i -lt $rows.Count; $i++) { Write-Host ('  ' + $rows[$i]) -ForegroundColor $colors[$i] }
    Write-Host ''
    Write-Host '   Go AFK. Your AI agents keep working.' -ForegroundColor White
    Write-Host '   Installing the Odysseus gateway for Windows' -ForegroundColor DarkGray
    Write-Host ''
  }

  function Write-Step([string]$text) { Write-Host '  > ' -ForegroundColor Magenta -NoNewline; Write-Host $text }
  function Write-Ok([string]$text) { Write-Host '  + ' -ForegroundColor Green -NoNewline; Write-Host $text }
  function Write-Note([string]$text) { Write-Host "    $text" -ForegroundColor DarkGray }
  function Write-Problem([string]$title, [string[]]$lines) {
    Write-Host ''
    Write-Host "  x $title" -ForegroundColor Red
    foreach ($line in $lines) { Write-Host "    $line" -ForegroundColor Gray }
    Write-Host ''
  }

  function Ask-YesNo([string]$question) {
    if (-not $Interactive) { return $false }
    try {
      $answer = Read-Host "  ? $question [Y/n]"
    } catch {
      return $false
    }
    return ($answer -eq '' -or $answer -match '^(y|yes)$')
  }

  function Update-SessionPath {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ';'
  }

  function Get-NodeMajor {
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $node) { return 0 }
    try {
      $version = & $node.Source -p 'process.versions.node'
      return [int]($version.Split('.')[0])
    } catch {
      return 0
    }
  }

  Write-Banner

  # -------------------------------------------------------------- Node.js
  Write-Step 'Checking for Node.js'
  $major = Get-NodeMajor
  if ($major -lt $MinNodeMajor) {
    if ($major -gt 0) {
      Write-Note "Node.js $major is installed, but Odysseus needs version $MinNodeMajor or newer."
    } else {
      Write-Note 'Node.js is not installed. Odysseus needs it to run.'
    }

    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if ($winget -and (Ask-YesNo 'Install Node.js LTS now with winget?')) {
      Write-Step 'Installing Node.js LTS (this can take a minute)'
      & $winget.Source install --id OpenJS.NodeJS.LTS --exact --silent --accept-source-agreements --accept-package-agreements | Out-Null
      Update-SessionPath
      $major = Get-NodeMajor
    }

    if ($major -lt $MinNodeMajor) {
      Write-Problem 'Node.js 20 or newer is required' @(
        'Install the LTS version from https://nodejs.org',
        'then open a new PowerShell window and run this installer again.'
      )
      return
    }
  }
  Write-Ok "Node.js $major found"

  $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (-not $npm) {
    Write-Problem 'npm was not found' @(
      'npm normally comes with Node.js. Reinstall Node.js from https://nodejs.org,',
      'then open a new PowerShell window and run this installer again.'
    )
    return
  }

  # -------------------------------------------------------------- package
  # npm.cmd, not npm: PowerShell's default script policy blocks npm.ps1.
  Write-Step 'Downloading and installing the Odysseus gateway'
  $npmArgs = @('install', '--global', $PackageUrl, '--no-fund', '--no-audit', '--loglevel=error')
  if ($env:ODYSSEUS_PREFIX) { $npmArgs += @('--prefix', $env:ODYSSEUS_PREFIX) }

  $output = & $npm.Source @npmArgs 2>&1
  if ($LASTEXITCODE -ne 0) {
    $text = ($output | Out-String)
    $hint = 'Check your internet connection and run this installer again.'
    if ($text -match 'ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN') {
      $hint = 'Could not reach GitHub to download the package. Check your internet connection, VPN or proxy, then try again.'
    } elseif ($text -match 'EPERM|EBUSY') {
      $hint = 'A file is in use. Stop any running "odysseus gateway" window, then try again.'
    } elseif ($text -match 'E404|404') {
      $hint = 'The package could not be found. Please report this at https://github.com/Harish-0412/cross-vendor-AFK-control-plane/issues'
    }
    Write-Problem 'The gateway could not be installed' @($hint, '', 'Details from npm:')
    $output | Select-Object -Last 8 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    return
  }

  $binDir = $env:ODYSSEUS_PREFIX
  if (-not $binDir) { $binDir = (& $npm.Source prefix --global).Trim() }
  $cmd = Join-Path $binDir 'odysseus.cmd'
  if (-not (Test-Path $cmd)) {
    Write-Problem 'The gateway was installed, but the odysseus command is missing' @("Expected it at $cmd")
    return
  }
  $version = (& $cmd --version).Trim()
  Write-Ok "Odysseus gateway $version installed"

  # -------------------------------------------------------------- command
  # With the Restricted or AllSigned policy PowerShell refuses odysseus.ps1,
  # the shim npm writes next to odysseus.cmd. Without the .ps1, PowerShell
  # runs the .cmd, which the policy does not apply to. No setting is changed.
  $policy = Get-ExecutionPolicy
  $shim = Join-Path $binDir 'odysseus.ps1'
  if (($policy -eq 'Restricted' -or $policy -eq 'AllSigned') -and (Test-Path $shim)) {
    Remove-Item $shim -Force
    Write-Ok 'Made the odysseus command work in PowerShell'
  }

  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $onPath = ($env:Path -split ';') -contains $binDir
  if (-not $onPath) {
    $env:Path = "$env:Path;$binDir"
    if ($env:ODYSSEUS_PREFIX) {
      Write-Note "Add $binDir to your PATH to run odysseus from any terminal."
    } elseif (-not (($userPath -split ';') -contains $binDir)) {
      [Environment]::SetEnvironmentVariable('Path', (@($userPath, $binDir) | Where-Object { $_ }) -join ';', 'User')
      Write-Ok 'Added the odysseus command to your PATH'
    }
  }

  # -------------------------------------------------------------- next
  Write-Host ''
  Write-Host '  Odysseus is installed.' -ForegroundColor Green
  Write-Host ''
  Write-Host '  Next steps' -ForegroundColor White
  Write-Host '    1. Sign in at ' -NoNewline; Write-Host $WebUrl -ForegroundColor Cyan
  Write-Host '    2. Pair this PC:        ' -NoNewline; Write-Host 'odysseus pair' -ForegroundColor Magenta
  Write-Host '    3. In your project:     ' -NoNewline; Write-Host 'odysseus gateway' -ForegroundColor Magenta
  Write-Host ''

  if (Ask-YesNo 'Pair this PC with your Odysseus account now?') {
    Write-Host ''
    & $cmd pair
    Write-Host ''
    Write-Host '  Now open a terminal in your project folder and run ' -NoNewline
    Write-Host 'odysseus gateway' -ForegroundColor Magenta
    Write-Host ''
  }
}
