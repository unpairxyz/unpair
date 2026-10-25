import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Tauri serves the built files from ../dist and talks to this dev server on 1420.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: ["es2022", "safari16"], sourcemap: false },
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
