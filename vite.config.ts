import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: { ignorePatterns: ["pnpm-lock.yaml", "coverage/**"], sortPackageJson: {} },
  lint: {
    plugins: ["eslint", "oxc", "typescript", "unicorn"],
    categories: { correctness: "error", suspicious: "error", perf: "error" },
    ignorePatterns: ["coverage/**"],
  },
  test: {
    environment: "node",
    include: ["{src,bin,scripts,test,tests}/**/*.{test,spec}.ts"],
    maxWorkers: 1,
    fileParallelism: false,
    maxConcurrency: 1,
    restoreMocks: true,
  },
});
