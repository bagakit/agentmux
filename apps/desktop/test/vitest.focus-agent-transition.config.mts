import base from './vitest.mote-context.config.mts'
import { defineConfig } from 'vitest/config'
export default defineConfig({ ...base, cacheDir: '.tmp/focus-agent-transition-vitest', test: { ...base.test,
  include: ['apps/desktop/test/focus-agent-transition.test.tsx', 'apps/desktop/test/current-agent-fork-ui.test.tsx', 'apps/desktop/test/current-fork-direction-contract.test.ts', 'apps/desktop/test/session-takeover.test.tsx'], testTimeout: 25000 } })
