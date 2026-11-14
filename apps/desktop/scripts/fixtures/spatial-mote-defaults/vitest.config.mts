import { defineConfig } from 'vitest/config'
import owning from '../survey-page-cli/vitest.config.mts'
export default defineConfig({ ...owning, test: { ...owning.test,
  include: ['apps/desktop/test/spatial-mote-defaults.test.ts'], testNamePattern: 'original presentation|strict public consumers|fresh Source CLI' } })
