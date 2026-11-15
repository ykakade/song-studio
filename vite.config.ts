import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The web client lives in web/ and builds to dist/, which the server serves.
// In dev, Vite serves the client and forwards /api to the Node server.
const apiPort = Number(process.env.PORT ?? 8787);

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "../dist", emptyOutDir: true },
  server: {
    host: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: true,
    proxy: { "/api": { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false } },
  },
});
