// Metro: Expo konfiguriert Monorepos seit SDK 52 selbst (watchFolders, nodeModulesPaths).
// Zusätzlich: React genau einmal bündeln. @timelog/app-core bringt für seine eigenen Tests eine
// andere React-Version mit; React Native verlangt aber exakt die eigene (19.3.0).
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

const single = ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime'];
const upstream = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (single.includes(moduleName)) {
    return {
      type: 'sourceFile',
      filePath: require.resolve(moduleName, { paths: [path.join(__dirname)] }),
    };
  }
  return upstream
    ? upstream(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
