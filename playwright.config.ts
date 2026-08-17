import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test/e2e",
  fullyParallel: false,
  retries: 0,
  reporter: "line",
  use: { baseURL: "http://127.0.0.1:5175", channel: "msedge", viewport: { width: 390, height: 844 } },
  webServer: { command: "pnpm dev:web", url: "http://127.0.0.1:5175", reuseExistingServer: true, timeout: 60_000 },
});
