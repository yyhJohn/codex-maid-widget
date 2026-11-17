[CmdletBinding()]
param(
    [string]$DataDir = $env:CODEX_MAID_HOME,
    [string]$Archive
)

$ErrorActionPreference = 'Stop'
$release = 'https://github.com/jingh12312-rgb/bailong-desktop-pet/releases/download/v0.5.1/bailong-desktop-pet-v0.5.1-windows-x64-webm.zip'
$releaseSha256 = '4B636BF1E92A82A798B01BE09CBD658CBFC46C548DD1A38ACEE31368B9C78580'
# Matches imageio_ffmpeg 0.6.0's Windows x64 wheel, independently of the pet release.
$ffmpegSha256 = '2CE797A0F88D7F067180338FB227F7B1928EA727BD9A4D7A1D022F7C52AF71A3'
$clips = [ordered]@{ idle = 'idle.webm'; working = 'work02.webm'; completed = '18.webm'; wave = '01.webm' }

function RequireRegularItem([string]$Path, [bool]$Directory) {
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.PSIsContainer -ne $Directory -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Unexpected file or directory type: $Path"
    }
    $item
}

function Test-AnimatedWebP([string]$File) {
    if (!(Test-Path -LiteralPath $File -PathType Leaf)) { return $false }
    $item = RequireRegularItem $File $false
    if ($item.Length -lt 21 -or $item.Length -gt 15MB) { return $false }
    $stream = [IO.File]::OpenRead($item.FullName)
    try {
        $bytes = New-Object byte[] 21
        return ($stream.Read($bytes, 0, $bytes.Length) -eq 21 -and
            [Text.Encoding]::ASCII.GetString($bytes, 0, 4) -eq 'RIFF' -and
            [Text.Encoding]::ASCII.GetString($bytes, 8, 8) -eq 'WEBPVP8X' -and
            ($bytes[20] -band 0x12) -eq 0x12)
    } finally { $stream.Dispose() }
}

if (!$DataDir) { $DataDir = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex-maid-widget' }
$characters = Join-Path ([IO.Path]::GetFullPath($DataDir)) 'characters'
$null = New-Item -Path $characters -ItemType Directory -Force
$characters = (RequireRegularItem $characters $true).FullName
$destination = Join-Path $characters 'bailong'
$lockPath = Join-Path $characters '.bailong-install.lock'
if (Test-Path -LiteralPath $lockPath) { $null = RequireRegularItem $lockPath $false }
$lock = [IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None')
$scratch = $null
try {
    if (Test-Path -LiteralPath $destination) {
        $null = RequireRegularItem $destination $true
        $missing = @($clips.Keys | Where-Object { !(Test-AnimatedWebP (Join-Path $destination "$_.webp")) })
        if (!$missing.Count) {
            Write-Host "White Dragon animations are already installed at $destination"
            return
        }
    }
    $scratch = (New-Item -Path (Join-Path $characters ('.bailong-stage-' + [Guid]::NewGuid().ToString('n'))) -ItemType Directory).FullName
    $staged = (New-Item -Path (Join-Path $scratch 'sprites') -ItemType Directory).FullName
    if (!$Archive) {
        $Archive = Join-Path $scratch 'author-release.zip'
        Write-Host 'Downloading the original White Dragon release (226 MiB)...'
        & curl.exe --fail --location --retry 2 --connect-timeout 15 --max-time 300 --output $Archive $release
        if ($LASTEXITCODE -ne 0) { throw 'The White Dragon download failed. Retry or supply the author ZIP with -Archive.' }
    }
    $zipFile = RequireRegularItem $Archive $false
    if ($zipFile.Length -ne 236968505 -or (Get-FileHash -LiteralPath $zipFile.FullName -Algorithm SHA256).Hash -ne $releaseSha256) {
        throw 'The ZIP does not match the pinned White Dragon v0.5.1 release.'
    }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($zipFile.FullName)
    $ffmpeg = Join-Path $scratch 'ffmpeg.exe'
    try {
        $encoder = $zip.GetEntry('BailongPet/tools/ffmpeg.exe')
        if (!$encoder -or $encoder.Length -ne 87638016) { throw 'Expected encoder is missing from the author archive.' }
        [IO.Compression.ZipFileExtensions]::ExtractToFile($encoder, $ffmpeg)
        foreach ($role in $clips.Keys) {
            $entries = @($zip.Entries | Where-Object {
                $_.FullName.StartsWith('BailongPet/outputs/', [StringComparison]::Ordinal) -and $_.Name -ceq $clips[$role]
            })
            if ($entries.Count -ne 1 -or $entries[0].Length -gt 10MB -or !$entries[0].Length) {
                throw "Could not locate the expected $role animation in the author archive."
            }
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entries[0], (Join-Path $scratch "$role.webm"))
        }
    } finally { $zip.Dispose() }
    if ((Get-FileHash -LiteralPath $ffmpeg -Algorithm SHA256).Hash -ne $ffmpegSha256) {
        throw 'The extracted encoder does not match the independently verified FFmpeg binary.'
    }
    foreach ($role in $clips.Keys) {
        $loop = if ($role -in @('idle', 'working')) { 0 } else { 1 }
        $target = Join-Path $staged "$role.webp"
        $options = @(
            '-nostdin', '-n', '-hide_banner', '-loglevel', 'error', '-threads', '3',
            '-c:v', 'libvpx-vp9', '-i', (Join-Path $scratch "$role.webm"), '-an',
            '-vf', 'scale=384:384:flags=lanczos,format=yuva420p', '-c:v', 'libwebp_anim',
            '-quality', '89', '-compression_level', '4', '-loop', $loop, $target
        )
        & $ffmpeg @options
        if ($LASTEXITCODE -ne 0 -or !(Test-AnimatedWebP $target)) { throw "Could not convert $role to a transparent animated WebP." }
    }

    $backup = $null
    try {
        if (Test-Path -LiteralPath $destination) {
            $null = RequireRegularItem $destination $true
            $candidate = Join-Path $characters ('bailong-backup-' + [Guid]::NewGuid().ToString('n'))
            [IO.Directory]::Move($destination, $candidate)
            $backup = $candidate
        }
        [IO.Directory]::Move($staged, $destination)
    } catch {
        if ($backup -and !(Test-Path -LiteralPath $destination)) { [IO.Directory]::Move($backup, $destination) }
        throw
    }
    Write-Host "Installed the four White Dragon animations at $destination"
    Write-Host 'Restart the widget and select GPT White Dragon (Animated) in Characters.'
} finally {
    $lock.Dispose()
    if ($scratch -and (Test-Path -LiteralPath $scratch)) {
        $stagingDirectory = RequireRegularItem $scratch $true
        if ($stagingDirectory.Parent.FullName -eq $characters -and $stagingDirectory.Name -match '^\.bailong-stage-[a-f0-9]{32}$') {
            Remove-Item -LiteralPath $stagingDirectory.FullName -Recurse -Force
        }
    }
}
