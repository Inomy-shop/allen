#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${SIGNING_ENV_FILE:-$REPO_ROOT/.env.signing.local}"
APP_PATH="$REPO_ROOT/packages/desktop/release/mac-arm64/Allen.app"
RELEASE_DIR="$REPO_ROOT/packages/desktop/release"

info() {
  printf '\n==> %s\n' "$1"
}

fail() {
  printf '\nERROR: %s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

load_env_file() {
  if [[ ! -f "$ENV_FILE" ]]; then
    fail "Signing env file not found: $ENV_FILE. Copy .env.signing.example to .env.signing.local and fill it in."
  fi

  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
}

has_notary_credentials() {
  if [[ -n "${APPLE_KEYCHAIN_PROFILE:-}" ]]; then
    return 0
  fi

  if [[ -n "${APPLE_ID:-}" || -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" || -n "${APPLE_TEAM_ID:-}" ]]; then
    [[ -n "${APPLE_ID:-}" ]] || fail "APPLE_ID is required when using Apple ID notarization."
    [[ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]] || fail "APPLE_APP_SPECIFIC_PASSWORD is required when using Apple ID notarization."
    [[ -n "${APPLE_TEAM_ID:-}" ]] || fail "APPLE_TEAM_ID is required when using Apple ID notarization."
    return 0
  fi

  if [[ -n "${APPLE_API_KEY:-}" || -n "${APPLE_API_KEY_ID:-}" || -n "${APPLE_API_ISSUER:-}" ]]; then
    [[ -n "${APPLE_API_KEY:-}" ]] || fail "APPLE_API_KEY is required when using API key notarization."
    [[ -n "${APPLE_API_KEY_ID:-}" ]] || fail "APPLE_API_KEY_ID is required when using API key notarization."
    [[ -n "${APPLE_API_ISSUER:-}" ]] || fail "APPLE_API_ISSUER is required when using API key notarization."
    [[ -f "$APPLE_API_KEY" ]] || fail "APPLE_API_KEY file does not exist: $APPLE_API_KEY"
    return 0
  fi

  return 1
}

validate_signing_identity() {
  if [[ -n "${CSC_LINK:-}" ]]; then
    [[ -f "$CSC_LINK" ]] || fail "CSC_LINK file does not exist: $CSC_LINK"
    [[ -n "${CSC_KEY_PASSWORD:-}" ]] || fail "CSC_KEY_PASSWORD is required when CSC_LINK is set."
    info "Using Developer ID certificate from CSC_LINK."
    return
  fi

  local identities
  identities="$(security find-identity -v -p codesigning 2>/dev/null | grep "Developer ID Application" || true)"

  if [[ -n "${CSC_NAME:-}" ]]; then
    printf '%s\n' "$identities" | grep -F "$CSC_NAME" >/dev/null 2>&1 || fail "CSC_NAME was not found in local signing identities: $CSC_NAME"
    info "Using Keychain signing identity: $CSC_NAME"
    return
  fi

  local identity_count
  identity_count="$(printf '%s\n' "$identities" | sed '/^[[:space:]]*$/d' | wc -l | tr -d ' ')"

  if [[ "$identity_count" == "0" ]]; then
    fail "No Developer ID Application signing identity found. Install the .cer generated from your CSR, or configure CSC_LINK to a .p12."
  fi

  if [[ "$identity_count" != "1" ]]; then
    printf '%s\n' "$identities"
    fail "Multiple Developer ID Application identities found. Set CSC_NAME in $ENV_FILE to the exact identity to use."
  fi

  info "Using the only available Developer ID Application identity."
}

validate_notary_credentials() {
  has_notary_credentials || fail "No notarization credentials found. Set APPLE_KEYCHAIN_PROFILE, Apple ID credentials, or API key credentials in $ENV_FILE."

  if [[ -n "${APPLE_KEYCHAIN_PROFILE:-}" ]]; then
    info "Testing notarytool keychain profile: $APPLE_KEYCHAIN_PROFILE"
    xcrun notarytool history --keychain-profile "$APPLE_KEYCHAIN_PROFILE" >/dev/null
    return
  fi

  if [[ -n "${APPLE_ID:-}" ]]; then
    info "Testing Apple ID notarization credentials for team: $APPLE_TEAM_ID"
    xcrun notarytool history \
      --apple-id "$APPLE_ID" \
      --team-id "$APPLE_TEAM_ID" \
      --password "$APPLE_APP_SPECIFIC_PASSWORD" >/dev/null
    return
  fi

  info "Testing App Store Connect API key notarization credentials."
  xcrun notarytool history \
    --key "$APPLE_API_KEY" \
    --key-id "$APPLE_API_KEY_ID" \
    --issuer "$APPLE_API_ISSUER" >/dev/null
}

prompt_version_bump() {
  local current_version="$1"
  local choice
  local exact_version

  [[ -t 0 ]] || fail "RELEASE_VERSION_BUMP is set to ask, but this shell is not interactive. Set RELEASE_VERSION_BUMP to patch, minor, major, none, or an exact version."

  printf '\nCurrent version: %s\n' "$current_version" >&2
  printf 'Choose release version bump:\n' >&2
  printf '  1) patch\n' >&2
  printf '  2) minor\n' >&2
  printf '  3) major\n' >&2
  printf '  4) none\n' >&2
  printf '  5) exact version\n' >&2

  while true; do
    printf 'Select [1-5, default 1]: ' >&2
    read -r choice
    choice="${choice:-1}"

    case "$choice" in
      1|p|patch|Patch|PATCH)
        printf 'patch\n'
        return
        ;;
      2|m|minor|Minor|MINOR)
        printf 'minor\n'
        return
        ;;
      3|M|major|Major|MAJOR)
        printf 'major\n'
        return
        ;;
      4|n|none|None|NONE|skip|Skip|SKIP)
        printf 'none\n'
        return
        ;;
      5|e|exact|Exact|EXACT)
        printf 'Enter exact version, for example 1.2.3: ' >&2
        read -r exact_version
        if [[ "$exact_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]]; then
          printf '%s\n' "$exact_version"
          return
        fi
        printf 'Invalid version. Use semver like 1.2.3.\n' >&2
        ;;
      *)
        printf 'Invalid choice. Select 1, 2, 3, 4, or 5.\n' >&2
        ;;
    esac
  done
}

bump_versions() {
  local version_bump="${RELEASE_VERSION_BUMP:-ask}"
  local before_version
  local after_version

  before_version="$(node -p "require('./package.json').version")"

  case "$version_bump" in
    ask|prompt|interactive)
      version_bump="$(prompt_version_bump "$before_version")"
      ;;
  esac

  case "$version_bump" in
    none|skip)
      info "Skipping version bump."
      return
      ;;
    patch|minor|major|prepatch|preminor|premajor|prerelease|[0-9]*.[0-9]*.[0-9]*)
      ;;
    *)
      fail "Unsupported RELEASE_VERSION_BUMP value: $version_bump. Use patch, minor, major, prerelease, an exact semver like 1.2.3, or none."
      ;;
  esac

  info "Bumping release version from $before_version using: $version_bump"
  npm version "$version_bump" --no-git-tag-version --allow-same-version >/dev/null

  after_version="$(node -p "require('./package.json').version")"
  npm version "$after_version" --workspace @allen/desktop --no-git-tag-version --allow-same-version >/dev/null
  info "Release version is now $after_version."
}

verify_artifacts() {
  [[ -d "$APP_PATH" ]] || fail "Built app not found: $APP_PATH"

  info "Verifying code signature."
  codesign --verify --deep --strict --verbose=2 "$APP_PATH"

  info "Checking Gatekeeper assessment."
  spctl --assess --type execute --verbose "$APP_PATH"

  info "Validating stapled notarization ticket."
  xcrun stapler validate "$APP_PATH"

  info "Release artifacts:"
  find "$RELEASE_DIR" -maxdepth 1 -type f \( -name "*.dmg" -o -name "*.zip" -o -name "*.yml" -o -name "*.blockmap" \) -print | sort
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  fail "macOS release signing must run on macOS."
fi

require_command npm
require_command security
require_command codesign
require_command spctl
require_command xcrun

info "Loading signing env: $ENV_FILE"
load_env_file
validate_signing_identity
validate_notary_credentials

cd "$REPO_ROOT"
bump_versions

info "Building signed and notarized macOS release."
npm --workspace @allen/desktop run dist:mac

verify_artifacts

info "Done. Upload the DMG for public download. Upload ZIP, blockmap, and latest-mac.yml too if you want auto-update."
