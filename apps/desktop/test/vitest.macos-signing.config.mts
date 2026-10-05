import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Delivery scripts consume native signing tools, not Core dist or the Renderer.
export default defineConfig({
  root: resolve(import.meta.dirname, '../../..'),
  test: {
    environment: 'node',
    include: ['apps/desktop/test/package-macos-signing.test.ts', 'apps/desktop/test/macos-local-signing.test.ts'],
    maxWorkers: 1, fileParallelism: false, watch: false
  }
})
