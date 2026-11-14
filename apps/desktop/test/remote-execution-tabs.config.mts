import { defineConfig } from 'vitest/config'
import owning from './vitest.ui-controls-owning.config.mts'

export default defineConfig({
  ...owning,
  test: { ...owning.test, include: ['apps/desktop/test/remote-execution-tabs.test.tsx'], passWithNoTests: false, maxWorkers: 1 }
})
