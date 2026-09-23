import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: new URL('.', import.meta.url).pathname,
  test: { include: ['source-proof.ts'], environment: 'node', maxWorkers: 1, globalSetup: [], setupFiles: [] }
})
