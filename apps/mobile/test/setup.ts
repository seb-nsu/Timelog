import { jest } from '@jest/globals';

// Safe-Area ohne natives Modul (offizielles Jest-Mock des Pakets)
jest.mock('react-native-safe-area-context', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mock = require('react-native-safe-area-context/jest/mock') as { default: unknown };
  return mock.default;
});
