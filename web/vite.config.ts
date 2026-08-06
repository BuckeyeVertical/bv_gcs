import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Where `npm run dev` forwards API traffic. Point at the drone to develop against
// live hardware:  GCS_TARGET=http://192.168.144.10:8765 npm run dev
const target = process.env.GCS_TARGET ?? 'http://127.0.0.1:8765';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    // Proxying /ws and /frame keeps the dev server and the bundle served from
    // approval_node on identical client code — no VITE_GCS_URL, no branching.
    proxy: {
      '/ws': { target, ws: true, changeOrigin: true },
      '/frame': { target, changeOrigin: true },
      '/healthz': { target, changeOrigin: true },
    },
  },
});
