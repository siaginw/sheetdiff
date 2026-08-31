import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // mirror tsconfig paths "@/*" -> "./src/*" so route tests (which import via
  // "@/lib/...") resolve under vitest the same way next build resolves them
  resolve: {
    alias: {
      "@": path.resolve(process.cwd(), "src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
