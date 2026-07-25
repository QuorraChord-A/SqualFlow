const release = require("./electron-builder.release.cjs");

module.exports = {
  ...release,
  publish: release.publish,
  mac: {
    ...release.mac,
    identity: process.env.CSC_NAME,
    notarize: false,
    entitlements: "build/entitlements.mac.private-test.plist",
    entitlementsInherit: "build/entitlements.mac.private-test.inherit.plist",
  },
};
