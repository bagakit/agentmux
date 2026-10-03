import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['test/codex-native-history.test.ts', 'test/session-history-content-parts.test.ts', 'test/agent-interaction.test.ts', 'test/prompt-submission-diagnostics.test.ts'], maxWorkers: 1, testTimeout: 20_000 } })
