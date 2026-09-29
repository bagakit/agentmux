import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from '../../../../../vitest.config'

export default defineConfig({
  ...base,
  root: resolve(import.meta.dirname, '../../../../..'),
  test: {
    ...base.test,
    include: ['apps/desktop/test/agent-avatar-settings.test.tsx'],
    passWithNoTests: false,
    fileParallelism: false,
    maxWorkers: 1
  }
})
