# Determine log file path: {parentDir}/log/uninstall/{date}.log
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $scriptDir) { $scriptDir = (Get-Location).Path }
$parentDir = Split-Path -Parent $scriptDir
if (-not $parentDir) { $parentDir = (Get-Location).Path }

# Create log directory structure
$logDir = Join-Path $parentDir 'logs\uninstall'
if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

# Use current date as filename (YYYY-MM-DD.log)
$dateStr = Get-Date -Format 'yyyy-MM-dd'
$logPath = Join-Path $logDir "$dateStr.log"

# Ask the user to provide a file path interactively
$filePath = Read-Host "Enter the path to your file (text file with one app ID per line, or JSON file)"

if (-not (Test-Path $filePath)) {
    Write-Error "File not found: $filePath"
    exit 1
}

# Determine if file is JSON (by extension or content)
$isJson = $filePath -match '\.json$'
$apps = @()

if ($isJson) {
    # Parse JSON and extract itemID values
    try {
        $jsonContent = Get-Content $filePath -Raw | ConvertFrom-Json
        if ($jsonContent -is [Array]) {
            # Array of objects
            $apps = $jsonContent | ForEach-Object { $_.itemID }
        } elseif ($jsonContent.itemID) {
            # Single object
            $apps = @($jsonContent.itemID)
        } else {
            Write-Error "JSON file does not contain 'itemID' fields"
            exit 1
        }
        Write-Host "Loaded $($apps.Count) app IDs from JSON file"
    }
    catch {
        Write-Error "Failed to parse JSON file: $_"
        exit 1
    }
} else {
    # Read all non-empty lines (trim whitespace) - text file format
    $apps = Get-Content $filePath | Where-Object { $_.Trim() -ne '' }
    Write-Host "Loaded $($apps.Count) app IDs from text file"
}

foreach ($app in $apps) {
    $startTime = Get-Date
    Write-Host "Uninstalling: $app"
    winget uninstall --id $app
    $stopTime = Get-Date
    $elapsedTime = New-Timespan -Start $startTime -End $stopTime
    Add-Content -Path $logPath -Value ("Uninstallation on {0} took {1}" -f $app, $elapsedTime.ToString("mm\:ss"))
}

