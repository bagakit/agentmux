import { defineConfig } from 'vitest/config'

export default defineConfig({ test: {
  include: ['packages/core/test/mote-chat-diagnosis.test.ts'],
  environment: 'node', passWithNoTests: false, fileParallelism: false, maxWorkers: 1
} })
