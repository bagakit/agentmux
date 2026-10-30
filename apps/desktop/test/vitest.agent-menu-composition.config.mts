import { defineConfig } from 'vitest/config'
import source from './vitest.mote-context.config.mts'
export default defineConfig({ ...source, test: { ...source.test,
  include: ['apps/desktop/test/agent-menu-product.test.tsx', 'apps/desktop/test/focus-stop-agent.test.tsx',
    'apps/desktop/test/session-restart.test.tsx', 'apps/desktop/test/agent-region-identity-menu.test.tsx']
} })
