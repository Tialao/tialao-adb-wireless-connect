<#
.SYNOPSIS
    Installe TIALAO ADB Wireless Connect sur tous les editeurs detectes.

.DESCRIPTION
    Telecharge le .vsix de la derniere version publiee sur GitHub, detecte les editeurs
    de la famille VS Code presents sur la machine, et l'installe sur chacun. Les editeurs
    absents sont ignores silencieusement.

    La detection ne se limite PAS au PATH : sous Windows, le raccourci `code` n'y est
    ajoute que si l'utilisateur a coche l'option correspondante a l'installation, ce qui
    est rarement le cas. Chaque editeur est donc aussi cherche a ses emplacements
    d'installation standards.

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

$programFiles = ${env:ProgramFiles}
$programFilesX86 = ${env:ProgramFiles(x86)}
$localPrograms = Join-Path $env:LOCALAPPDATA 'Programs'

# Nom affiche, commande CLI, et emplacements standards a sonder quand la commande
# n'est pas dans le PATH. Le meme .vsix fonctionne sur tous ces editeurs.
$Editors = @(
    @{ Name = 'VS Code'; Command = 'code'; Dirs = @('Microsoft VS Code') }
    @{ Name = 'VS Code Insiders'; Command = 'code-insiders'; Dirs = @('Microsoft VS Code Insiders') }
    @{ Name = 'Cursor'; Command = 'cursor'; Dirs = @('cursor', 'Cursor') }
    @{ Name = 'Windsurf'; Command = 'windsurf'; Dirs = @('Windsurf') }
    @{ Name = 'VSCodium'; Command = 'codium'; Dirs = @('VSCodium') }
    @{ Name = 'Trae'; Command = 'trae'; Dirs = @('Trae') }
    @{ Name = 'Kiro'; Command = 'kiro'; Dirs = @('Kiro') }
    @{ Name = 'Positron'; Command = 'positron'; Dirs = @('Positron') }
)

function Write-Step { param([string]$Message) Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok { param([string]$Message) Write-Host "  [ok] $Message" -ForegroundColor Green }
function Write-Skip { param([string]$Message) Write-Host "  [--] $Message" -ForegroundColor DarkGray }
function Write-Fail { param([string]$Message) Write-Host "  [!!] $Message" -ForegroundColor Red }

# Resout le lanceur d'un editeur : d'abord le PATH, puis les emplacements standards.
# Deux dispositions coexistent : `<racine>\bin\<cmd>.cmd` (VS Code, Windsurf, Trae...)
# et `<racine>\resources\app\bin\<cmd>.cmd` (Cursor).
function Resolve-EditorCli {
    param([string]$Command, [string[]]$Dirs)

    $onPath = Get-Command $Command -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($onPath) { return $onPath.Source }

    $roots = @($localPrograms, $programFiles, $programFilesX86) | Where-Object { $_ }

    foreach ($root in $roots) {
        foreach ($dir in $Dirs) {
            foreach ($suffix in @('bin', 'resources\app\bin')) {
                foreach ($extension in @('.cmd', '.exe', '')) {
                    $candidate = Join-Path $root (Join-Path $dir (Join-Path $suffix "$Command$extension"))
                    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
                }
            }
        }
    }

    return $null
}

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

    Write-Ok "Version $($release.tag_name) - $($asset.name)"
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

foreach ($editor in $Editors) {
    $name = $editor.Name
    $cli = Resolve-EditorCli -Command $editor.Command -Dirs $editor.Dirs

    if (-not $cli) {
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
        $output = (& $cli --install-extension $vsix --force 2>&1 | Out-String).Trim()
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
    Write-Host '  << TIALAO ADB: Pair device with QR code >> depuis la palette.'
} elseif ($failed.Count -gt 0) {
    Write-Host "  Aucune installation n'a abouti." -ForegroundColor Yellow
} else {
    Write-Host "  Aucun editeur de la famille VS Code n'a ete trouve." -ForegroundColor Yellow
    Write-Host ''
    Write-Host '  Si votre editeur est bien installe, passez par son interface :'
    Write-Host '    Extensions -> menu ... -> Install from VSIX...'
    Write-Host '  Cette voie ne depend ni du PATH ni du nom de la commande.'
    Write-Host ''
    Write-Host '  Vous pouvez aussi utiliser le CLI, qui fonctionne partout :'
    Write-Host '    npm install -g tialao-adb-wireless'
    Write-Host '    tadb pair-qr'
}

if ($failed.Count -gt 0) {
    Write-Host "  Echecs : $($failed -join ', ')" -ForegroundColor Red
    exit 1
}
