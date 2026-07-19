#!/usr/bin/env bash

# Shared macOS packaging helpers used by desktop-macos.sh.

desktop_require_macos() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "This script builds the macOS desktop package and must run on macOS." >&2
    return 1
  fi
}

desktop_initialize_paths() {
  local root="$1"
  local dist_dir="$2"
  local node_arch host_arch

  ROOT="$root"
  ELECTRON_DIR="$ROOT/apps/desktop"
  DIST_DIR="$dist_dir"
  PRODUCT_NAME="$(node -p "const p=require(process.argv[1]); p.build?.productName || p.productName || p.name" "$ELECTRON_DIR/package.json")"
  PACKAGE_VERSION="$(node -p "require(process.argv[1]).version" "$ELECTRON_DIR/package.json")"
  node_arch="$(node -p 'process.arch')"
  case "$(uname -m)" in
    arm64) host_arch="arm64" ;;
    x86_64) host_arch="x64" ;;
    *)
      echo "Unsupported host architecture: $(uname -m)" >&2
      return 1
      ;;
  esac

  case "$node_arch" in
    arm64) ARCH="arm64" ;;
    x64) ARCH="x64" ;;
    *)
      echo "Unsupported Node architecture: $node_arch" >&2
      return 1
      ;;
  esac
  if [[ "$ARCH" != "$host_arch" ]]; then
    echo "Node architecture ($ARCH) does not match the host architecture ($host_arch)." >&2
    echo "Use a native Node.js runtime before packaging." >&2
    return 1
  fi

  if [[ "$ARCH" = "x64" ]]; then
    APP_DIR="$DIST_DIR/mac"
  else
    APP_DIR="$DIST_DIR/mac-$ARCH"
  fi

  APP_PATH="$APP_DIR/$PRODUCT_NAME.app"
  DMG_PATH="$DIST_DIR/$PRODUCT_NAME-$PACKAGE_VERSION-$ARCH.dmg"
  DMG_BLOCKMAP_PATH="$DMG_PATH.blockmap"
  export COPYFILE_DISABLE=1
}

desktop_remove_path() {
  local target="$1"
  [[ -e "$target" ]] || return 0

  for _ in 1 2 3 4 5; do
    rm -rf "$target" 2>/dev/null || true
    [[ ! -e "$target" ]] && return 0

    if [[ -d "$target" ]]; then
      find "$target" -name ".DS_Store" -delete 2>/dev/null || true
      find "$target" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true
      rmdir "$target" 2>/dev/null || true
    fi

    [[ ! -e "$target" ]] && return 0
    sleep 0.4
  done

  echo "Failed to remove $target" >&2
  find "$target" -maxdepth 2 -print 2>/dev/null >&2 || true
  return 1
}

desktop_prepare_codex_runtime() {
  local required="${1:-optional}"
  local runtime_root platform_dir target_dir target manifest source source_manifest stage_dir stage_target stage_manifest

  runtime_root="$ELECTRON_DIR/resources/codex-runtime"
  platform_dir="darwin-$ARCH"
  target_dir="$runtime_root/$platform_dir"
  target="$target_dir/codex"
  manifest="$target_dir/manifest.json"
  source="${SQUADFLOW_BUNDLED_CODEX_COMMAND:-}"

  mkdir -p "$runtime_root"
  find "$runtime_root" -maxdepth 1 -type d -name ".${platform_dir}.staging.*" -exec rm -rf {} +
  if [[ -d "$target_dir" ]]; then
    find "$target_dir" -maxdepth 1 -type f \
      \( -name '.codex.*' -o -name '.manifest.*' \) -exec rm -f {} +
  fi

  if [[ -n "$source" ]]; then
    if [[ ! -f "$source" ]]; then
      echo "SQUADFLOW_BUNDLED_CODEX_COMMAND points to a missing file: $source" >&2
      return 1
    fi
    source_manifest="${SQUADFLOW_BUNDLED_CODEX_MANIFEST:-$(dirname "$source")/manifest.json}"
    if [[ ! -f "$source_manifest" ]]; then
      echo "Bundled Codex manifest is missing: $source_manifest" >&2
      return 1
    fi

    echo "Preparing bundled Codex runtime from $source"
    desktop_verify_codex_runtime "$platform_dir" "$source" "$source_manifest"
    if [[ "$source" != "$target" || "$source_manifest" != "$manifest" ]]; then
      stage_dir="$(mktemp -d "$runtime_root/.${platform_dir}.staging.XXXXXX")"
      stage_target="$stage_dir/codex"
      stage_manifest="$stage_dir/manifest.json"
      if ! cp "$source" "$stage_target" || ! cp "$source_manifest" "$stage_manifest"; then
        rm -rf "$stage_dir"
        return 1
      fi
      chmod 755 "$stage_target"
      if ! desktop_verify_codex_runtime "$platform_dir" "$stage_target" "$stage_manifest"; then
        rm -rf "$stage_dir"
        return 1
      fi
      mkdir -p "$target_dir"
      if ! mv -f "$stage_target" "$target" || ! mv -f "$stage_manifest" "$manifest"; then
        rm -rf "$stage_dir"
        echo "Failed to install the verified bundled Codex runtime pair." >&2
        return 1
      fi
      rmdir "$stage_dir"
    fi
  fi

  if [[ ! -x "$target" || ! -f "$manifest" ]]; then
    if [[ "$required" = "required" ]]; then
      echo "Packaging requires a verified bundled Codex runtime and manifest:" >&2
      echo "  Binary: $target" >&2
      echo "  Manifest: $manifest" >&2
      return 1
    fi
    echo "Warning: verified bundled Codex runtime is missing for $platform_dir." >&2
    echo "  Run apps/desktop/scripts/build-bundled-codex.sh before packaging." >&2
    return 0
  fi

  desktop_verify_codex_runtime "$platform_dir" "$target" "$manifest"
}

desktop_verify_codex_runtime() {
  local platform_dir="$1"
  local binary="$2"
  local manifest="$3"
  local lock_file="$ELECTRON_DIR/resources/codex-runtime/codex-0.120.0.lock.json"

  node "$ELECTRON_DIR/scripts/verify-bundled-codex.mjs" \
    --lock "$lock_file" \
    --manifest "$manifest" \
    --binary "$binary" \
    --platform "$platform_dir"
}

desktop_require_packaging_dependencies() {
  if [[ ! -f "$ELECTRON_DIR/package.json" ]]; then
    echo "Cannot find apps/desktop/package.json under $ROOT" >&2
    return 1
  fi

  for package_dir in apps/local-service apps/renderer apps/desktop; do
    if [[ ! -d "$ROOT/$package_dir/node_modules" ]]; then
      echo "Dependencies are missing for $package_dir. Run: npm run setup" >&2
      return 1
    fi
  done
}

desktop_prepare_runtime_staging() {
  local stage_root="$ELECTRON_DIR/.staging/runtime"
  local stage_renderer="$stage_root/renderer"
  local standalone_renderer="$ROOT/apps/renderer/.next/standalone"

  echo "Assembling packaged renderer runtime..."
  desktop_remove_path "$stage_root"
  mkdir -p "$stage_renderer"
  cp -R "$standalone_renderer/." "$stage_renderer/"

  [[ -d "$stage_renderer/node_modules" ]] || {
    echo "Standalone renderer dependencies are missing from $standalone_renderer/node_modules" >&2
    return 1
  }
  mv "$stage_renderer/node_modules" "$stage_renderer/runtime_modules"
  cp "$ELECTRON_DIR/renderer-service.cjs" "$stage_renderer/renderer-service.cjs"

  mkdir -p "$stage_renderer/.next"
  cp -R "$ROOT/apps/renderer/.next/static" "$stage_renderer/.next/static"
  if [[ -d "$ROOT/apps/renderer/public" ]]; then
    cp -R "$ROOT/apps/renderer/public" "$stage_renderer/public"
  fi

  [[ -f "$stage_renderer/server.js" ]] || {
    echo "Staged renderer entry is missing: $stage_renderer/server.js" >&2
    return 1
  }
  [[ -f "$stage_renderer/renderer-service.cjs" ]] || {
    echo "Staged renderer launcher is missing: $stage_renderer/renderer-service.cjs" >&2
    return 1
  }
  [[ -f "$stage_renderer/runtime_modules/next/package.json" ]] || {
    echo "Staged Next.js runtime is missing: $stage_renderer/runtime_modules/next/package.json" >&2
    return 1
  }

  node "$ELECTRON_DIR/scripts/stage-runtime-licenses.mjs" "$stage_renderer" "$stage_root/legal"
}

desktop_build_production_services() {
  local node_major

  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  if [[ "$node_major" != "22" ]]; then
    echo "Production desktop services require Node.js 22; current major is $node_major." >&2
    return 1
  fi

  echo "Building production local service and standalone renderer..."
  npm --prefix "$ROOT" run build

  [[ -f "$ROOT/apps/local-service/dist/main.js" ]] || {
    echo "Production local-service output is missing: $ROOT/apps/local-service/dist/main.js" >&2
    return 1
  }
  # The asar root package.json is CJS (desktop). Node resolves module type from the nearest
  # package.json, so dist ships its own minimal ESM marker; the dist copy rule places it in
  # the asar as local-service/package.json. Prevents MODULE_TYPELESS_PACKAGE_JSON at startup.
  printf '{\n  "type": "module"\n}\n' > "$ROOT/apps/local-service/dist/package.json"
  [[ -f "$ROOT/apps/renderer/.next/standalone/server.js" ]] || {
    echo "Standalone renderer output is missing: $ROOT/apps/renderer/.next/standalone/server.js" >&2
    return 1
  }

  desktop_prepare_runtime_staging
}

desktop_clean_output() {
  echo "Cleaning old desktop package output..."
  desktop_remove_path "$DIST_DIR"
  mkdir -p "$DIST_DIR"
}

desktop_verify_artifacts() {
  local update_zip legal_file

  if [[ ! -d "$APP_PATH" ]]; then
    echo "Packaged app not found: $APP_PATH" >&2
    return 1
  fi
  if [[ ! -f "$DMG_PATH" ]]; then
    echo "Packaged DMG not found: $DMG_PATH" >&2
    return 1
  fi
  update_zip="$(find "$DIST_DIR" -maxdepth 1 -type f -name "$PRODUCT_NAME-$PACKAGE_VERSION-$ARCH*.zip" -print -quit)"
  if [[ -z "$update_zip" ]]; then
    echo "Packaged update ZIP not found for $PRODUCT_NAME $PACKAGE_VERSION $ARCH under $DIST_DIR" >&2
    return 1
  fi

  for legal_file in \
    LICENSE \
    NOTICE \
    THIRD_PARTY_NOTICES.md \
    third-party/LGPL-3.0-or-later.txt \
    third-party/GPL-3.0.txt \
    third-party/sharp-libvips-1.2.4-THIRD-PARTY-NOTICES.md \
    runtime/runtime-packages.json; do
    [[ -f "$APP_PATH/Contents/Resources/legal/$legal_file" ]] || {
      echo "Packaged legal file is missing: $legal_file" >&2
      return 1
    }
  done

  echo "Verifying packaged local-service module type..."
  node -e '
    const asar = require(require.resolve("@electron/asar", { paths: [process.argv[2]] }));
    const pkg = JSON.parse(asar.extractFile(process.argv[1], "local-service/package.json").toString("utf8"));
    if (pkg.type !== "module") throw new Error("asar local-service/package.json must declare \"type\": \"module\"");
  ' "$APP_PATH/Contents/Resources/app.asar" "$ELECTRON_DIR" || {
    echo "Packaged app.asar is missing an ESM local-service/package.json." >&2
    return 1
  }

  echo "Verifying DMG..."
  hdiutil verify "$DMG_PATH"
}

desktop_verify_packaged_runtime() (
  set -euo pipefail

  local executable="$APP_PATH/Contents/MacOS/$PRODUCT_NAME"
  local temp_dir smoke_pid backend_ready=0 frontend_ready=0
  local ports_file backend_port="" renderer_port=""

  desktop_verify_artifacts
  [[ -x "$executable" ]] || {
    echo "Packaged executable is missing: $executable" >&2
    exit 1
  }

  temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/squadflow-package-smoke.XXXXXX")"
  cleanup_package_smoke() {
    if [[ -n "${smoke_pid:-}" ]] && kill -0 "$smoke_pid" 2>/dev/null; then
      kill "$smoke_pid" 2>/dev/null || true
      wait "$smoke_pid" 2>/dev/null || true
    fi
    rm -rf "$temp_dir"
  }
  trap cleanup_package_smoke EXIT

  echo "Running self-contained packaged App smoke test..."
  mkdir -p "$temp_dir/home" "$temp_dir/user-data"
  /usr/bin/env -i \
    "HOME=$temp_dir/home" \
    "PATH=${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}" \
    "TMPDIR=${TMPDIR:-/tmp}" \
    "LANG=${LANG:-en_US.UTF-8}" \
    "$executable" \
    --user-data-dir="$temp_dir/user-data" \
    >"$temp_dir/app.log" 2>&1 &
  smoke_pid="$!"

  ports_file="$temp_dir/user-data/service-ports.json"
  for _ in {1..60}; do
    kill -0 "$smoke_pid" 2>/dev/null || break
    if [[ -z "$backend_port" && -f "$ports_file" ]]; then
      backend_port="$(node -p "require(process.argv[1]).backend || ''" "$ports_file" 2>/dev/null || true)"
      renderer_port="$(node -p "require(process.argv[1]).renderer || ''" "$ports_file" 2>/dev/null || true)"
    fi
    if [[ -n "$backend_port" && -n "$renderer_port" ]]; then
      curl --max-time 2 -fsS "http://127.0.0.1:$backend_port/health" >/dev/null 2>&1 && backend_ready=1
      curl --max-time 2 -fsS "http://127.0.0.1:$renderer_port/" >/dev/null 2>&1 && frontend_ready=1
    fi
    [[ "$backend_ready" = "1" && "$frontend_ready" = "1" ]] && break
    sleep 1
  done

  if [[ "$backend_ready" != "1" || "$frontend_ready" != "1" ]]; then
    echo "Packaged services did not become ready (backend=$backend_ready frontend=$frontend_ready)." >&2
    sed -n '1,240p' "$temp_dir/app.log" >&2
    find "$temp_dir" -type f -name '*.log' -not -path "$temp_dir/app.log" -exec sh -c 'echo "LOG $1"; sed -n "1,240p" "$1"' _ {} \; >&2
    exit 1
  fi

  find "$temp_dir" -type f -name 'squadflow.db' -print -quit | grep -q . || {
    echo "Packaged backend became ready but did not create its application database." >&2
    exit 1
  }

  if grep -R -I -q "MODULE_TYPELESS_PACKAGE_JSON" "$temp_dir"; then
    echo "Packaged startup logs contain MODULE_TYPELESS_PACKAGE_JSON; the local-service ESM marker is missing." >&2
    grep -R -I -n "MODULE_TYPELESS_PACKAGE_JSON" "$temp_dir" >&2 || true
    exit 1
  fi
  echo "Self-contained packaged App smoke test passed."
)

desktop_launch_release_smoke() {
  local executable="$1"
  local user_data_dir="$2"
  local log_path="$3"
  local smoke_home

  smoke_home="${HOME:-$(dirname "$user_data_dir")/home}"
  /usr/bin/env -i \
    "HOME=$smoke_home" \
    "PATH=${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}" \
    "TMPDIR=${TMPDIR:-/tmp}" \
    "USER=${USER:-}" \
    "LOGNAME=${LOGNAME:-${USER:-}}" \
    "LANG=${LANG:-en_US.UTF-8}" \
    "$executable" \
    --user-data-dir="$user_data_dir" \
    >"$log_path" 2>&1 &
  DESKTOP_SMOKE_PID="$!"
}

desktop_release_log_contains_credential() {
  local log_path="$1"
  local name value

  while IFS= read -r name; do
    case "$name" in
      CSC_*|APPLE_*) ;;
      *) continue ;;
    esac
    value="${!name:-}"
    [[ -n "$value" ]] || continue
    if grep -Fq -- "$value" "$log_path"; then
      return 0
    fi
  done < <(compgen -v)

  return 1
}

desktop_verify_release_artifacts() (
  set -euo pipefail
  umask 077

  local bundled_codex="$APP_PATH/Contents/Resources/codex-runtime/darwin-$ARCH/codex"
  local bundled_codex_manifest="$APP_PATH/Contents/Resources/codex-runtime/darwin-$ARCH/manifest.json"
  local app_executable="$PRODUCT_NAME"
  local temp_dir mount_dir mounted_app mounted_codex smoke_pid

  desktop_verify_artifacts

  echo "Verifying release signatures and notarization ticket..."
  codesign --verify --deep --strict --verbose=2 "$APP_PATH"
  [[ -x "$bundled_codex" ]] || {
    echo "Bundled Codex runtime not found in release app: $bundled_codex" >&2
    exit 1
  }
  [[ ! -e "$bundled_codex_manifest" ]] || {
    echo "Release app must not contain the pre-signing Codex manifest: $bundled_codex_manifest" >&2
    exit 1
  }
  codesign --verify --strict --verbose=2 "$bundled_codex"
  spctl --assess --type execute --verbose=4 "$APP_PATH"
  xcrun stapler validate "$APP_PATH"

  temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/squadflow-release-verify.XXXXXX")"
  mount_dir="$temp_dir/mount"
  mkdir -p "$mount_dir"

  cleanup_release_verification() {
    local helper_pids
    if [[ -n "${smoke_pid:-}" ]] && kill -0 "$smoke_pid" 2>/dev/null; then
      kill "$smoke_pid" 2>/dev/null || true
      wait "$smoke_pid" 2>/dev/null || true
    fi
    if [[ -n "${mounted_app:-}" ]]; then
      helper_pids="$(pgrep -f "$mounted_app/" || true)"
      if [[ -n "$helper_pids" ]]; then
        # shellcheck disable=SC2086
        kill $helper_pids 2>/dev/null || true
      fi
    fi
    hdiutil detach "$mount_dir" -quiet 2>/dev/null || true
    rm -rf "$temp_dir"
  }
  trap cleanup_release_verification EXIT

  echo "Mounting DMG and verifying the distributed app..."
  hdiutil attach "$DMG_PATH" -readonly -nobrowse -mountpoint "$mount_dir" >/dev/null
  mounted_app="$mount_dir/$PRODUCT_NAME.app"
  mounted_codex="$mounted_app/Contents/Resources/codex-runtime/darwin-$ARCH/codex"
  [[ -d "$mounted_app" ]] || {
    echo "Mounted DMG does not contain $PRODUCT_NAME.app" >&2
    exit 1
  }
  [[ ! -e "$mounted_app/Contents/Resources/codex-runtime/darwin-$ARCH/manifest.json" ]] || {
    echo "Distributed app contains a stale pre-signing Codex manifest." >&2
    exit 1
  }
  codesign --verify --deep --strict --verbose=2 "$mounted_app"
  codesign --verify --strict --verbose=2 "$mounted_codex"
  spctl --assess --type execute --verbose=4 "$mounted_app"
  xcrun stapler validate "$mounted_app"

  echo "Running packaged app startup smoke test..."
  desktop_launch_release_smoke \
    "$mounted_app/Contents/MacOS/$app_executable" \
    "$temp_dir/user-data" \
    "$temp_dir/app-smoke.log"
  smoke_pid="$DESKTOP_SMOKE_PID"
  sleep 5
  if ! kill -0 "$smoke_pid" 2>/dev/null; then
    echo "Packaged app exited during startup smoke test:" >&2
    if desktop_release_log_contains_credential "$temp_dir/app-smoke.log"; then
      echo "Startup log suppressed because it contained signing or notarization credential material." >&2
    else
      cat "$temp_dir/app-smoke.log" >&2
    fi
    exit 1
  fi
  kill "$smoke_pid" 2>/dev/null || true
  wait "$smoke_pid" 2>/dev/null || true
  smoke_pid=""
)

desktop_print_artifacts() {
  local update_zip
  update_zip="$(find "$DIST_DIR" -maxdepth 1 -type f -name "$PRODUCT_NAME-$PACKAGE_VERSION-$ARCH*.zip" -print -quit)"
  echo
  echo "Desktop package ready:"
  echo "  App: $APP_PATH"
  echo "  DMG: $DMG_PATH"
  echo "  Update ZIP: $update_zip"
}
