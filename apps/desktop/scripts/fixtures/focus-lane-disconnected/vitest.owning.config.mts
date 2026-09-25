import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'
export default defineConfig({ ...original, root: resolve(import.meta.dirname, '../../../../..'), cacheDir: resolve(import.meta.dirname, '../../../../../.tmp/focus-lane-disconnected-cache'), test: { ...original.test, include: ['apps/desktop/test/focus-lane-disconnected.test.tsx'], passWithNoTests: false, fileParallelism: false, maxWorkers: 1 } })
