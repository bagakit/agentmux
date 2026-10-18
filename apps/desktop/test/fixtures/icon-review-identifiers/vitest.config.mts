import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import original from '../../../../../vitest.config.ts'
const root = resolve(import.meta.dirname, '../../../../..')
export default defineConfig({ ...original, root, test: { ...original.test, globalSetup: [], fileParallelism: false, passWithNoTests: false,
  include: ['apps/desktop/test/icon-review-identifiers.test.ts'] } })
