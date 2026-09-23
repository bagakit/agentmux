import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['packages/core/test/agent-start-failure-recovery.test.ts'], maxWorkers: 1 } })
