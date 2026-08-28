#!/usr/bin/env bash
#
# Installe TIALAO ADB Wireless Connect sur tous les editeurs detectes.
#
# Telecharge le .vsix de la derniere version publiee sur GitHub, detecte les editeurs de
# la famille VS Code presents sur la machine et l'installe sur chacun. Les editeurs
# absents sont ignores silencieusement.
#
#   curl -fsSL https://raw.githubusercontent.com/Tialao/tialao-adb-wireless-connect/main/scripts/install.sh | bash
#   ./install.sh --vsix ./tialao-adb-wireless-connect.vsix
#   ./install.sh --version v0.1.0

set -euo pipefail

REPO="Tialao/tialao-adb-wireless-connect"
VERSION="latest"
VSIX_PATH=""
TEMP_FILE=""

# Le meme .vsix fonctionne sur tous ces editeurs : seule la commande change.
EDITOR_NAMES=("VS Code" "VS Code Insiders" "Cursor" "Windsurf" "VSCodium" "Trae" "Kiro" "Positron")
EDITOR_COMMANDS=("code" "code-insiders" "cursor" "windsurf" "codium" "trae" "kiro" "positron")

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_STEP=$'\033[36m'; C_OK=$'\033[32m'; C_SKIP=$'\033[90m'; C_ERR=$'\033[31m'; C_WARN=$'\033[33m'; C_OFF=$'\033[0m'
else
  C_STEP=""; C_OK=""; C_SKIP=""; C_ERR=""; C_WARN=""; C_OFF=""
fi

step() { printf '%s==> %s%s\n' "$C_STEP" "$1" "$C_OFF"; }
ok()   { printf '%s  [ok] %s%s\n' "$C_OK" "$1" "$C_OFF"; }
skip() { printf '%s  [--] %s%s\n' "$C_SKIP" "$1" "$C_OFF"; }
err()  { printf '%s  [!!] %s%s\n' "$C_ERR" "$1" "$C_OFF"; }
die()  { printf '%serreur : %s%s\n' "$C_ERR" "$1" "$C_OFF" >&2; exit 1; }

cleanup() { [ -n "$TEMP_FILE" ] && [ -f "$TEMP_FILE" ] && rm -f "$TEMP_FILE"; }
trap cleanup EXIT

while [ $# -gt 0 ]; do
  case "$1" in
    --vsix)    VSIX_PATH="${2:-}"; shift 2 ;;
    --version) VERSION="${2:-}"; shift 2 ;;
    -h|--help)
      sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) die "option inconnue : $1" ;;
  esac
done

fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" ${2:+-o "$2"}
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "${2:--}" "$1"
  else
    die "curl ou wget est requis."
  fi
}

# --- Recuperation du .vsix ---------------------------------------------------------------

if [ -n "$VSIX_PATH" ]; then
  [ -f "$VSIX_PATH" ] || die "fichier introuvable : $VSIX_PATH"
  step "Utilisation du fichier local $VSIX_PATH"
  VSIX="$VSIX_PATH"
else
  step "Recherche de la derniere version publiee"
  if [ "$VERSION" = "latest" ]; then
    API_URL="https://api.github.com/repos/$REPO/releases/latest"
  else
    API_URL="https://api.github.com/repos/$REPO/releases/tags/$VERSION"
  fi

  RELEASE_JSON="$(fetch "$API_URL")" || die "impossible d'interroger l'API GitHub."
  # Extraction sans jq : on isole la premiere URL de telechargement se terminant par .vsix.
  DOWNLOAD_URL="$(printf '%s' "$RELEASE_JSON" \
    | tr ',' '\n' \
    | grep '"browser_download_url"' \
    | grep '\.vsix"' \
    | head -n 1 \
    | sed 's/.*"browser_download_url"[[:space:]]*:[[:space:]]*"//; s/".*//')"

  [ -n "$DOWNLOAD_URL" ] || die "aucun fichier .vsix dans la release demandee."
  ok "$(basename "$DOWNLOAD_URL")"

  TEMP_FILE="$(mktemp -t tialao-adb-XXXXXX)"
  mv "$TEMP_FILE" "$TEMP_FILE.vsix" && TEMP_FILE="$TEMP_FILE.vsix"
  step "Telechargement"
  fetch "$DOWNLOAD_URL" "$TEMP_FILE"
  VSIX="$TEMP_FILE"
  ok "$(( $(wc -c < "$VSIX") / 1024 )) Ko telecharges"
fi

# --- Installation ------------------------------------------------------------------------

step "Detection des editeurs installes"

INSTALLED=""
FAILED=""

i=0
while [ $i -lt ${#EDITOR_COMMANDS[@]} ]; do
  name="${EDITOR_NAMES[$i]}"
  cmd="${EDITOR_COMMANDS[$i]}"
  i=$((i + 1))

  if ! command -v "$cmd" >/dev/null 2>&1; then
    skip "$name (absent)"
    continue
  fi

  if output="$("$cmd" --install-extension "$VSIX" --force 2>&1)"; then
    ok "$name"
    INSTALLED="$INSTALLED $name,"
  else
    err "$name : $output"
    FAILED="$FAILED $name,"
  fi
done

# --- Recapitulatif -----------------------------------------------------------------------

echo
step "Recapitulatif"

if [ -n "$INSTALLED" ]; then
  printf '%s  Installe sur :%s%s\n' "$C_OK" "${INSTALLED%,}" "$C_OFF"
  echo
  echo "  Redemarrez votre editeur, puis lancez la commande"
  echo "  « TIALAO ADB: Pair device with QR code » depuis la palette."
else
  printf '%s  Aucun editeur de la famille VS Code n%s a ete trouve.%s\n' "$C_WARN" "'" "$C_OFF"
  echo
  echo "  Vous pouvez tout de meme utiliser le CLI, qui fonctionne partout :"
  echo "    npm install -g tialao-adb-wireless"
  echo "    tadb pair-qr"
fi

if [ -n "$FAILED" ]; then
  printf '%s  Echecs :%s%s\n' "$C_ERR" "${FAILED%,}" "$C_OFF"
  exit 1
fi
