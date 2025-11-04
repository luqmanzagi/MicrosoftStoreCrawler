# Determine a log file in the same folder as this script (fallback to current directory if unknown)
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $scriptDir) { $scriptDir = (Get-Location).Path }
$logPath = Join-Path $scriptDir 'install.log'

# Ask the user to provide a file path interactively
$filePath = Read-Host "Enter the path to your text file (one app ID per line)"

if (-not (Test-Path $filePath)) {
    Write-Error "File not found: $filePath"
    exit 1
}

# Read all non-empty lines (trim whitespace)
$apps = Get-Content $filePath | Where-Object { $_.Trim() -ne '' }

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


