import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packages = ["apps/local-service", "apps/renderer", "apps/desktop"];

if (Number(process.versions.node.split(".")[0]) !== 22) {
  console.error(`SquadFlow requires Node.js 22; current version is ${process.version}.`);
  process.exit(1);
}

for (const packageDirectory of packages) {
  console.log(`Installing ${packageDirectory} dependencies...`);
  const result = spawnSync("npm", ["ci", "--prefix", path.join(root, packageDirectory)], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
