import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
export default defineConfig({
  root: fileURLToPath(new URL('../../../', import.meta.url)),
  resolve: { alias: { '@agentmux/providers/codex/turn-evidence': fileURLToPath(new URL('../../../packages/providers/src/codex/turn-evidence.ts', import.meta.url)) } },
  test: { include: ['packages/core/test/immediate*.test.ts'], maxWorkers: 1, testTimeout: 20_000 }
})
