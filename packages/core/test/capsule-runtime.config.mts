import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
// This collection imports Core source only; the separate runtime proof consumes compiled Core.
export default defineConfig({ resolve: { alias: process.env.CTXMUX_TEST_SDK_SOURCE
  ? [{ find: /^@ctxmux\/sdk$/, replacement: resolve(process.env.CTXMUX_TEST_SDK_SOURCE) }] : [] }, test: { include: [
  'packages/core/test/capsule-runtime.test.ts',
  'packages/core/test/capsule-terminal-preparation.test.ts',
  'packages/core/test/prepared-creation-observation.test.ts',
], passWithNoTests: false, maxWorkers: 1 } })
