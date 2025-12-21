# Determine log file path: {parentDir}/log/install/{date}.log
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $scriptDir) { $scriptDir = (Get-Location).Path }
$parentDir = Split-Path -Parent $scriptDir
if (-not $parentDir) { $parentDir = (Get-Location).Path }

# Create log directory structure
$logDir = Join-Path $parentDir 'logs\install'
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
    Write-Host "Installing: $app"
    $startTime = Get-Date

    # Run install and capture output + exit code
    $outputLines = @()
    $errorText = $null
    try {
        $null = & winget install --id $app --accept-source-agreements --accept-package-agreements 2>&1 |
            Tee-Object -Variable outputLines
    }
    catch {
        $errorText = $_.Exception.Message
    }
    finally {
        $endTime = Get-Date
        $elapsed = New-TimeSpan -Start $startTime -End $endTime
    }

    $text = ($outputLines -join "`n")
    if ($errorText) { $text = $text + "`n" + $errorText }
    $code = $LASTEXITCODE

    # Status classification
    $status = "failure"
    if ($text -match 'Found an existing package already installed' -or
        $text -match 'No available upgrade found' -or
        $text -match 'No newer package versions are available') {
        $status = "exist"
    }
    elseif (($code -eq 0) -and (
        $text -match 'Successfully installed' -or
        $text -match 'Installation completed' -or
        $text -match 'Succeeded'
    )) {
        $status = "success"
    }
    elseif ($text -match 'No package found matching input criteria' -or
            $text -match 'No available package found matching input criteria' -or
            $text -match 'Package not found') {
        $status = "failure"
    }
    elseif ($code -eq 0) {
        $status = "success"
    }

    # Extract "Name [ID]" if possible
    $label = $app
    $m = [regex]::Match($text, '(?i)Found\s+(.+?\[[^\]]+\])')
    if ($m.Success) {
        $label = $m.Groups[1].Value.Trim()
    } else {
        $m2 = [regex]::Match($text, '(?im)^\s*(.+?\[[^\]]+\])\s*$')
        if ($m2.Success) {
            $label = $m2.Groups[1].Value.Trim()
        } else {
            # Fallback: query Winget for the header without disturbing our saved exit code
            try {
                $show = & winget show --id $app --exact 2>$null
                $m3 = [regex]::Match(($show -join "`n"), '(?i)Found\s+(.+?\[[^\]]+\])')
                if ($m3.Success) { $label = $m3.Groups[1].Value.Trim() }
            } catch { }
        }
    }

    Add-Content -Path $logPath -Value ("Install {0} took {1} {2}" -f $label, $elapsed.ToString("mm\:ss"), $status)
}


