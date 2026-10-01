import { defineConfig } from 'vitest/config'
import owning from './vitest.owning.config.mts'

export default defineConfig({ ...owning, test: { ...owning.test,
  include: ['apps/desktop/test/session-mailbox-reading-flow.test.tsx', 'apps/desktop/test/agent-session-composer-reference-open.test.tsx'],
  passWithNoTests: false
} })
