import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import owning from './vitest.ui-controls-owning.config.mts'

/** Exact current consumers and the shared confirmation's existing interaction contract. */
export default defineConfig({ ...owning, root: resolve(import.meta.dirname, '../../..'),
  test: { ...owning.test, include: ['apps/desktop/test/ui-button-consumers.test.tsx', 'apps/desktop/test/confirmation-dialog-craft.test.tsx'], passWithNoTests: false, maxWorkers: 1 } })
