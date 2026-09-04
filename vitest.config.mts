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
  // .tsx server components imported by tests (report page, production panel)
  // need the automatic JSX runtime — files don't import React themselves
  esbuild: {
    jsx: "automatic",
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "html"],
      include: ["src/**"],
      exclude: ["src/**/*.d.ts"],
      // set to today's real numbers minus a hair; raise them as tests grow
      // (they never ratchet down without a deliberate decision)
      thresholds: {
        lines: 80,
        functions: 60,
        branches: 60,
        statements: 80,
      },
    },
  },
});
