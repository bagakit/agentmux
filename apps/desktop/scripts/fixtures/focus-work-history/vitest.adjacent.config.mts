import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'
export default defineConfig({ ...original, root: resolve(import.meta.dirname, '../../../../..'), define: { ...original.define, __AGENTMUX_WEB_PREVIEW__: 'false' }, cacheDir: resolve(import.meta.dirname, '../../../../../.tmp/focus-work-history-adjacent-cache'), test: { ...original.test, include: ['apps/desktop/test/focus-retired-history-renderer.test.tsx', 'apps/desktop/test/focus-timeline-read-coverage.test.tsx'], passWithNoTests: false, fileParallelism: false, maxWorkers: 1, testTimeout: 15_000 } })
