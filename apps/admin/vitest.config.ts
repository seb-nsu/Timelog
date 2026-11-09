import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    // Deutsch ist die führende Sprache der Tests; Englisch prüft test/english.test.tsx.
    setupFiles: ['test/setup.ts'],
  },
});
