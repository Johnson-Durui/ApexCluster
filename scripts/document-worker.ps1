[CmdletBinding()]
param(
  [ValidateSet('build', 'up', 'down', 'health', 'smoke', 'logs')]
  [string]$Action = 'health',
  [int]$Port = 0
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$ComposeFile = Join-Path $ProjectRoot 'compose.yaml'
$SmokeScript = Join-Path $ProjectRoot 'tests\document-worker_smoke.py'

function Resolve-ConfiguredPort {
  param([int]$RequestedPort)

  if ($RequestedPort -lt 0 -or $RequestedPort -gt 65535) { throw 'Port must be 0 or an integer from 1 through 65535.' }
  if ($RequestedPort -ne 0) { return $RequestedPort }

  $SettingsFile = Join-Path $ProjectRoot 'config\chat.config.json'
  if (-not (Test-Path -LiteralPath $SettingsFile -PathType Leaf)) { return 18781 }
  # Windows PowerShell 5.1 reads files as the ANSI code page unless told otherwise; config is UTF-8 and may hold Chinese paths.
  $Settings = Get-Content -Raw -Encoding UTF8 -LiteralPath $SettingsFile | ConvertFrom-Json
  if (-not ($Settings.dataRoot -is [string]) -or [string]::IsNullOrWhiteSpace($Settings.dataRoot)) { return 18781 }
  $DataRoot = if ([System.IO.Path]::IsPathRooted($Settings.dataRoot)) {
    [System.IO.Path]::GetFullPath($Settings.dataRoot)
  } else {
    [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $Settings.dataRoot))
  }
  $ServicesFile = Join-Path $DataRoot 'config\chat-services.json'
  if (-not (Test-Path -LiteralPath $ServicesFile -PathType Leaf)) { return 18781 }
  $Services = Get-Content -Raw -Encoding UTF8 -LiteralPath $ServicesFile | ConvertFrom-Json
  $UrlText = $Services.documentWorker.url
  if (-not ($UrlText -is [string]) -or [string]::IsNullOrWhiteSpace($UrlText)) { return 18781 }

  $Uri = $null
  if (-not [System.Uri]::TryCreate($UrlText, [System.UriKind]::Absolute, [ref]$Uri)) { throw 'documentWorker.url must be an absolute local HTTP root URL.' }
  $LocalHosts = @('127.0.0.1', 'localhost', '::1', '[::1]')
  if ($Uri.Scheme -ne 'http' -or $Uri.Host -notin $LocalHosts -or $Uri.UserInfo -or $Uri.Query -or $Uri.Fragment -or $Uri.AbsolutePath -ne '/') {
    throw 'documentWorker.url must be a local HTTP root URL without credentials, path, query, or fragment.'
  }
  if ($Uri.Port -lt 1 -or $Uri.Port -gt 65535) { throw 'documentWorker.url must use a valid TCP port.' }
  return $Uri.Port
}

$Port = Resolve-ConfiguredPort $Port
$ComposeProject = if ($Port -eq 18781) { 'dual-model-workbench' } else { "dual-model-workbench-docs-$Port" }
$BaseUrl = "http://127.0.0.1:$Port"
$PreviousPort = [System.Environment]::GetEnvironmentVariable('DOCUMENT_WORKER_PORT', 'Process')
$PreviousUrl = [System.Environment]::GetEnvironmentVariable('DOCUMENT_WORKER_URL', 'Process')

try {
  $env:DOCUMENT_WORKER_PORT = [string]$Port
  $env:DOCUMENT_WORKER_URL = "$BaseUrl/v1/jobs"
  $LASTEXITCODE = 0

  if ($Action -in @('build','up','down','logs')) {
    $DockerCommand = Get-Command docker -ErrorAction SilentlyContinue
    $DockerCli = if ($DockerCommand) { $DockerCommand.Source } else { Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\resources\bin\docker.exe' }
    if (-not (Test-Path -LiteralPath $DockerCli -PathType Leaf)) { $DockerCli = Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin\docker.exe' }
    if (-not (Test-Path -LiteralPath $DockerCli -PathType Leaf)) { throw 'Docker Desktop not found. Install and start Docker Desktop first.' }
  }

  switch ($Action) {
    'build' { & $DockerCli compose -p $ComposeProject -f $ComposeFile build document-worker }
    'up' { & $DockerCli compose -p $ComposeProject -f $ComposeFile up -d --build document-worker-gateway }
    'down' { & $DockerCli compose -p $ComposeProject -f $ComposeFile down --remove-orphans }
    'health' { Invoke-RestMethod -Uri "$BaseUrl/health" -TimeoutSec 5 | ConvertTo-Json -Depth 6 }
    'smoke' {
      $Python = Get-Command python -ErrorAction SilentlyContinue
      if ($Python) {
        & $Python.Source -B $SmokeScript
      } else {
        $PythonLauncher = Get-Command py -ErrorAction SilentlyContinue
        if (-not $PythonLauncher) { throw 'Python 3 was not found on PATH.' }
        & $PythonLauncher.Source -3 -B $SmokeScript
      }
    }
    'logs' { & $DockerCli compose -p $ComposeProject -f $ComposeFile logs --tail 200 document-worker }
  }

  if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) {
    throw "document-worker action failed with exit code $LASTEXITCODE"
  }
} finally {
  [System.Environment]::SetEnvironmentVariable('DOCUMENT_WORKER_PORT', $PreviousPort, 'Process')
  [System.Environment]::SetEnvironmentVariable('DOCUMENT_WORKER_URL', $PreviousUrl, 'Process')
}
