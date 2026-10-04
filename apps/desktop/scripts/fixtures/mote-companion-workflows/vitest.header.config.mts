import { defineConfig } from 'vitest/config'
import owning from '../mote-navigation-footer/vitest.owning.config.mts'
export default defineConfig({ ...owning, test: { ...owning.test,
  include: ['test/mote-file-header.test.tsx'], passWithNoTests: false } })
