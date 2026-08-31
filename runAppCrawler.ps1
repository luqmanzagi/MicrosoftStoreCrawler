# runAppCrawler.ps1
# Usage:  .\runAppCrawler.ps1 [-url <inputURL>] [-Limit <inputLimit>]
param(
    [string]$url = "https://apps.microsoft.com/collections/computed/apps/TopFree?hl=en&gl=NL",
    [int]$Limit = 50
)

$ErrorActionPreference = "Stop"

$repoRoot = $PSScriptRoot
$resultsDir = Join-Path $repoRoot "results"
$today = Get-Date -Format "yyyy-MM-dd"
$outFile = Join-Path $resultsDir "app_$today.json"

$crawlAppData = Join-Path $repoRoot "scripts\crawlAppData.js"
$crawlAppCat = Join-Path $repoRoot "scripts\crawlAppCat.js"

if (-not (Test-Path $resultsDir)) {
    New-Item -ItemType Directory -Path $resultsDir | Out-Null
}

Write-Host "Crawling apps from $url (limit $Limit)"
Write-Host "Output: $outFile"
node $crawlAppData --url $url --out $outFile --limit $Limit
if ($LASTEXITCODE -ne 0) {
    Write-Error "crawlAppData.js failed with exit code $LASTEXITCODE"
    exit $LASTEXITCODE
}

Write-Host "Crawling categories from $outFile"
node $crawlAppCat --in $outFile
if ($LASTEXITCODE -ne 0) {
    Write-Error "crawlAppCat.js failed with exit code $LASTEXITCODE"
    exit $LASTEXITCODE
}

Write-Host "Done. Results saved to $outFile"
