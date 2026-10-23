import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['apps/host/test/host-index-consumer.test.ts'],
  environment: 'node', fileParallelism: false, passWithNoTests: false, testTimeout: 35_000, hookTimeout: 15_000 } })
