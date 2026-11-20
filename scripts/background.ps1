param(
    [ValidateSet('Install', 'Run', 'Status', 'Stop', 'Uninstall')]
    [string]$Action = 'Status',
    [string]$NodePath,
    [int]$AdoptExistingPid = 0
)

# Windows PowerShell 5.1 compatible. No passwords or model calls are involved.
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$hashAlgorithm = [System.Security.Cryptography.SHA256]::Create()
try {
    $projectHash = [BitConverter]::ToString($hashAlgorithm.ComputeHash(
        [Text.Encoding]::UTF8.GetBytes($projectDir.ToLowerInvariant())
    )).Replace('-', '').Substring(0, 12)
} finally { $hashAlgorithm.Dispose() }
$taskName = 'DualModelWorkbench-' + $projectHash
$logDir = Join-Path $projectDir 'work\background-service'
$adoptionFile = Join-Path $logDir 'adopt-once.json'
$configFile = Join-Path $projectDir 'config\workbench.config.json'
$config = if (Test-Path -LiteralPath $configFile) {
    Get-Content -Raw -LiteralPath $configFile -Encoding UTF8 | ConvertFrom-Json
} else { $null }
$port = if ($config -and $config.port) { [int]$config.port } else { 5170 }
$dataDir = if ($config -and $config.dataDir) {
    if ([IO.Path]::IsPathRooted($config.dataDir)) { [IO.Path]::GetFullPath($config.dataDir) }
    else { [IO.Path]::GetFullPath((Join-Path $projectDir $config.dataDir)) }
} else { Join-Path $projectDir 'data' }

function Assert-Idle {
    $runsDir = Join-Path $dataDir 'runs'
    if (!(Test-Path -LiteralPath $runsDir)) { return }
    foreach ($directory in Get-ChildItem -LiteralPath $runsDir -Directory) {
        $runFile = Join-Path $directory.FullName 'run.json'
        if (!(Test-Path -LiteralPath $runFile)) { continue }
        $run = Get-Content -Raw -LiteralPath $runFile -Encoding UTF8 | ConvertFrom-Json
        $activeTasks = @($run.tasks | Where-Object { $_.status -in @('queued', 'running') })
        $activeJobs = @($run.jobs | Where-Object { $_.status -in @('preparing', 'running', 'verifying') })
        if ($activeTasks.Count -or $activeJobs.Count) {
            throw ('Active model work in ' + $directory.Name + '; stop it in the workbench first.')
        }
    }
}

if ($Action -eq 'Status') {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    [pscustomobject]@{
        TaskName = $taskName
        Installed = [bool]$task
        State = if ($task) { [string]$task.State } else { 'NotInstalled' }
        Url = "http://127.0.0.1:$port/"
        Logs = $logDir
    } | ConvertTo-Json
    return
}

if ($Action -in @('Stop', 'Uninstall')) {
    Assert-Idle
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task) {
        Disable-ScheduledTask -TaskName $taskName | Out-Null
        Stop-ScheduledTask -TaskName $taskName
        $runtimeFile = Join-Path $logDir 'runtime.json'
        if (Test-Path -LiteralPath $runtimeFile) {
            $runtime = Get-Content -Raw -LiteralPath $runtimeFile -Encoding UTF8 | ConvertFrom-Json
            if ($runtime.ServerStartedAtTicks) {
                $listener = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $port -State Listen -ErrorAction SilentlyContinue
                $candidate = Get-Process -Id $runtime.ServerPid -ErrorAction SilentlyContinue
                if ($listener -and $candidate -and $listener.OwningProcess -eq $runtime.ServerPid -and
                    $candidate.StartTime.ToUniversalTime().Ticks -eq $runtime.ServerStartedAtTicks) {
                    & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID ([string]$runtime.ServerPid) /T /F | Out-Null
                    if ($LASTEXITCODE -ne 0 -and (Get-Process -Id $runtime.ServerPid -ErrorAction SilentlyContinue)) {
                        throw 'The recorded server process tree could not be stopped.'
                    }
                }
            }
        }
        if ($Action -eq 'Uninstall') {
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        }
    }
    Write-Output 'Background task stopped. Project data and logs were retained.'
    return
}

if (!$NodePath) { $NodePath = (Get-Command node.exe -ErrorAction Stop).Source }
$NodePath = (Get-Item -LiteralPath $NodePath -ErrorAction Stop).FullName
& $NodePath -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)"
if ($LASTEXITCODE -ne 0) { throw 'Node.js 22.12 or newer is required.' }
foreach ($required in @('node_modules\tsx\dist\loader.mjs', 'web\dist\index.html')) {
    if (!(Test-Path -LiteralPath (Join-Path $projectDir $required))) {
        throw ('Missing ' + $required + '. Install dependencies and build the web app first.')
    }
}
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

if ($Action -eq 'Install') {
    $powershellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' +
        $PSCommandPath + '" -Action Run -NodePath "' + $NodePath + '"'
    $taskAction = New-ScheduledTaskAction -Execute $powershellPath -Argument $arguments -WorkingDirectory $projectDir
    $logon = New-ScheduledTaskTrigger -AtLogOn -User $identity
    # An indefinite minute trigger also recovers a killed wrapper or a zero exit.
    $watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries -DontStopOnIdleEnd -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -Hidden
    $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
    $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existing -and @($existing.Actions | Where-Object { $_.Arguments -eq $arguments }).Count -ne 1) {
        throw ('Refusing to overwrite an unrelated task: ' + $taskName)
    }
    if ($existing -and $existing.State -eq 'Running') {
        throw 'Task is already running. Stop it before reinstalling.'
    }
    $adoption = $null
    if ($AdoptExistingPid) {
        $listener = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $port -State Listen -ErrorAction Stop
        if ($listener.OwningProcess -ne $AdoptExistingPid) { throw 'The adoption PID does not own the configured port.' }
        $candidate = Get-Process -Id $AdoptExistingPid -ErrorAction Stop
        $adoption = @{ ServerPid = $candidate.Id; ServerStartedAtTicks = $candidate.StartTime.ToUniversalTime().Ticks }
    }
    Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger @($logon, $watchdog) `
        -Settings $settings -Principal $principal -Description ('Local workbench: ' + $projectDir) -Force | Out-Null
    Export-ScheduledTask -TaskName $taskName | Set-Content -LiteralPath (Join-Path $logDir 'task.xml') -Encoding Unicode
    if ($adoption) {
        $adoption | ConvertTo-Json | Set-Content -LiteralPath $adoptionFile -Encoding UTF8
    } elseif (Test-Path -LiteralPath $adoptionFile) { Remove-Item -LiteralPath $adoptionFile }
    Start-ScheduledTask -TaskName $taskName
    Write-Output ('Installed and started: ' + $taskName)
    return
}

# One wrapper owns or observes one server. Adoption preserves in-flight model work.
$mutex = New-Object Threading.Mutex($false, ('Local\' + $taskName))
$ownsMutex = $false
try {
    try { $ownsMutex = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (!$ownsMutex) { throw 'The background wrapper is already running.' }
    $client = New-Object Net.Sockets.TcpClient
    $occupied = $false
    try {
        $client.Connect('127.0.0.1', $port)
        $occupied = $true
    } catch [Net.Sockets.SocketException] {
        if ($_.Exception.SocketErrorCode -ne [Net.Sockets.SocketError]::ConnectionRefused) { throw }
    } finally { $client.Dispose() }
    if ($occupied) {
        $runtimeFile = Join-Path $logDir 'runtime.json'
        $adoption = if (Test-Path -LiteralPath $adoptionFile) {
            Get-Content -Raw -LiteralPath $adoptionFile -Encoding UTF8 | ConvertFrom-Json
        } elseif (Test-Path -LiteralPath $runtimeFile) {
            # A killed wrapper can leave its own server alive. Recognize that exact
            # process by PID and creation time instead of launching a duplicate.
            Get-Content -Raw -LiteralPath $runtimeFile -Encoding UTF8 | ConvertFrom-Json
        } else { $null }
        if (!$adoption -or !$adoption.ServerStartedAtTicks) {
            throw ('Port ' + $port + ' is occupied. Existing service was left untouched; explicit adoption is required.')
        }
        $listener = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $port -State Listen -ErrorAction Stop
        if ($listener.OwningProcess -ne $adoption.ServerPid) {
            throw ('Port ' + $port + ' is occupied by a different process. Adoption refused.')
        }
        $adopted = Get-Process -Id $adoption.ServerPid -ErrorAction Stop
        if ($adopted.StartTime.ToUniversalTime().Ticks -ne $adoption.ServerStartedAtTicks) {
            throw ('Port ' + $port + ' is occupied by a reused PID. Adoption refused.')
        }
        $null = $adopted.Handle
        $health = $null
        try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 3 } catch { }
        if (!$health -or $health.ok -ne $true -or $health.mode -ne 'local') {
            throw ('Port ' + $port + ' is occupied by another service. It was left untouched.')
        }
        [pscustomobject]@{ WrapperPid = $PID; ServerPid = $adopted.Id; ServerStartedAtTicks = $adoption.ServerStartedAtTicks; Adopted = $true; StartedAt = (Get-Date).ToString('o') } |
            ConvertTo-Json | Set-Content -LiteralPath (Join-Path $logDir 'runtime.json') -Encoding UTF8
        if (Test-Path -LiteralPath $adoptionFile) { Remove-Item -LiteralPath $adoptionFile }
        Add-Content -LiteralPath (Join-Path $logDir 'lifecycle.log') -Encoding UTF8 `
            -Value ((Get-Date).ToString('o') + ' observing existing server: ' + $adopted.Id)
        $adopted.WaitForExit()
    }
    if (Test-Path -LiteralPath $adoptionFile) { Remove-Item -LiteralPath $adoptionFile }
    $stamp = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + $PID
    $stdout = Join-Path $logDir ($stamp + '.stdout.log')
    $stderr = Join-Path $logDir ($stamp + '.stderr.log')
    $server = Start-Process -FilePath $NodePath -ArgumentList @('--import', './node_modules/tsx/dist/loader.mjs', 'src\server\main.ts') `
        -WorkingDirectory $projectDir -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    $null = $server.Handle
    [pscustomobject]@{ WrapperPid = $PID; ServerPid = $server.Id; ServerStartedAtTicks = $server.StartTime.ToUniversalTime().Ticks; Adopted = $false; StartedAt = (Get-Date).ToString('o'); Stdout = $stdout; Stderr = $stderr } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $logDir 'runtime.json') -Encoding UTF8
    $server.WaitForExit()
    $server.Refresh()
    Add-Content -LiteralPath (Join-Path $logDir 'lifecycle.log') -Encoding UTF8 `
        -Value ((Get-Date).ToString('o') + ' server exited: ' + $server.ExitCode)
} catch {
    Add-Content -LiteralPath (Join-Path $logDir 'lifecycle.log') -Encoding UTF8 `
        -Value ((Get-Date).ToString('o') + ' ' + $_.Exception.Message)
} finally {
    if ($ownsMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
# A server exit is unexpected unless the scheduled task is explicitly disabled.
exit 1
