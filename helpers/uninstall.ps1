$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $scriptDir) { $scriptDir = (Get-Location).Path }
$logPath = Join-Path $scriptDir 'uninstall.log'

# Ask the user to provide a file path interactively
$filePath = Read-Host "Enter the path to your text file (one app ID per line)"

if (-not (Test-Path $filePath)) {
    Write-Error "File not found: $filePath"
    exit 1
}

# Read all non-empty lines (trim whitespace)
$apps = Get-Content $filePath | Where-Object { $_.Trim() -ne '' }

foreach ($app in $apps) {
    $startTime = Get-Date
    Write-Host "Uninstalling: $app"
    winget uninstall --id $app
    $stopTime = Get-Date
    $elapsedTime = New-Timespan -Start $startTime -End $stopTime
    Add-Content -Path $logPath -Value ("Uninstallation on {0} took {1}" -f $app, $elapsedTime.ToString("mm\:ss"))
}

