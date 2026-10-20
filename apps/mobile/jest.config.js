// Jest mit dem Expo-Preset. pnpm legt Pakete unter node_modules/.pnpm ab, daher das erweiterte
// Muster für transformIgnorePatterns. React wird wie in Metro auf genau eine Kopie gelenkt.
const path = require('node:path');

const reactDir = path.dirname(require.resolve('react/package.json', { paths: [__dirname] }));

/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  testMatch: ['<rootDir>/test/**/*.test.ts?(x)'],
  setupFiles: ['<rootDir>/test/setup.ts'],
  transformIgnorePatterns: [
    'node_modules/(?!(?:\\.pnpm/[^/]+/node_modules/)?((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|expo-.*|@timelog/.*|react-native-.*))',
  ],
  moduleNameMapper: {
    '^react$': path.join(reactDir, 'index.js'),
    '^react/(.*)$': path.join(reactDir, '$1'),
  },
};
