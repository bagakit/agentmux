import { defineConfig } from 'vitest/config'
import source from '../demand-activity/vitest.config.mts'

export default defineConfig({ ...source, test: { ...source.test,
  include: ['test/demand-supervisor-setting.test.tsx', 'test/settings-work-preferences-control.test.ts', 'test/settings-work-preferences.test.tsx'], passWithNoTests: false
} })
