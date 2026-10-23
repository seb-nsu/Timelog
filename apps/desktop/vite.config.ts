import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Feste Portnummer, weil tauri.conf.json (devUrl) darauf zeigt.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: { target: 'es2022', sourcemap: false },
});
