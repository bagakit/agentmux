import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: { alias: [{ find: /^@agentmux\/core$/, replacement: fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)) }] },
  test: { environment: 'node', include: ['apps/host/test/private-access*.test.ts'], restoreMocks: true }
})
