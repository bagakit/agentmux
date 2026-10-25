import { defineConfig } from 'vitest/config'
import source from '../../desktop/scripts/fixtures/agent-schedules/vitest.config.mjs'

// The shared fixture resolves Core/Host to source and isolates all Runtime state.
export default defineConfig({ ...source, test: { ...source.test, include: [
  'apps/host/test/continuous-progress-manual-check.test.ts',
  'apps/host/test/agent-automation-boundaries.test.ts',
  'packages/core/test/continuous-progress.test.ts'
] } })
