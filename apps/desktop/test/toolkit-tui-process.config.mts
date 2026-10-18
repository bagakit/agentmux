import { defineConfig } from 'vitest/config'
import owning from '../scripts/fixtures/toolkit-custom/vitest.config.mts'

export default defineConfig({ ...owning, test: { ...owning.test,
  include: ['apps/desktop/test/toolkit-tui-process.test.ts'], passWithNoTests: false } })
