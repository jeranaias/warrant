import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The dashboard calls /api/...; the dev server forwards that to the engine (`pnpm engine`), so
// the engine needs no CORS. ENGINE_PORT matches the engine's own setting (default 4000).
const engine = `http://127.0.0.1:${process.env["ENGINE_PORT"] ?? 4000}`;

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: engine,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
