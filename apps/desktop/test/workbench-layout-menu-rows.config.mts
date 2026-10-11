import { defineConfig } from 'vitest/config'
import owning from './selection-field.config.mts'

export default defineConfig({
  ...owning,
  test: {
    ...owning.test,
    include: ['test/workbench-layout-menu-rows.test.tsx'],
    passWithNoTests: false,
    fileParallelism: false,
    maxWorkers: 1
  }
})
