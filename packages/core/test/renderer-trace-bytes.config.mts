import { defineConfig } from 'vitest/config'
const cacheDir = process.env.AGENTMUX_TRACE_TEST_CACHE
if (!cacheDir) throw new Error('Private trace test cache is required before loading tests.')
export default defineConfig({ cacheDir, test: { include: ['packages/core/test/renderer-trace-bytes.fixture.ts'],
  environment: 'node', globalSetup: [], setupFiles: [], maxWorkers: 1, fileParallelism: false,
  passWithNoTests: false, testTimeout: 20000, hookTimeout: 20000 } })
