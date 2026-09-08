param([switch]$AfterRestart)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin -and -not $AfterRestart) {
  Write-Host 'Loonto needs administrator rights to enable WSL 2.' -ForegroundColor Cyan
  $elevationArgs = '-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $PSCommandPath
  Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -ArgumentList $elevationArgs
  exit
}

if (-not $AfterRestart) {
  Write-Host 'Enabling Windows Subsystem for Linux...' -ForegroundColor Cyan
  & dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
  if ($LASTEXITCODE -ne 0) {
    throw 'Could not enable Windows Subsystem for Linux.'
  }

  Write-Host 'Enabling Virtual Machine Platform...' -ForegroundColor Cyan
  & dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
  if ($LASTEXITCODE -ne 0) {
    throw 'Could not enable Virtual Machine Platform.'
  }

  Write-Host ''
  Write-Host 'Stage 1 completed. Restart Windows now.' -ForegroundColor Green
  Write-Host 'After restart, run INSTALL_AFTER_RESTART.cmd.' -ForegroundColor Yellow
  exit
}

$installerPath = Join-Path $env:TEMP 'Docker Desktop Installer.exe'
$dockerUrl = 'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe'
$dockerCommand = Get-Command docker.exe -ErrorAction SilentlyContinue

if (-not $dockerCommand) {
  Write-Host 'Downloading Docker Desktop from docker.com...' -ForegroundColor Cyan
  Invoke-WebRequest -Uri $dockerUrl -OutFile $installerPath -UseBasicParsing
  Write-Host 'Starting Docker Desktop installer...' -ForegroundColor Cyan
  Start-Process -FilePath $installerPath -Wait -ArgumentList 'install --user --accept-license'
}

$dockerCli = Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\resources\bin\docker.exe'
if (-not (Test-Path -LiteralPath $dockerCli)) {
  $dockerCommand = Get-Command docker.exe -ErrorAction SilentlyContinue
  if (-not $dockerCommand) {
    throw 'Docker Desktop was not found. Start it manually and run this script again.'
  }
  $dockerCli = $dockerCommand.Source
}

Write-Host 'Start Docker Desktop and wait for Engine running.' -ForegroundColor Yellow
Read-Host 'Press Enter when Docker Desktop is ready'

Push-Location $projectRoot
try {
  & $dockerCli compose up -d
  if ($LASTEXITCODE -ne 0) {
    throw 'Could not start PostgreSQL and Redis.'
  }

  $envFile = Join-Path $projectRoot 'apps\backend-node\.env'
  if (-not (Test-Path -LiteralPath $envFile)) {
    $exampleFile = Join-Path $projectRoot 'apps\backend-node\.env.example'
    Copy-Item -LiteralPath $exampleFile -Destination $envFile
  }

  Write-Host ''
  Write-Host 'Loonto environment is ready.' -ForegroundColor Green
  Write-Host 'Start API: npm run dev:api'
  Write-Host 'Start frontend: npm run dev'
}
finally {
  Pop-Location
}
