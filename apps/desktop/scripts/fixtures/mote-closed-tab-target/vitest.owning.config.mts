import owning from '../mote-navigation-footer/vitest.owning.config.mts'
import { defineConfig } from 'vitest/config'

export default defineConfig({ ...owning, test: { ...owning.test,
  include: ['test/mote-closed-tab-target.test.tsx', 'test/mote-hover-surface.test.tsx', 'test/workbench-projection-ownership.test.tsx'],
  passWithNoTests: false, maxWorkers: 1
} })
