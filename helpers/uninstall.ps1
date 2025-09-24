# Ask the user to provide a file path interactively
$filePath = Read-Host "Enter the path to your text file (one app ID per line)"

if (-not (Test-Path $filePath)) {
    Write-Error "File not found: $filePath"
    exit 1
}

# Read all non-empty lines (trim whitespace)
$apps = Get-Content $filePath | Where-Object { $_.Trim() -ne '' }

foreach ($app in $apps) {
    Write-Host "Uninstalling: $app"
    winget uninstall --id $app
}

