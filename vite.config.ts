import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const mastraTarget = `http://127.0.0.1:${process.env.MASTRA_PORT ?? "4111"}`;

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5175,
    strictPort: true,
    proxy: {
      "/workbench-api": mastraTarget,
      "/api": mastraTarget,
    },
  },
  build: { outDir: "dist/web", emptyOutDir: true },
});
