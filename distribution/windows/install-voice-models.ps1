[CmdletBinding()]
param([string]$DataDir = $env:CODEX_MAID_HOME)

$ErrorActionPreference = 'Stop'
if (!$DataDir) { $DataDir = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex-maid-widget' }
$manifest = Join-Path $PSScriptRoot 'voice-models.json'
if (!(Test-Path -LiteralPath $manifest)) { $manifest = Join-Path $PSScriptRoot '..\..\assets\voice-models.json' }
$models = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
$directory = Join-Path ([IO.Path]::GetFullPath($DataDir)) 'voice-input'
$null = New-Item -ItemType Directory -Force -Path $directory
$lock = [IO.File]::Open((Join-Path $directory 'model-download.lock'), 'OpenOrCreate', 'ReadWrite', 'None')

function Test-Model($File, $Model) {
    $info = Get-Item -LiteralPath $File -ErrorAction SilentlyContinue
    return $info -and $info.Length -eq $Model.size -and
        (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash -eq $Model.sha256
}

try {
    foreach ($model in $models) {
        $target = Join-Path $directory $model.file
        if (Test-Model $target $model) { Write-Host "Verified $($model.file)"; continue }
        $partial = "$target.part"
        $info = Get-Item -LiteralPath $partial -ErrorAction SilentlyContinue
        if ($info -and $info.Length -ge $model.size -and !(Test-Model $partial $model)) {
            Remove-Item -LiteralPath $partial -Force
        }
        if (!(Test-Model $partial $model)) {
            Write-Host "Downloading $($model.file) ($($model.size) bytes)"
            & curl.exe --fail --location --retry 2 --continue-at - --output $partial $model.url
            if ($LASTEXITCODE) { throw "Download interrupted for $($model.file). Run this tool again to resume." }
            if (!(Test-Model $partial $model)) { throw "SHA-256 verification failed for $($model.file)." }
        }
        if (Test-Path -LiteralPath $target) { [IO.File]::Replace($partial, $target, $null) }
        else { [IO.File]::Move($partial, $target) }
        Write-Host "Installed $($model.file)"
    }
    Write-Host 'Offline voice models are ready. Restart Codex Maid Widget to show the microphone.'
} finally {
    $lock.Dispose()
}
