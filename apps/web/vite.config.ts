import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  build: { target: "es2022", sourcemap: false },
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
