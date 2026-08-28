<#
.SYNOPSIS
    Installe TIALAO ADB Wireless Connect sur tous les editeurs detectes.

.DESCRIPTION
    Telecharge le .vsix de la derniere version publiee sur GitHub, detecte les editeurs
    de la famille VS Code presents sur la machine, et l'installe sur chacun. Les editeurs
    absents sont ignores silencieusement.

.EXAMPLE
    irm https://raw.githubusercontent.com/Tialao/tialao-adb-wireless-connect/main/scripts/install.ps1 | iex

.EXAMPLE
    .\install.ps1 -VsixPath .\tialao-adb-wireless-connect.vsix
#>
[CmdletBinding()]
param(
    # Installe un .vsix local au lieu de telecharger la derniere version.
    [string]$VsixPath,
    # Version a installer (defaut : la plus recente).
    [string]$Version = 'latest'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Repo = 'Tialao/tialao-adb-wireless-connect'

# Nom affiche -> commande CLI. Le meme .vsix fonctionne sur tous.
$Editors = [ordered]@{
    'VS Code'          = 'code'
    'VS Code Insiders' = 'code-insiders'
    'Cursor'           = 'cursor'
    'Windsurf'         = 'windsurf'
    'VSCodium'         = 'codium'
    'Trae'             = 'trae'
    'Kiro'             = 'kiro'
    'Positron'         = 'positron'
}

function Write-Step { param([string]$Message) Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok { param([string]$Message) Write-Host "  [ok] $Message" -ForegroundColor Green }
function Write-Skip { param([string]$Message) Write-Host "  [--] $Message" -ForegroundColor DarkGray }
function Write-Fail { param([string]$Message) Write-Host "  [!!] $Message" -ForegroundColor Red }

function Get-LatestVsixUrl {
    $url = if ($Version -eq 'latest') {
        "https://api.github.com/repos/$Repo/releases/latest"
    } else {
        "https://api.github.com/repos/$Repo/releases/tags/$Version"
    }

    Write-Step "Recherche de la derniere version publiee"
    try {
        $release = Invoke-RestMethod -Uri $url -Headers @{ 'User-Agent' = 'tialao-adb-installer' }
    } catch {
        throw "Impossible d'interroger l'API GitHub : $($_.Exception.Message)"
    }

    $asset = $release.assets | Where-Object { $_.name -like '*.vsix' } | Select-Object -First 1
    if (-not $asset) { throw "Aucun fichier .vsix dans la release $($release.tag_name)." }

    Write-Ok "Version $($release.tag_name) — $($asset.name)"
    return $asset.browser_download_url
}

# --- Recuperation du .vsix ---------------------------------------------------------------

$temporary = $null
if ($VsixPath) {
    if (-not (Test-Path $VsixPath)) { throw "Fichier introuvable : $VsixPath" }
    $vsix = (Resolve-Path $VsixPath).Path
    Write-Step "Utilisation du fichier local $vsix"
} else {
    $downloadUrl = Get-LatestVsixUrl
    $temporary = Join-Path ([System.IO.Path]::GetTempPath()) "tialao-adb-wireless-connect-$([guid]::NewGuid().ToString('N')).vsix"
    Write-Step 'Telechargement'
    Invoke-WebRequest -Uri $downloadUrl -OutFile $temporary -UseBasicParsing
    $vsix = $temporary
    Write-Ok "$([math]::Round((Get-Item $vsix).Length / 1KB)) Ko telecharges"
}

# --- Installation ------------------------------------------------------------------------

Write-Step 'Detection des editeurs installes'

$installed = @()
$failed = @()
$absent = @()

foreach ($entry in $Editors.GetEnumerator()) {
    $name = $entry.Key
    $command = $entry.Value

    $resolved = Get-Command $command -ErrorAction SilentlyContinue
    if (-not $resolved) {
        $absent += $name
        continue
    }

    # Ces CLI ecrivent des avertissements benins (deprecations Node) sur stderr.
    # Avec $ErrorActionPreference = 'Stop', PowerShell en ferait une exception :
    # on repasse donc en 'Continue' le temps de l'appel, et on ne se fie qu'au
    # code de sortie du processus.
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = (& $command --install-extension $vsix --force 2>&1 | Out-String).Trim()
        $exitCode = $LASTEXITCODE
    } catch {
        $output = $_.Exception.Message
        $exitCode = 1
    } finally {
        $ErrorActionPreference = $previousPreference
    }

    if ($exitCode -eq 0) {
        $installed += $name
        Write-Ok $name
    } else {
        $failed += $name
        Write-Fail "$name : $output"
    }
}

foreach ($name in $absent) { Write-Skip "$name (absent)" }

if ($temporary -and (Test-Path $temporary)) { Remove-Item $temporary -Force }

# --- Recapitulatif -----------------------------------------------------------------------

Write-Host ''
Write-Step 'Recapitulatif'

if ($installed.Count -gt 0) {
    Write-Host "  Installe sur : $($installed -join ', ')" -ForegroundColor Green
    Write-Host ''
    Write-Host '  Redemarrez votre editeur, puis lancez la commande'
    Write-Host '  « TIALAO ADB: Pair device with QR code » depuis la palette.'
} elseif ($failed.Count -gt 0) {
    Write-Host "  Aucune installation n'a abouti." -ForegroundColor Yellow
} else {
    Write-Host "  Aucun editeur de la famille VS Code n'a ete trouve." -ForegroundColor Yellow
    Write-Host ''
    Write-Host '  Vous pouvez tout de meme utiliser le CLI, qui fonctionne partout :'
    Write-Host '    npm install -g tialao-adb-wireless'
    Write-Host '    tadb pair-qr'
}

if ($failed.Count -gt 0) {
    Write-Host "  Echecs : $($failed -join ', ')" -ForegroundColor Red
    exit 1
}
