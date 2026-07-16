import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const runtimeStage = path.join(root, "apps/desktop/.staging/runtime");
const rendererStage = path.resolve(process.argv[2] ?? path.join(runtimeStage, "renderer"));
const outputRoot = path.resolve(process.argv[3] ?? path.join(runtimeStage, "legal"));
const runtimeModules = path.join(rendererStage, "runtime_modules");
const components = new Map();

function normalizeLicense(value) {
  if (!value) return "UNKNOWN";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function addComponent(name, details, source) {
  if (!details?.version || !details?.path || !fs.existsSync(details.path)) return;
  const key = `${name}@${details.version}`;
  const existing = components.get(key) ?? {
    name,
    version: details.version,
    license: normalizeLicense(details.license),
    sourcePaths: new Set(),
    bundledIn: new Set(),
  };
  existing.sourcePaths.add(fs.realpathSync(details.path));
  existing.bundledIn.add(source);
  components.set(key, existing);
}

function collectElectronRuntimeDependencies() {
  const tree = JSON.parse(execFileSync(
    "npm",
    ["--prefix", path.join(root, "apps", "desktop"), "ls", "--json", "--long", "--all", "--omit=dev"],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  ));
  const visit = (dependencies) => {
    for (const [name, details] of Object.entries(dependencies ?? {})) {
      addComponent(name, details, "electron-runtime");
      visit(details.dependencies);
    }
  };
  visit(tree.dependencies);

  const electronPath = path.join(root, "apps", "desktop", "node_modules", "electron");
  const electronPackage = JSON.parse(fs.readFileSync(path.join(electronPath, "package.json"), "utf8"));
  addComponent(electronPackage.name, { ...electronPackage, path: electronPath }, "electron-framework");
}

function rendererPackageRoots() {
  const result = [];
  for (const entry of fs.readdirSync(runtimeModules, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("@")) {
      const scopePath = path.join(runtimeModules, entry.name);
      for (const scopedEntry of fs.readdirSync(scopePath, { withFileTypes: true })) {
        if (scopedEntry.isDirectory()) result.push(path.join(scopePath, scopedEntry.name));
      }
    } else {
      result.push(path.join(runtimeModules, entry.name));
    }
  }
  return result;
}

function collectRendererRuntimeDependencies() {
  for (const stagedPath of rendererPackageRoots()) {
    const stagedPackagePath = path.join(stagedPath, "package.json");
    if (!fs.existsSync(stagedPackagePath)) continue;
    const packageData = JSON.parse(fs.readFileSync(stagedPackagePath, "utf8"));
    const sourcePath = path.join(root, "apps", "renderer", "node_modules", ...packageData.name.split("/"));
    addComponent(packageData.name, { ...packageData, path: sourcePath }, "renderer-standalone");
  }
}

function safeDirectoryName(value) {
  return value.replace(/^@/, "").replaceAll("/", "__").replace(/[^a-zA-Z0-9_.@-]/g, "_");
}

function legalFiles(packagePath) {
  return fs.readdirSync(packagePath, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => /^(license|licence|copying|notice|third[-_ ]party[-_ ]notices?)(\..*)?$/i.test(name))
    .sort();
}

function stageLicenses() {
  fs.rmSync(outputRoot, { recursive: true, force: true });
  const licensesRoot = path.join(outputRoot, "licenses");
  fs.mkdirSync(licensesRoot, { recursive: true });

  const manifest = [];
  for (const component of [...components.values()].sort((a, b) => (
    a.name.localeCompare(b.name) || a.version.localeCompare(b.version)
  ))) {
    const targetDirectory = path.join(licensesRoot, safeDirectoryName(`${component.name}@${component.version}`));
    const copiedFiles = new Set();
    for (const sourcePath of component.sourcePaths) {
      for (const fileName of legalFiles(sourcePath)) {
        fs.mkdirSync(targetDirectory, { recursive: true });
        fs.copyFileSync(path.join(sourcePath, fileName), path.join(targetDirectory, fileName));
        copiedFiles.add(fileName);
      }
    }
    manifest.push({
      name: component.name,
      version: component.version,
      license: component.license,
      bundledIn: [...component.bundledIn].sort(),
      licenseFiles: [...copiedFiles].sort(),
    });
  }
  fs.writeFileSync(
    path.join(outputRoot, "runtime-packages.json"),
    `${JSON.stringify({ schemaVersion: 1, packages: manifest }, null, 2)}\n`,
    "utf8",
  );
  console.log(`Staged legal metadata for ${manifest.length} runtime packages.`);
}

if (!fs.existsSync(runtimeModules)) {
  throw new Error(`Staged renderer runtime modules are missing: ${runtimeModules}`);
}
collectElectronRuntimeDependencies();
collectRendererRuntimeDependencies();
stageLicenses();
