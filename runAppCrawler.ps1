# runAppCrawler.ps1
# Usage:  .\runAppCrawler.ps1 [-Limit 50]
param(
    [int]$Limit = 50
)

$inputList = ".\results\collection_href.txt"

if (-not (Test-Path $inputList)) {
    Write-Error "Missing input file: $inputList"
    exit 1
}

# Ensure results folder exists
if (-not (Test-Path ".\results")) {
    New-Item -ItemType Directory -Path ".\results" | Out-Null
}

# Read all non-empty lines (one URL per line)
$apps = Get-Content $inputList | Where-Object { $_.Trim() -ne '' }

foreach ($app in $apps) {
    try {
        $uri = [uri]$app
    } catch {
        Write-Warning "Skipping invalid URL: $app"
        continue
    }

    # Take the last path segment that doesn't start with '_' as the collection name
    $segments = $uri.AbsolutePath.Trim('/') -split '/'
    $collectionName = ($segments | Where-Object { $_ -and $_[0] -ne '_' } | Select-Object -Last 1)
    if (-not $collectionName) { $collectionName = 'output' }

    $outFile = Join-Path ".\results\free_app" ($collectionName + ".json")

    Write-Host "Crawling collection '$collectionName' from $app"
    node appCrawler.js --url "$app" --out "$outFile" --limit $Limit
}
