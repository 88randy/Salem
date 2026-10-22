param([string]$InstallDir = $PSScriptRoot, [switch]$Quiet)
$ErrorActionPreference = 'Stop'
try {
  $root = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
  $info = Get-Content -LiteralPath (Join-Path $root 'install.json') -Raw | ConvertFrom-Json
  if ($info.product -ne 'Salem' -or [IO.Path]::GetFullPath($info.installDir).TrimEnd('\') -ne $root -or $info.current -notmatch '^\d+\.\d+\.\d+(?:[-.][a-zA-Z0-9.-]+)?-[a-f0-9]{16}$') { throw 'Identidad de instalación no válida.' }
  $lockPath = Join-Path $root '.operation.lock'
  $operationLock = [IO.File]::Open($lockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
  $lockBytes = [Text.Encoding]::UTF8.GetBytes('{"pid":' + $PID + '}')
  $operationLock.Write($lockBytes, 0, $lockBytes.Length)
  $operationLock.Flush()
  $version = Join-Path (Join-Path $root 'versions') $info.current
  $output = & (Join-Path $version 'runtime\node.exe') (Join-Path $version 'windows\manager.mjs') prepare-uninstall --install-dir $root 2>&1
  if ($LASTEXITCODE -ne 0) { throw ($output -join "`n") }
  $plan = $output | ConvertFrom-Json
  $target = (Resolve-Path -LiteralPath $plan.installDir).ProviderPath.TrimEnd('\')
  $data = [IO.Path]::GetFullPath($plan.dataDir).TrimEnd('\')
  if ($plan.product -ne 'Salem' -or -not $plan.preserveData -or $target -ne $root -or $target -eq [IO.Path]::GetPathRoot($target).TrimEnd('\') -or $data -eq $target -or $data.StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase) -or $target.StartsWith($data + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'No se pudo verificar el destino exacto. Los datos se conservaron.' }
  $links = @(Get-Item -LiteralPath $target -Force) + @(Get-ChildItem -LiteralPath $target -Recurse -Force)
  foreach ($entry in $links) {
    if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Enlace o junction detectado; no se elimina la instalación.' }
    $absolute = [IO.Path]::GetFullPath($entry.FullName).TrimEnd('\')
    if ($absolute -ne $target -and -not $absolute.StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Destino fuera de la instalación.' }
  }
  # Keep the live operation lock until install.json and all executable versions
  # have disappeared, so another launcher cannot race a recursive deletion.
  foreach ($entry in @(Get-ChildItem -LiteralPath $target -Force)) {
    if ($entry.Name -eq '.operation.lock') { continue }
    $entryTarget = [IO.Path]::GetFullPath($entry.FullName)
    if (-not $entryTarget.StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Destino fuera de la instalación.' }
    Remove-Item -LiteralPath $entryTarget -Recurse -Force
  }
  $operationLock.Dispose()
  Remove-Item -LiteralPath $lockPath -Force
  [IO.Directory]::Delete($target, $false)
  if (-not $Quiet) { Add-Type -AssemblyName System.Windows.Forms; [Windows.Forms.MessageBox]::Show("Salem se desinstaló. Tus datos siguen en:`n$data", 'Salem') | Out-Null }
} catch {
  if ($null -ne $operationLock) { $operationLock.Dispose(); if (Test-Path -LiteralPath $lockPath) { Remove-Item -LiteralPath $lockPath -Force } }
  if ($Quiet) { Write-Error $_; exit 1 }
  Add-Type -AssemblyName System.Windows.Forms
  [Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Salem', 'OK', 'Error') | Out-Null
  exit 1
}
