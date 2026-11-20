param(
  [Parameter(Mandatory = $true)][string]$TargetPath,
  [Parameter(Mandatory = $true)][string]$ReleaseRequestPath,
  [Parameter(Mandatory = $true)][string]$ReleasedPath
)

$stream = $null
try {
  # Allow ordinary reads and writes, but deliberately omit FileShare.Delete so
  # replacing the path fails on Windows until this handle is closed.
  $stream = [System.IO.File]::Open(
    $TargetPath,
    [System.IO.FileMode]::Open,
    [System.IO.FileAccess]::ReadWrite,
    [System.IO.FileShare]::ReadWrite
  )

  [Console]::Out.WriteLine('READY')
  [Console]::Out.Flush()

  $deadline = [System.DateTime]::UtcNow.AddSeconds(10)
  while (-not [System.IO.File]::Exists($ReleaseRequestPath)) {
    if ([System.DateTime]::UtcNow -ge $deadline) {
      throw 'Timed out waiting for the parent process to observe a retryable rename failure.'
    }
    [System.Threading.Thread]::Sleep(10)
  }
}
finally {
  if ($null -ne $stream) {
    $stream.Dispose()
  }
  [System.IO.File]::WriteAllText(
    $ReleasedPath,
    'released',
    [System.Text.UTF8Encoding]::new($false)
  )
}
