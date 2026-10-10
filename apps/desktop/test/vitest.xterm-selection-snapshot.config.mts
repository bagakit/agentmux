import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// This dependency-owner gate uses the installed browser Terminal directly. It
// does not load Desktop, replace xterm with headless, or require Core artifacts.
export default defineConfig({
  root: resolve(import.meta.dirname, '..'),
  test: {
    environment: 'happy-dom',
    include: ['test/xterm-selection-snapshot.test.ts'],
    passWithNoTests: false,
    maxWorkers: 1
  }
})
