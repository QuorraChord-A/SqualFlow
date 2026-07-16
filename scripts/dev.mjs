import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const commands = [
  ["local-service", ["--prefix", path.join(root, "apps", "local-service"), "run", "dev"]],
  ["renderer", ["--prefix", path.join(root, "apps", "renderer"), "run", "dev"]],
  ["desktop", ["--prefix", path.join(root, "apps", "desktop"), "run", "dev"]],
];
const children = [];
let stopping = false;

if (Number(process.versions.node.split(".")[0]) !== 22) {
  console.error(`SquadFlow development requires Node.js 22; current version is ${process.version}.`);
  process.exit(1);
}

function stopChildren(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.pid || child.exitCode !== null) continue;
    try {
      if (process.platform === "win32") child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch {
      // A child may exit between the state check and signal delivery.
    }
  }
}

for (const [name, args] of commands) {
  const child = spawn("npm", args, {
    cwd: root,
    stdio: "inherit",
    detached: process.platform !== "win32",
  });
  children.push(child);
  child.on("error", (error) => {
    console.error(`${name} failed to start: ${error.message}`);
    stopChildren();
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    if (stopping) return;
    if (code !== 0) console.error(`${name} exited with ${signal ?? `code ${code}`}.`);
    stopChildren();
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

process.on("SIGINT", () => {
  stopChildren("SIGINT");
  process.exitCode = 130;
});
process.on("SIGTERM", () => {
  stopChildren("SIGTERM");
  process.exitCode = 143;
});
