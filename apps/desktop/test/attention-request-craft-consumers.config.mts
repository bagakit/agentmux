import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import owning from './vitest.ui-controls-owning.config.mts'

/** The Attention panel's answerability and first focus for one Core request, against current UI/Core/Host sources. */
export default defineConfig({ ...owning, root: resolve(import.meta.dirname, '../../..'),
  test: { ...owning.test, include: ['apps/desktop/test/attention-request-craft.test.tsx'], passWithNoTests: false, maxWorkers: 1 } })
