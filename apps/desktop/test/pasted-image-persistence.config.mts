import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['apps/desktop/test/pasted-image-write.test.ts', 'apps/desktop/test/pasted-image-read.test.ts'],
  environment: 'node', passWithNoTests: false, maxWorkers: 1, fileParallelism: false } })
