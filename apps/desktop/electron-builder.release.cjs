const base = require("./package.json").build;
const runtimeArch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
if (!runtimeArch) {
  throw new Error(`Unsupported release architecture: ${process.arch}`);
}

module.exports = {
  ...base,
  publish: [
    {
      provider: "github",
      owner: "QuorraChord-A",
      repo: "SqualFlow",
    },
  ],
  extraResources: (base.extraResources || []).map((resource) => (
    resource.to === "codex-runtime"
      ? { ...resource, filter: [`darwin-${runtimeArch}/codex`] }
      : resource
  )),
  forceCodeSigning: true,
  mac: {
    ...base.mac,
    identity: process.env.CSC_NAME,
    hardenedRuntime: true,
    notarize: true,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.inherit.plist",
    binaries: [
      ...(base.mac.binaries || []),
      `Contents/Resources/codex-runtime/darwin-${runtimeArch}/codex`,
    ],
  },
};
