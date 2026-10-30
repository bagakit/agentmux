import { defineConfig } from 'vitest/config'
import owning from '../../desktop/test/vitest.mote-context.config.mts'

export default defineConfig({ ...owning, test: { ...owning.test,
  include: ['apps/host/test/mote-directory-packaged-helper.test.ts'], passWithNoTests: false } })
