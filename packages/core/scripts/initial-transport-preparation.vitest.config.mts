import { defineConfig } from 'vitest/config'

export default defineConfig({ test: {
  include: ['packages/core/test/client-raw-input-render-preemption.test.ts', 'packages/core/test/mouse-preclaim-input.test.ts'],
  passWithNoTests: false,
  fileParallelism: false,
  maxWorkers: 1
} })
