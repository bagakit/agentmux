import base from './vitest.mote-context.config.mts'
import { defineConfig } from 'vitest/config'
export default defineConfig({ ...base, cacheDir: '.tmp/focus-agent-menu-vitest', test: { ...base.test,
  include: ['apps/desktop/test/focus-agent-reading.test.tsx', 'apps/desktop/test/focus-stop-agent.test.tsx'], testTimeout: 20000 } })
