import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
const root = fileURLToPath(new URL('../../../', import.meta.url))
export default defineConfig({ root, resolve: { alias: {
  '@agentmux/core/session-user-messages': fileURLToPath(new URL('../src/session-user-messages.ts', import.meta.url))
} }, test: { include: ['packages/core/test/providers/antigravity-native-source.test.ts', 'packages/core/test/providers/antigravity-session-analysis.test.ts'], passWithNoTests: false, fileParallelism: false, maxWorkers: 1 } })
