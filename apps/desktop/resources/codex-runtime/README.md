Bundled Codex runtime binaries and their generated manifests are placed here before packaging.

Expected layout:

```text
codex-runtime/
  darwin-arm64/{codex,manifest.json}
  darwin-x64/{codex,manifest.json}
```

The backend resolves the packaged binary from `process.resourcesPath/codex-runtime/<platform-arch>/codex`.
Build the pinned SquadFlow variant with:

```bash
apps/desktop/scripts/build-bundled-codex.sh
```

The build reads `codex-0.120.0.lock.json`, checks out the exact upstream commit, verifies and
applies the tracked compatibility patch, normalizes the release-stamped workspace versions in
the upstream Cargo lock with recorded input/output hashes, runs its Rust regression tests, and emits the binary
and provenance manifest under `.artifacts/codex-runtime/runtime/<platform-arch>/`. The patch
keeps input/output/total usage when a compatible provider omits `cached_tokens`, while marking
only cache telemetry as unknown. The verifier also requires the produced binary to match the
platform digest pinned in the lock file.

For packaging, set `SQUADFLOW_BUNDLED_CODEX_COMMAND` and, when it is not next to the binary,
`SQUADFLOW_BUNDLED_CODEX_MANIFEST`. The packaging scripts copy both files and reject binaries
whose commit, patch set, version, architecture, or SHA-256 does not match the manifest and lock.
Development packages retain this input manifest because the bundled runtime bytes stay unchanged.
Release packages verify it before signing, then omit it from the signed App so Developer ID
re-signing cannot leave a stale pre-signing binary digest inside the distributed product.
