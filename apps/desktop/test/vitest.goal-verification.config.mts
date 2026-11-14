import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ root, test: { include: ['apps/desktop/test/goal-verification-sources.test.ts'],
  setupFiles: [resolve(root, 'vitest.setup.ts')], maxWorkers: 1, passWithNoTests: false } })
