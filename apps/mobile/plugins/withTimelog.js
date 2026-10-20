// Config-Plugin der TimeLog-App (läuft bei `expo prebuild`).
// iOS:
//  - kopiert die App Intents (modules/timelog-native/ios-app) in das App-Target,
//  - setzt `TimelogAppGroup` und die Standort-Zwecktexte (nur für den opt-in-Geofence).
//  Bewusst KEIN UIBackgroundModes `location`: Bereichsüberwachung weckt die App auch ohne
//  (Guideline 2.5.4: Hintergrunddienste nur für ihren Zweck).
// `expo prebuild` geprüft; Xcode-Build und Gerät ungeprüft – siehe docs/MOBILE.md.
const fs = require('node:fs');
const path = require('node:path');
const {
  IOSConfig,
  withDangerousMod,
  withInfoPlist,
  withXcodeProject,
} = require('expo/config-plugins');

const INTENT_FILES = ['TimelogIntents.swift'];
const SOURCE_DIR = path.join(__dirname, '..', 'modules', 'timelog-native', 'ios-app');

const LOCATION_WHEN_IN_USE =
  'TimeLog bestimmt einmalig deinen Arbeitsort, wenn du den Geofence selbst einrichtest. ' +
  'Der Ort verlässt dein Gerät nicht.';
const LOCATION_ALWAYS =
  'Nur wenn du den Geofence einschaltest: TimeLog erkennt auch bei geschlossener App, wann du ' +
  'den Arbeitsort verlässt, und beendet so die Arbeitszeit. Koordinaten werden weder ' +
  'gespeichert noch gesendet.';

function withIntentSources(config) {
  config = withDangerousMod(config, [
    'ios',
    (cfg) => {
      const projectName = IOSConfig.XcodeUtils.getProjectName(cfg.modRequest.projectRoot);
      const target = path.join(cfg.modRequest.platformProjectRoot, projectName);
      for (const file of INTENT_FILES) {
        fs.copyFileSync(path.join(SOURCE_DIR, file), path.join(target, file));
      }
      return cfg;
    },
  ]);
  return withXcodeProject(config, (cfg) => {
    const projectName = IOSConfig.XcodeUtils.getProjectName(cfg.modRequest.projectRoot);
    for (const file of INTENT_FILES) {
      const filepath = `${projectName}/${file}`;
      if (!cfg.modResults.hasFile(filepath)) {
        IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
          filepath,
          groupName: projectName,
          project: cfg.modResults,
        });
      }
    }
    return cfg;
  });
}

/** @param {import('expo/config').ExpoConfig} config @param {{ appGroup: string }} options */
module.exports = function withTimelog(config, options) {
  config = withInfoPlist(config, (cfg) => {
    cfg.modResults.TimelogAppGroup = options.appGroup;
    cfg.modResults.NSLocationWhenInUseUsageDescription = LOCATION_WHEN_IN_USE;
    cfg.modResults.NSLocationAlwaysAndWhenInUseUsageDescription = LOCATION_ALWAYS;
    return cfg;
  });
  return withIntentSources(config);
};
