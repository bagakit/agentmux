import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import owning from './vitest.ui-controls-owning.config.mts'

/** The quick switcher's index and its rendered rows, against current UI/Core/Host sources. */
export default defineConfig({ ...owning, root: resolve(import.meta.dirname, '../../..'),
  test: { ...owning.test, include: ['apps/desktop/test/quick-switch.test.ts', 'apps/desktop/test/quick-switch-demand.test.tsx', 'apps/desktop/test/quick-open-files.test.tsx'], passWithNoTests: false, maxWorkers: 1 } })
