import { defineConfig } from 'vitest/config'
import source from '../../../../../test/vitest.amux-protocol-cards.config.mts'

export default defineConfig({
  ...source,
  test: { ...source.test, environment: 'node', passWithNoTests: false, maxWorkers: 1,
    include: ['apps/desktop/scripts/fixtures/amux-protocol-cards/generate.test.ts'] }
})
