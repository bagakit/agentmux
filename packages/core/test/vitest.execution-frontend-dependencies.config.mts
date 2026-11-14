import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { environment: 'node', include: ['packages/core/test/execution-frontend-dependencies.test.ts'], passWithNoTests: false, maxWorkers: 1, testTimeout: 15000, hookTimeout: 15000 } })
