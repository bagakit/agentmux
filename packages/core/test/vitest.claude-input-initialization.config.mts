import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { environment: 'node', include: ['packages/core/test/providers/claude-input-initialization.test.ts'], passWithNoTests: false, maxWorkers: 1, testTimeout: 20000 } })
