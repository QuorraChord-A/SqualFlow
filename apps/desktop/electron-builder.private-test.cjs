const release = require("./electron-builder.release.cjs");

module.exports = {
  ...release,
  publish: release.publish.map((provider) => ({
    ...provider,
    private: true,
  })),
  mac: {
    ...release.mac,
    identity: process.env.CSC_NAME,
    notarize: false,
  },
};
