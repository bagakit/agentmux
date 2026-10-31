import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import owning from './vitest.mote-context.config.mts'

export default defineConfig({ ...owning, cacheDir: resolve(import.meta.dirname, '../../../.tmp/topic-file-scope-cache'),
  test: { ...owning.test, include: ['apps/desktop/test/topic-file-scope.test.ts'], passWithNoTests: false } })
