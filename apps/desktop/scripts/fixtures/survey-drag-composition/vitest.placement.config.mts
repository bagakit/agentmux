import native from '../../../test/vitest.browser-recovery-first-presentation.config.mts'
import { defineConfig } from 'vitest/config'
export default defineConfig({ ...native, test: { ...native.test,
  include: ['apps/desktop/test/browser-presentation-host.test.tsx'], passWithNoTests: false, maxWorkers: 1, fileParallelism: false } })
