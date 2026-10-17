import { defineConfig } from 'vitest/config'
const cacheDir = process.env.AGENTMUX_ANIMATIONS_CACHE
if (!cacheDir) throw new Error('Private animation test cache is required before loading tests.')
export default defineConfig({ cacheDir, test: { include: ['packages/core/test/renderer-animations.fixture.ts'],
  environment: 'node', globalSetup: [], setupFiles: [], maxWorkers: 1, fileParallelism: false,
  passWithNoTests: false, testTimeout: 15000, hookTimeout: 20000 } })
