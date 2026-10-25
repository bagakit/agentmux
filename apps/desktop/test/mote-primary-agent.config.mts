import { defineConfig } from 'vitest/config'
import owning from './mote-recent-agent.config.mts'

export default defineConfig({ ...owning, test: { ...owning.test,
  include: ['test/mote-recent-agent.test.tsx', 'test/mote-quick-mode.test.tsx', 'test/mote-first-primary.test.tsx'],
  passWithNoTests: false, testTimeout: 15000
} })
