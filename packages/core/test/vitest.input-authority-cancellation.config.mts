import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['packages/core/test/input-authority-cancellation.test.ts'], maxWorkers: 1, testTimeout: 10000 } })
