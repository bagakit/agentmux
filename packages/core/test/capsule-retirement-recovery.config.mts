import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['packages/core/test/capsule-retirement-recovery.test.ts'], passWithNoTests: false, maxWorkers: 1, testTimeout: 15000 } })
