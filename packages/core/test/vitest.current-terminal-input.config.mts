import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['packages/core/test/bracketed-paste.test.ts', 'packages/core/test/current-terminal-input.test.ts', 'packages/core/test/input-authority-cancellation.test.ts'], maxWorkers: 1, testTimeout: 10000 } })
