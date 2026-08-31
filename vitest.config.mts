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
  },
});
