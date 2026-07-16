#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

function fail(message) {
  throw new Error(`Bundled Codex verification failed: ${message}`);
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) fail(`invalid arguments near ${key ?? "<end>"}`);
    values[key.slice(2)] = value;
  }
  for (const required of ["lock", "manifest", "binary", "platform"]) {
    if (!values[required]) fail(`missing --${required}`);
  }
  return values;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`cannot read ${label} ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function expectedTarget(platform) {
  if (platform === "darwin-arm64") return { triple: "aarch64-apple-darwin", fileArch: "arm64" };
  if (platform === "darwin-x64") return { triple: "x86_64-apple-darwin", fileArch: "x86_64" };
  fail(`unsupported platform ${platform}`);
}

const args = parseArgs(process.argv.slice(2));
const lock = readJson(args.lock, "lock file");
const manifest = readJson(args.manifest, "manifest");
const target = expectedTarget(args.platform);

if (manifest.schemaVersion !== 1) fail(`unsupported manifest schema ${manifest.schemaVersion}`);
for (const key of ["runtimeVersion", "variant", "rustToolchain"]) {
  if (manifest[key] !== lock[key]) fail(`${key} does not match the lock file`);
}
if (manifest.upstreamCommit !== lock.upstream?.commit) fail("upstream commit does not match the lock file");
if (manifest.platformDirectory !== args.platform) fail("platform directory does not match the package target");
if (manifest.targetTriple !== target.triple) fail("Rust target does not match the package target");

const lockedPatches = Array.isArray(lock.patches) ? lock.patches : [];
const builtPatches = Array.isArray(manifest.patches) ? manifest.patches : [];
if (JSON.stringify(builtPatches) !== JSON.stringify(lockedPatches)) fail("patch list does not match the lock file");
if (JSON.stringify(manifest.cargoLockNormalization) !== JSON.stringify(lock.cargoLockNormalization)) {
  fail("Cargo.lock normalization does not match the lock file");
}

const actualHash = sha256(args.binary);
if (manifest.binarySha256 !== actualHash) fail("binary SHA-256 does not match the manifest");
const lockedArtifact = lock.artifacts?.[args.platform];
if (!lockedArtifact?.binarySha256) fail(`lock file has no pinned binary for ${args.platform}`);
if (lockedArtifact.binarySha256 !== actualHash) fail("binary SHA-256 does not match the pinned artifact");

const expectedVersion = `codex-cli ${lock.runtimeVersion}`;
const actualVersion = execFileSync(args.binary, ["--version"], { encoding: "utf8" }).trim();
if (actualVersion !== expectedVersion || manifest.binaryVersion !== actualVersion) {
  fail(`expected ${expectedVersion}, received ${actualVersion}`);
}
if (!String(manifest.cargoVersion).startsWith(`cargo ${lock.rustToolchain} `)) {
  fail("Cargo version does not match the locked Rust toolchain");
}
if (!String(manifest.rustcVersion).startsWith(`rustc ${lock.rustToolchain} `)) {
  fail("Rustc version does not match the locked Rust toolchain");
}

const fileDescription = execFileSync("file", [args.binary], { encoding: "utf8" });
if (!fileDescription.includes("Mach-O") || !fileDescription.includes(target.fileArch)) {
  fail(`binary architecture does not match ${args.platform}`);
}

process.stdout.write(`Verified bundled Codex ${lock.runtimeVersion} (${lock.variant}) for ${args.platform}.\n`);
