param([ValidateSet('launch','stop')][string]$Mode = 'launch')
$ErrorActionPreference = 'Stop'
try {
  $info = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'install.json') -Raw | ConvertFrom-Json
  if ($info.product -ne 'Salem' -or [IO.Path]::GetFullPath($info.installDir) -ne [IO.Path]::GetFullPath($PSScriptRoot) -or $info.current -notmatch '^\d+\.\d+\.\d+(?:[-.][a-zA-Z0-9.-]+)?-[a-f0-9]{16}$') { throw 'No se pudo verificar la instalación de Salem.' }
  $version = Join-Path (Join-Path $PSScriptRoot 'versions') $info.current
  $node = Join-Path $version 'runtime\node.exe'
  $manager = Join-Path $version 'windows\manager.mjs'
  $output = & $node $manager $Mode --install-dir $PSScriptRoot 2>&1
  if ($LASTEXITCODE -ne 0) { throw ($output -join "`n") }
} catch {
  Add-Type -AssemblyName System.Windows.Forms
  [Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Salem', 'OK', 'Error') | Out-Null
  exit 1
}
