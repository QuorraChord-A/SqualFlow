import fs from "node:fs";
import path from "node:path";

const root = path.resolve("tests/acceptance");
const groups = ["atoms", "verifies", "scenarios"];
const forbidden = [
  /\b(?:selector|ref|element index|debug command|curl|sqlite|sql|rest payload)\b/iu,
  /\be\d+\b/u,
  /spec_requested|work_run|flow_expert|plan_run/iu,
];

function filesIn(directory) {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(root, directory, entry.name))
    .sort();
}

function requireStringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${label} must be a non-empty string array`);
  }
}

const atoms = new Set();
const verifies = new Set();
const scenarios = new Set();

for (const group of groups) {
  for (const file of filesIn(group)) {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    const expectedId = path.basename(file, ".json");
    if (value.id !== expectedId) throw new Error(`${file}: id must equal filename`);
    if (forbidden.some((pattern) => pattern.test(JSON.stringify(value)))) throw new Error(`${file}: contains forbidden implementation or removed-contract terminology`);
    if (group === "atoms") {
      if (!Array.isArray(value.params)) throw new Error(`${file}: params must be an array`);
      requireStringArray(value.steps, `${file}: steps`);
      if (value.verify !== null) requireStringArray(value.verify, `${file}: verify`);
      atoms.add(value.id);
    } else if (group === "verifies") {
      requireStringArray(value.assertions, `${file}: assertions`);
      verifies.add(value.id);
    } else {
      for (const key of ["preconditions", "verify", "recovery", "cleanup"]) requireStringArray(value[key], `${file}: ${key}`);
      if (typeof value.requirement !== "string" || !/[\u3400-\u9fff]/u.test(value.requirement)) throw new Error(`${file}: requirement must be a real Chinese prompt`);
      if (!Array.isArray(value.steps) || value.steps.length === 0) throw new Error(`${file}: steps must be non-empty`);
      if (!Array.isArray(value.verifies) || value.verifies.length === 0) throw new Error(`${file}: verifies must be non-empty`);
      scenarios.add(value.id);
    }
  }
}

for (const file of filesIn("scenarios")) {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const step of value.steps) {
    const atomId = typeof step === "string" && /^[a-z0-9-]+$/u.test(step) ? step : typeof step === "object" ? step.atom : null;
    if (atomId && !atoms.has(atomId)) throw new Error(`${file}: unknown atom ${atomId}`);
  }
  for (const verifyId of value.verifies) if (!verifies.has(verifyId)) throw new Error(`${file}: unknown verify ${verifyId}`);
}

if (atoms.size < 8 || verifies.size < 8 || scenarios.size < 10) throw new Error("acceptance matrix is unexpectedly incomplete");
console.log(`acceptance assets valid: ${atoms.size} atoms, ${verifies.size} verifies, ${scenarios.size} scenarios`);
