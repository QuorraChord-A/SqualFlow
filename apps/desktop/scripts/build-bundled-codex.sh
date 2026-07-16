#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
LOCK_FILE="$ROOT/apps/desktop/resources/codex-runtime/codex-0.120.0.lock.json"
BUILD_ROOT="${SQUADFLOW_CODEX_BUILD_ROOT:-$ROOT/.artifacts/codex-runtime}"
TARGET_TRIPLE=""
HOST_TARGET_TRIPLE=""

for arg in "$@"; do
  case "$arg" in
    --target=*) TARGET_TRIPLE="${arg#*=}" ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Bundled Codex builds must run on macOS." >&2
  exit 1
fi
for command_name in git node shasum codesign file; do
  command -v "$command_name" >/dev/null || {
    echo "Required build command is unavailable: $command_name" >&2
    exit 1
  }
done
if [[ ! -x /usr/bin/lockf ]]; then
  echo "Required build command is unavailable: /usr/bin/lockf" >&2
  exit 1
fi

case "$(uname -m)" in
    arm64) HOST_TARGET_TRIPLE="aarch64-apple-darwin" ;;
    x86_64) HOST_TARGET_TRIPLE="x86_64-apple-darwin" ;;
    *)
      echo "Unsupported build architecture: $(uname -m)" >&2
      exit 1
      ;;
esac

if [[ -z "$TARGET_TRIPLE" ]]; then
  TARGET_TRIPLE="$HOST_TARGET_TRIPLE"
fi
if [[ "$TARGET_TRIPLE" != "$HOST_TARGET_TRIPLE" ]]; then
  echo "Cross-architecture bundled Codex builds are not supported." >&2
  echo "Run this script on a $TARGET_TRIPLE host instead." >&2
  exit 1
fi

case "$TARGET_TRIPLE" in
  aarch64-apple-darwin) PLATFORM_DIR="darwin-arm64" ;;
  x86_64-apple-darwin) PLATFORM_DIR="darwin-x64" ;;
  *)
    echo "Unsupported bundled Codex target: $TARGET_TRIPLE" >&2
    exit 1
    ;;
esac

mkdir -p "$BUILD_ROOT"
BUILD_LOCK_FILE="$BUILD_ROOT/.build.lock"
exec 9>"$BUILD_LOCK_FILE"
if ! /usr/bin/lockf -s -t 0 9; then
  echo "Another bundled Codex build is already running under $BUILD_ROOT." >&2
  exit 1
fi

RUNTIME_VERSION="$(node -p 'require(process.argv[1]).runtimeVersion' "$LOCK_FILE")"
VARIANT="$(node -p 'require(process.argv[1]).variant' "$LOCK_FILE")"
UPSTREAM_REPOSITORY="$(node -p 'require(process.argv[1]).upstream.repository' "$LOCK_FILE")"
UPSTREAM_COMMIT="$(node -p 'require(process.argv[1]).upstream.commit' "$LOCK_FILE")"
RUST_TOOLCHAIN="$(node -p 'require(process.argv[1]).rustToolchain' "$LOCK_FILE")"

export CARGO_HOME="${SQUADFLOW_CODEX_CARGO_HOME:-${CARGO_HOME:-$ROOT/.artifacts/rust/cargo}}"
export RUSTUP_HOME="${SQUADFLOW_CODEX_RUSTUP_HOME:-${RUSTUP_HOME:-$ROOT/.artifacts/rust/rustup}}"
export CARGO_TARGET_DIR="$BUILD_ROOT/target/$TARGET_TRIPLE"
mkdir -p "$CARGO_HOME" "$RUSTUP_HOME" "$CARGO_TARGET_DIR"

if [[ -x "$CARGO_HOME/bin/rustup" ]]; then
  RUSTUP="$CARGO_HOME/bin/rustup"
else
  RUSTUP="$(command -v rustup || true)"
fi
if [[ -z "$RUSTUP" ]]; then
  echo "Rustup is required to build bundled Codex $RUNTIME_VERSION." >&2
  echo "Install rustup, or set SQUADFLOW_CODEX_CARGO_HOME and SQUADFLOW_CODEX_RUSTUP_HOME." >&2
  exit 1
fi

while IFS=$'\t' read -r patch_path expected_sha; do
  patch_file="$ROOT/apps/desktop/resources/codex-runtime/$patch_path"
  [[ -f "$patch_file" ]] || {
    echo "Bundled Codex patch is missing: $patch_file" >&2
    exit 1
  }
  actual_sha="$(shasum -a 256 "$patch_file" | awk '{print $1}')"
  [[ "$actual_sha" = "$expected_sha" ]] || {
    echo "Bundled Codex patch SHA-256 mismatch: $patch_path" >&2
    exit 1
  }
done < <(node -e '
  const lock = require(process.argv[1]);
  for (const patch of lock.patches ?? []) process.stdout.write(`${patch.path}\t${patch.sha256}\n`);
' "$LOCK_FILE")

SOURCE_DIR="$(mktemp -d "$BUILD_ROOT/source.XXXXXX")"
cleanup() {
  rm -rf "$SOURCE_DIR"
}
trap cleanup EXIT

echo "Fetching Codex $RUNTIME_VERSION at $UPSTREAM_COMMIT..."
git -C "$SOURCE_DIR" init -q
git -C "$SOURCE_DIR" remote add origin "$UPSTREAM_REPOSITORY"
git -C "$SOURCE_DIR" fetch -q --depth 1 origin "$UPSTREAM_COMMIT"
git -C "$SOURCE_DIR" checkout -q --detach FETCH_HEAD
[[ "$(git -C "$SOURCE_DIR" rev-parse HEAD)" = "$UPSTREAM_COMMIT" ]] || {
  echo "Fetched Codex commit does not match the lock file." >&2
  exit 1
}

while IFS= read -r patch_path; do
  patch_file="$ROOT/apps/desktop/resources/codex-runtime/$patch_path"
  git -C "$SOURCE_DIR" apply --check "$patch_file"
  git -C "$SOURCE_DIR" apply "$patch_file"
done < <(node -e '
  const lock = require(process.argv[1]);
  for (const patch of lock.patches ?? []) process.stdout.write(`${patch.path}\n`);
' "$LOCK_FILE")

export SQUADFLOW_CODEX_LOCK_FILE="$LOCK_FILE"
export SQUADFLOW_CODEX_SOURCE_DIR="$SOURCE_DIR"
node --input-type=module -e '
  import { createHash } from "node:crypto";
  import { readFileSync, writeFileSync } from "node:fs";

  const lock = JSON.parse(readFileSync(process.env.SQUADFLOW_CODEX_LOCK_FILE, "utf8"));
  const normalization = lock.cargoLockNormalization;
  const path = `${process.env.SQUADFLOW_CODEX_SOURCE_DIR}/codex-rs/Cargo.lock`;
  const source = readFileSync(path, "utf8");
  const sourceSha = createHash("sha256").update(source).digest("hex");
  if (sourceSha !== normalization.sourceSha256) throw new Error("upstream Cargo.lock SHA-256 mismatch");
  const replacementCount = source.split(normalization.from).length - 1;
  if (replacementCount !== normalization.replacementCount) {
    throw new Error(`expected ${normalization.replacementCount} Cargo.lock replacements, found ${replacementCount}`);
  }
  const normalized = source.replaceAll(normalization.from, normalization.to);
  const normalizedSha = createHash("sha256").update(normalized).digest("hex");
  if (normalizedSha !== normalization.normalizedSha256) throw new Error("normalized Cargo.lock SHA-256 mismatch");
  writeFileSync(path, normalized);
'

"$RUSTUP" toolchain install "$RUST_TOOLCHAIN" --profile minimal
"$RUSTUP" target add --toolchain "$RUST_TOOLCHAIN" "$TARGET_TRIPLE"
export RUSTUP_TOOLCHAIN="$RUST_TOOLCHAIN"
export RUSTFLAGS="${RUSTFLAGS:+$RUSTFLAGS }--remap-path-prefix=$SOURCE_DIR=/usr/src/codex"
CARGO_COMMAND=("$RUSTUP" run "$RUST_TOOLCHAIN" cargo)
RUSTC_COMMAND=("$RUSTUP" run "$RUST_TOOLCHAIN" rustc)
CARGO_VERSION="$("${CARGO_COMMAND[@]}" --version)"
RUSTC_VERSION="$("${RUSTC_COMMAND[@]}" --version)"
[[ "$CARGO_VERSION" == "cargo $RUST_TOOLCHAIN "* ]] || {
  echo "Locked Cargo toolchain is unavailable: $CARGO_VERSION" >&2
  exit 1
}
[[ "$RUSTC_VERSION" == "rustc $RUST_TOOLCHAIN "* ]] || {
  echo "Locked Rust toolchain is unavailable: $RUSTC_VERSION" >&2
  exit 1
}

echo "Running bundled Codex compatibility tests..."
(
  cd "$SOURCE_DIR/codex-rs"
  "${CARGO_COMMAND[@]}" test --locked -p codex-api completed_with_
  "${CARGO_COMMAND[@]}" test --locked -p codex-protocol unknown_cached_tokens_
)

echo "Building bundled Codex for $TARGET_TRIPLE..."
(
  cd "$SOURCE_DIR/codex-rs"
  "${CARGO_COMMAND[@]}" build --locked --release --target "$TARGET_TRIPLE" -p codex-cli --bin codex
)

BUILT_BINARY="$CARGO_TARGET_DIR/$TARGET_TRIPLE/release/codex"
OUTPUT_DIR="$BUILD_ROOT/runtime/$PLATFORM_DIR"
OUTPUT_BINARY="$OUTPUT_DIR/codex"
OUTPUT_MANIFEST="$OUTPUT_DIR/manifest.json"
mkdir -p "$OUTPUT_DIR"
cp "$BUILT_BINARY" "$OUTPUT_BINARY"
chmod 755 "$OUTPUT_BINARY"
codesign --force --sign - "$OUTPUT_BINARY" >/dev/null

export SQUADFLOW_CODEX_LOCK_FILE="$LOCK_FILE"
export SQUADFLOW_CODEX_OUTPUT_BINARY="$OUTPUT_BINARY"
export SQUADFLOW_CODEX_OUTPUT_MANIFEST="$OUTPUT_MANIFEST"
export SQUADFLOW_CODEX_PLATFORM_DIR="$PLATFORM_DIR"
export SQUADFLOW_CODEX_TARGET_TRIPLE="$TARGET_TRIPLE"
export SQUADFLOW_CODEX_CARGO_VERSION="$CARGO_VERSION"
export SQUADFLOW_CODEX_RUSTC_VERSION="$RUSTC_VERSION"
node --input-type=module -e '
  import { execFileSync } from "node:child_process";
  import { createHash } from "node:crypto";
  import { readFileSync, writeFileSync } from "node:fs";

  const lock = JSON.parse(readFileSync(process.env.SQUADFLOW_CODEX_LOCK_FILE, "utf8"));
  const binary = process.env.SQUADFLOW_CODEX_OUTPUT_BINARY;
  const manifest = {
    schemaVersion: 1,
    runtimeVersion: lock.runtimeVersion,
    variant: lock.variant,
    rustToolchain: lock.rustToolchain,
    upstreamCommit: lock.upstream.commit,
    patches: lock.patches,
    cargoLockNormalization: lock.cargoLockNormalization,
    platformDirectory: process.env.SQUADFLOW_CODEX_PLATFORM_DIR,
    targetTriple: process.env.SQUADFLOW_CODEX_TARGET_TRIPLE,
    cargoVersion: process.env.SQUADFLOW_CODEX_CARGO_VERSION,
    rustcVersion: process.env.SQUADFLOW_CODEX_RUSTC_VERSION,
    binarySha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
    binaryVersion: execFileSync(binary, ["--version"], { encoding: "utf8" }).trim(),
  };
  writeFileSync(process.env.SQUADFLOW_CODEX_OUTPUT_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
'

node "$ROOT/apps/desktop/scripts/verify-bundled-codex.mjs" \
  --lock "$LOCK_FILE" \
  --manifest "$OUTPUT_MANIFEST" \
  --binary "$OUTPUT_BINARY" \
  --platform "$PLATFORM_DIR"

echo
echo "Bundled Codex runtime ready:"
echo "  Binary: $OUTPUT_BINARY"
echo "  Manifest: $OUTPUT_MANIFEST"
echo "  Variant: $VARIANT"
