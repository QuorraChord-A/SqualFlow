const fs = require("node:fs");
const path = require("node:path");

const PACKAGED_APP_NAME = "SquadFlow";
const DEVELOPMENT_APP_NAME = "SquadFlow Development";
const LEGACY_PACKAGED_APP_NAMES = ["squadflow-desktop", "@squalflow/desktop"];

function migrateLegacyPackagedUserData({ appDataPath, userDataPath, fsModule }) {
  let targetExists = fsModule.existsSync(userDataPath);
  const migratedFrom = [];

  for (const legacyName of LEGACY_PACKAGED_APP_NAMES) {
    const legacyPath = path.join(appDataPath, legacyName);
    if (!fsModule.existsSync(legacyPath)) continue;
    if (!targetExists) {
      fsModule.renameSync(legacyPath, userDataPath);
      targetExists = true;
    } else {
      fsModule.cpSync(legacyPath, userDataPath, {
        recursive: true,
        force: false,
        errorOnExist: false,
      });
    }
    migratedFrom.push(legacyPath);
  }
  return migratedFrom;
}

function configureApplicationPaths({ app, fsModule = fs }) {
  const appName = app.isPackaged ? PACKAGED_APP_NAME : DEVELOPMENT_APP_NAME;
  app.setName(appName);
  const explicitUserData = app.commandLine?.hasSwitch?.("user-data-dir") === true;
  const appDataPath = explicitUserData ? null : app.getPath("appData");
  const userDataPath = explicitUserData
    ? app.getPath("userData")
    : path.join(appDataPath, appName);
  const migratedFrom = app.isPackaged && !explicitUserData
    ? migrateLegacyPackagedUserData({ appDataPath, userDataPath, fsModule })
    : [];
  const logsPath = path.join(userDataPath, "logs");
  fsModule.mkdirSync(logsPath, { recursive: true });
  app.setPath("userData", userDataPath);
  app.setAppLogsPath(logsPath);
  return { userDataPath, logsPath, migratedFrom };
}

module.exports = {
  PACKAGED_APP_NAME,
  DEVELOPMENT_APP_NAME,
  LEGACY_PACKAGED_APP_NAMES,
  configureApplicationPaths,
};
