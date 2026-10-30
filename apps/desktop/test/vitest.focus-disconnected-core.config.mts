import { defineConfig } from 'vitest/config'
import source from './vitest.mote-context.config.mts'
export default defineConfig({ ...source, test: { ...source.test, include: [
  'packages/core/test/focus-exited-stop.test.ts', 'packages/core/test/stop-explicit-retry.test.ts'
] } })
