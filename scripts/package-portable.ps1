param(
    [Parameter(Mandatory=$true)][string]$OutputDirectory,
    [Parameter(Mandatory=$true)][string]$NodePath,
    [switch]$IncludeData,
    [switch]$ChatCandidate,
    [int]$ChatPort = 0,
    [string]$ChatStatusFile,
    [string]$ChatDataRoot,
    [string]$UpgradeFromDirectory,
    [switch]$NativeDesktop,
    [string]$WebView2SdkDirectory
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$buildRoot = Join-Path $projectRoot 'work\desktop-build'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw '.NET Framework C# compiler not found' }
if (Test-Path -LiteralPath $OutputDirectory) { throw 'OutputDirectory already exists; select a new folder to preserve existing data.' }
if ($IncludeData -and $UpgradeFromDirectory) { throw 'IncludeData and UpgradeFromDirectory cannot be used together.' }
$resolvedNode = (Resolve-Path -LiteralPath $NodePath).Path
# No embedded double quotes: Windows PowerShell 5.1 strips them when passing arguments to native programs.
& $resolvedNode -e 'if (parseInt(process.versions.node, 10) < 22) process.exit(1)'
if ($LASTEXITCODE -ne 0) { throw 'Node 22 or later is required' }
New-Item -ItemType Directory -Path $buildRoot -Force | Out-Null
$launcher = Join-Path $buildRoot '双模型工作台.exe'
$icon = Join-Path $projectRoot 'web\public\workbench.ico'
if (-not (Test-Path -LiteralPath $icon -PathType Leaf)) { throw 'Desktop icon not found' }
$compilerArgs = @('/nologo', '/codepage:65001', '/target:winexe', '/optimize+', '/r:System.Core.dll', '/r:System.Windows.Forms.dll', '/r:System.Management.dll', '/r:System.Web.Extensions.dll', ('/win32icon:'+$icon), ('/out:'+$launcher), (Join-Path $PSScriptRoot 'desktop\DesktopLauncher.cs'))
$desktopResources = $null
if ($NativeDesktop) {
    if (-not $WebView2SdkDirectory) { throw 'NativeDesktop requires WebView2SdkDirectory (Microsoft.Web.WebView2 1.0.4314.35).' }
    $sdk = (Resolve-Path -LiteralPath $WebView2SdkDirectory).Path
    $sdkPackage = Join-Path (Split-Path -Parent $sdk) 'microsoft.web.webview2.1.0.4314.35.nupkg'
    $sdkPackageSha256 = '90778deb1b77e36292828b4b5833c9255c27533f40e0ddd55891ae718944edc4'
    if ((Get-FileHash -LiteralPath $sdkPackage -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sdkPackageSha256) { throw 'WebView2 SDK package SHA-256 does not match the pinned official package.' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($sdkPackage)
    try {
        foreach ($relative in @('Microsoft.Web.WebView2.nuspec','lib/net462/Microsoft.Web.WebView2.Core.dll','lib/net462/Microsoft.Web.WebView2.WinForms.dll','runtimes/win-x64/native/WebView2Loader.dll','LICENSE.txt','NOTICE.txt')) {
            $entry = $archive.GetEntry($relative)
            if (-not $entry) { throw ('Missing pinned SDK package entry: '+$relative) }
            $stream = $entry.Open()
            $algorithm = [Security.Cryptography.SHA256]::Create()
            try { $expected = ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-','').ToLowerInvariant() }
            finally { $stream.Dispose(); $algorithm.Dispose() }
            $actual = (Get-FileHash -LiteralPath (Join-Path $sdk $relative) -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($actual -ne $expected) { throw ('WebView2 SDK extracted file differs from pinned package: '+$relative) }
        }
    } finally { $archive.Dispose() }
    [xml]$sdkManifest = Get-Content -LiteralPath (Join-Path $sdk 'Microsoft.Web.WebView2.nuspec') -Raw -Encoding UTF8
    if ($sdkManifest.package.metadata.id -ne 'Microsoft.Web.WebView2' -or $sdkManifest.package.metadata.version -ne '1.0.4314.35') { throw 'Unexpected WebView2 SDK identity/version.' }
    $core = Join-Path $sdk 'lib\net462\Microsoft.Web.WebView2.Core.dll'
    $forms = Join-Path $sdk 'lib\net462\Microsoft.Web.WebView2.WinForms.dll'
    $loader = Join-Path $sdk 'runtimes\win-x64\native\WebView2Loader.dll'
    $referenceBase = Join-Path ${env:ProgramFiles(x86)} 'Reference Assemblies\Microsoft\Framework\.NETFramework'
    $frameworkVersion = @('v4.8', 'v4.8.1') | Where-Object { Test-Path -LiteralPath (Join-Path $referenceBase $_) } | Select-Object -First 1
    if (-not $frameworkVersion) { throw '.NET Framework 4.8 or 4.8.1 developer reference assemblies are required.' }
    $frameworkReferences = Join-Path $referenceBase $frameworkVersion
    $desktopResources = Join-Path $buildRoot ('native-resources-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $desktopResources | Out-Null
    foreach ($file in @($core, $forms, $loader)) { Copy-Item -LiteralPath $file -Destination $desktopResources }
    Copy-Item -LiteralPath (Join-Path $sdk 'LICENSE.txt') -Destination (Join-Path $desktopResources 'WEBVIEW2-SDK-LICENSE.txt')
    Copy-Item -LiteralPath (Join-Path $sdk 'NOTICE.txt') -Destination (Join-Path $desktopResources 'WEBVIEW2-SDK-NOTICE.txt')
    ('<configuration><startup><supportedRuntime version="v4.0" sku=".NETFramework,Version='+$frameworkVersion+'" /></startup><System.Windows.Forms.ApplicationConfigurationSection><add key="DpiAwareness" value="PerMonitorV2" /></System.Windows.Forms.ApplicationConfigurationSection></configuration>') | Set-Content -LiteralPath (Join-Path $desktopResources '双模型工作台.exe.config') -Encoding UTF8
    $targetFramework = Join-Path $desktopResources 'TargetFramework.cs'
    ('[assembly:System.Runtime.Versioning.TargetFramework(".NETFramework,Version='+$frameworkVersion+'",FrameworkDisplayName=".NET Framework '+$frameworkVersion.Substring(1)+'")]') | Set-Content -LiteralPath $targetFramework -Encoding UTF8
    [ordered]@{ host = 'winforms-webview2'; architecture = 'x64'; framework = ('.NET Framework '+$frameworkVersion.Substring(1)); sdk = 'Microsoft.Web.WebView2'; sdkVersion = '1.0.4314.35'; sdkSource = 'https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/1.0.4314.35/microsoft.web.webview2.1.0.4314.35.nupkg'; sdkPackageSha256 = $sdkPackageSha256; runtime = 'Microsoft Edge WebView2 Evergreen Runtime' } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $desktopResources 'desktop-host.json') -Encoding UTF8
    $compilerArgs = @($compilerArgs | Where-Object { $_ -notlike '/r:*' })
    $compilerArgs += @('/noconfig', '/nostdlib+')
    foreach ($assembly in @('mscorlib','System','System.Core','System.Drawing','System.Windows.Forms','System.Management','System.Web.Extensions')) { $compilerArgs += ('/r:'+(Join-Path $frameworkReferences ($assembly+'.dll'))) }
    $compilerArgs += $targetFramework
    $compilerArgs += @('/define:DMW_WEBVIEW2', '/platform:x64', ('/r:'+$core), ('/r:'+$forms), ('/win32manifest:'+(Join-Path $PSScriptRoot 'desktop\DesktopApp.manifest')), (Join-Path $PSScriptRoot 'desktop\DesktopAppWindow.cs'))
}
& $compiler @compilerArgs
if ($LASTEXITCODE -ne 0) { throw 'Desktop launcher compilation failed' }
if ($desktopResources) { Remove-Item -LiteralPath $targetFramework }
Push-Location (Join-Path $projectRoot 'web')
try {
    & $resolvedNode 'node_modules\typescript\bin\tsc' --noEmit
    if ($LASTEXITCODE -ne 0) { throw 'Frontend typecheck failed' }
    & $resolvedNode 'node_modules\vite\bin\vite.js' build
    if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed' }
} finally { Pop-Location }
$packageArgs = @((Join-Path $PSScriptRoot 'desktop\build-portable.mjs'), '--project', $projectRoot, '--out', $OutputDirectory, '--node', $resolvedNode, '--launcher', $launcher)
if ($desktopResources) { $packageArgs += @('--desktop-resources', $desktopResources) }
if ($IncludeData) { $packageArgs += '--include-data' }
if ($ChatCandidate) { $packageArgs += '--chat-candidate' }
if ($ChatPort) { if (-not $ChatCandidate) { throw 'ChatPort requires ChatCandidate.' }; $packageArgs += @('--chat-port', [string]$ChatPort) }
if ($ChatStatusFile) { if (-not $ChatCandidate) { throw 'ChatStatusFile requires ChatCandidate.' }; $packageArgs += @('--chat-status', (Resolve-Path -LiteralPath $ChatStatusFile).Path) }
if ($ChatDataRoot) { if (-not $ChatCandidate) { throw 'ChatDataRoot requires ChatCandidate.' }; $packageArgs += @('--chat-data-root', [System.IO.Path]::GetFullPath($ChatDataRoot)) }
if ($UpgradeFromDirectory) { $packageArgs += @('--upgrade-from', (Resolve-Path -LiteralPath $UpgradeFromDirectory).Path) }
& $resolvedNode @packageArgs
if ($LASTEXITCODE -ne 0) { throw 'Portable packaging failed' }
