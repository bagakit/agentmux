import { defineConfig } from 'vitest/config'
import original from './a2a-resumed-inbox.config.mts'

export default defineConfig({ ...original, test: { ...original.test,
  include: ['packages/core/test/mote-supervision-restart.test.ts'], passWithNoTests: false, testTimeout: 45_000 } })
