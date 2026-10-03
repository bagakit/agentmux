import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['test/session-question-reply.test.ts'], maxWorkers: 1, testTimeout: 20_000 } })
