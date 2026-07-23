#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=desktop-package-common.sh
source "$ROOT/apps/desktop/scripts/desktop-package-common.sh"

release_fail() {
  echo "Release packaging preflight failed: $1" >&2
  exit 1
}

release_count_set_variables() {
  local count=0 name
  for name in "$@"; do
    if [[ -n "${!name:-}" ]]; then
      count=$((count + 1))
    fi
  done
  echo "$count"
}

release_require_complete_group() {
  local label="$1"
  shift
  local present
  present="$(release_count_set_variables "$@")"
  if [[ "$present" -gt 0 && "$present" -lt "$#" ]]; then
    release_fail "$label notarization credentials are incomplete (required: $*)."
  fi
  [[ "$present" -eq "$#" ]]
}

release_preflight() {
  local csc_link_set=0 csc_password_set=0 complete_groups=0

  [[ -n "${CSC_NAME:-}" ]] || release_fail "CSC_NAME is required."

  [[ -n "${CSC_LINK:-}" ]] && csc_link_set=1
  [[ -n "${CSC_KEY_PASSWORD:-}" ]] && csc_password_set=1
  if [[ "$csc_link_set" -ne "$csc_password_set" ]]; then
    release_fail "CSC_LINK and CSC_KEY_PASSWORD must be provided together."
  fi

  if release_require_complete_group \
    "App Store Connect API key" \
    APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER; then
    complete_groups=$((complete_groups + 1))
    [[ "${APPLE_API_KEY:-}" = /* ]] || release_fail "APPLE_API_KEY must be an absolute path."
    [[ -f "${APPLE_API_KEY:-}" ]] || release_fail "APPLE_API_KEY does not point to a file."
  fi

  if release_require_complete_group \
    "Apple ID" \
    APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID; then
    complete_groups=$((complete_groups + 1))
  fi

  if [[ -n "${APPLE_KEYCHAIN:-}" && -z "${APPLE_KEYCHAIN_PROFILE:-}" ]]; then
    release_fail "APPLE_KEYCHAIN requires APPLE_KEYCHAIN_PROFILE."
  fi
  if [[ -n "${APPLE_KEYCHAIN_PROFILE:-}" ]]; then
    complete_groups=$((complete_groups + 1))
  fi

  if [[ "$complete_groups" -ne 1 ]]; then
    release_fail "provide exactly one complete notarization credential group: API key, Apple ID, or Keychain profile."
  fi

  if [[ "$csc_link_set" -eq 0 ]]; then
    security find-identity -v -p codesigning | grep -F -- "$CSC_NAME" >/dev/null || \
      release_fail "CSC_NAME was not found in the macOS keychain."
  fi

  for command_name in codesign hdiutil spctl xcrun; do
    command -v "$command_name" >/dev/null || release_fail "required command is unavailable: $command_name."
  done

  echo "Release packaging preflight passed."
}

run_local_package() {
  export CSC_IDENTITY_AUTO_DISCOVERY=false
  desktop_initialize_paths "$ROOT" "$ROOT/dist"
  desktop_require_packaging_dependencies
  desktop_build_production_services
  desktop_prepare_codex_runtime required
  desktop_clean_output

  echo "Building unsigned macOS App, DMG, and updater ZIP..."
  npm --prefix "$ELECTRON_DIR" run dist:mac

  desktop_verify_packaged_runtime
  desktop_print_artifacts
}

run_local_smoke() {
  export CSC_IDENTITY_AUTO_DISCOVERY=false
  desktop_initialize_paths "$ROOT" "$ROOT/dist"
  desktop_verify_packaged_runtime
}

run_release() {
  release_preflight
  desktop_initialize_paths "$ROOT" "$ROOT/dist"
  desktop_require_packaging_dependencies
  desktop_build_production_services
  desktop_prepare_codex_runtime required
  desktop_clean_output

  echo "Building signed and notarized macOS release artifacts..."
  (
    cd "$ELECTRON_DIR"
    ./node_modules/.bin/electron-builder --mac --config electron-builder.release.cjs
  )

  desktop_verify_release_artifacts
  desktop_print_artifacts
}

private_test_preflight() {
  [[ -n "${CSC_LINK:-}" ]] || release_fail "CSC_LINK is required for a private test build."
  [[ -n "${CSC_KEY_PASSWORD:-}" ]] || release_fail "CSC_KEY_PASSWORD is required for a private test build."
  [[ -n "${CSC_NAME:-}" ]] || release_fail "CSC_NAME is required for a private test build."
}

run_private_test_package() {
  private_test_preflight
  desktop_initialize_paths "$ROOT" "$ROOT/dist"
  desktop_require_packaging_dependencies
  desktop_build_production_services
  desktop_prepare_codex_runtime required
  desktop_clean_output

  echo "Building self-signed private GitHub update test artifacts..."
  (
    cd "$ELECTRON_DIR"
    ./node_modules/.bin/electron-builder --mac --config electron-builder.private-test.cjs
  )

  desktop_verify_release_artifacts false
  desktop_print_artifacts
}

run_private_test_publish() {
  [[ -n "${GH_TOKEN:-}" ]] || release_fail "GH_TOKEN is required to publish a private GitHub Release."
  private_test_preflight
  desktop_initialize_paths "$ROOT" "$ROOT/dist"
  desktop_require_packaging_dependencies
  desktop_build_production_services
  desktop_prepare_codex_runtime required
  desktop_clean_output

  echo "Building and publishing self-signed private GitHub update test artifacts..."
  (
    cd "$ELECTRON_DIR"
    ./node_modules/.bin/electron-builder --mac --config electron-builder.private-test.cjs --publish always
  )

  desktop_verify_release_artifacts false
  desktop_print_artifacts
}

desktop_require_macos
case "${1:-}" in
  package) run_local_package ;;
  smoke) run_local_smoke ;;
  release) run_release ;;
  private-test-package) run_private_test_package ;;
  private-test-publish) run_private_test_publish ;;
  preflight) release_preflight ;;
  *)
    echo "Usage: $0 {package|smoke|release|private-test-package|private-test-publish|preflight}" >&2
    exit 2
    ;;
esac
