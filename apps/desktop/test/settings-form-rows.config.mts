import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import owning from './vitest.ui-controls-owning.config.mts'

/** Two registered Settings consumers against current UI/Core/Host sources. */
export default defineConfig({ ...owning, root: resolve(import.meta.dirname, '../../..'),
  test: { ...owning.test, include: ['apps/desktop/test/settings-form-rows.test.tsx'], passWithNoTests: false, maxWorkers: 1 } })
