import { defineConfig } from 'vitest/config'
import source from './vitest.mote-context.config.mts'
export default defineConfig({ ...source, test: { ...source.test, include: [
  'apps/desktop/test/focus-disconnected-recovery.test.tsx',
  'apps/desktop/test/focus-region-close-continuity.test.tsx',
  'apps/desktop/test/focus-stop-agent.test.tsx',
  'apps/desktop/test/session-stop-timeout.test.ts'
] } })
