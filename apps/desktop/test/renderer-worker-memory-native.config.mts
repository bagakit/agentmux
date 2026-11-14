import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  root: resolve(import.meta.dirname, '../../..'),
  test: {
    include: ['apps/desktop/test/renderer-worker-memory-native.test.ts'],
    environment: 'node', setupFiles: [], globalSetup: [],
    passWithNoTests: false, maxWorkers: 1, testTimeout: 60000
  }
})
