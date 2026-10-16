import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
export default defineConfig({ root: resolve(import.meta.dirname, '../../..'), test: {
  environment: 'node', globalSetup: [], passWithNoTests: false, fileParallelism: false,
  include: ['packages/core/test/managed-frontend-public.integration.test.ts'], testTimeout: 60_000
} })
