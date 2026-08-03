const base = require("./package.json").build;
const runtimeArch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
if (!runtimeArch) {
  throw new Error(`Unsupported unsigned publish architecture: ${process.arch}`);
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
  forceCodeSigning: false,
  extraResources: (base.extraResources || []).map((resource) => (
    resource.to === "codex-runtime"
      ? { ...resource, filter: [`darwin-${runtimeArch}/codex`] }
      : resource
  )),
  mac: {
    ...base.mac,
    identity: null,
    notarize: false,
  },
};
