import { defineConfig } from 'vitest/config'
// This collection imports Core source only; the separate runtime proof consumes compiled Core.
export default defineConfig({ test: { include: [
  'packages/core/test/capsule-runtime.test.ts',
  'packages/core/test/capsule-terminal-preparation.test.ts',
], passWithNoTests: false, maxWorkers: 1 } })
