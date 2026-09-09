const { execFileSync } = require('node:child_process')

if (process.platform !== 'win32') process.exit(0)

// Match the packaged product executable, leaving other Electron applications alone.
const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$taskAppName = '교대근무 일정관리.exe'
$taskProcesses = @(Get-CimInstance Win32_Process -Filter "Name = '$taskAppName'")
if ($taskProcesses.Count -eq 0) {
  Write-Output '[build] No running calendar application.'
  exit 0
}
Write-Output ('[build] Closing calendar application (' + $taskProcesses.Count + ' processes)...')
$taskIds = @($taskProcesses | Select-Object -ExpandProperty ProcessId)
foreach ($taskId in $taskIds) {
  $taskProcess = Get-Process -Id $taskId -ErrorAction SilentlyContinue
  if ($taskProcess -and $taskProcess.MainWindowHandle -ne 0) {
    $null = $taskProcess.CloseMainWindow()
  }
}
$taskDeadline = (Get-Date).AddSeconds(10)
do {
  $taskRemaining = @(Get-CimInstance Win32_Process -Filter "Name = '$taskAppName'")
  if ($taskRemaining.Count -eq 0) { break }
  Start-Sleep -Milliseconds 250
} while ((Get-Date) -lt $taskDeadline)
foreach ($taskProcess in $taskRemaining) {
  $taskCurrent = Get-Process -Id $taskProcess.ProcessId -ErrorAction SilentlyContinue
  if ($taskCurrent -and $taskCurrent.ProcessName -eq '교대근무 일정관리') {
    Stop-Process -InputObject $taskCurrent -Force
    $taskCurrent.WaitForExit(5000) | Out-Null
  }
}
if (@(Get-CimInstance Win32_Process -Filter "Name = '$taskAppName'").Count -gt 0) {
  throw 'Calendar application is still running; build cancelled to avoid locked files.'
}
Write-Output '[build] Calendar application stopped.'
`

try {
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    stdio: 'inherit', windowsHide: true, timeout: 30_000,
  })
} catch (error) {
  console.error('[build] Unable to stop the calendar application:', error.message)
  process.exit(1)
}
