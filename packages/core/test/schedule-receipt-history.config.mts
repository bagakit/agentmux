import { defineConfig } from 'vitest/config'
import source from '../../../apps/desktop/scripts/fixtures/agent-schedules/vitest.config.mjs'

export default defineConfig({ ...source, test: { ...source.test, include: ['packages/core/test/schedule-receipt-history.test.ts'] } })
