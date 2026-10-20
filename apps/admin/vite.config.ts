import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In der Entwicklung leitet Vite /api an das Backend weiter (gleicher Ursprung, kein CORS nötig).
// Produktiv: Web-Admin und API hinter demselben Reverse-Proxy oder CORS_ORIGINS im Backend setzen.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
    proxy: { '/api': 'http://localhost:3000' },
  },
  build: { target: 'es2022', sourcemap: false },
});
