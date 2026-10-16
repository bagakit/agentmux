import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['packages/core/test/agent-session-restart.test.ts'], maxWorkers: 1, testTimeout: 20_000, hookTimeout: 20_000 } })
