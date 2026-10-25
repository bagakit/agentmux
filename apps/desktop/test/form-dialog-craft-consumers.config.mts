import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import owning from './vitest.ui-controls-owning.config.mts'

export default defineConfig({ ...owning, root: resolve(import.meta.dirname, '../../..'),
  test: { ...owning.test, include: ['apps/desktop/test/form-dialog-craft.test.tsx'], passWithNoTests: false, maxWorkers: 1 } })
