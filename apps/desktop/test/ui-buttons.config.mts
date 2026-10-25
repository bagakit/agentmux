import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import owning from './vitest.ui-controls-owning.config.mts'

/** Current public UI/Core Source; no installed Runtime, dist build or broad test discovery. */
export default defineConfig({ ...owning, root: resolve(import.meta.dirname, '../../..'),
  test: { ...owning.test, include: ['apps/desktop/test/ui-buttons.test.tsx'], passWithNoTests: false, maxWorkers: 1 } })
