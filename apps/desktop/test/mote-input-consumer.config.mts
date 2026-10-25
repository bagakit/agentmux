import { defineConfig } from 'vitest/config'
import owning from './mote-recent-agent.config.mts'
export default defineConfig({ ...owning, test: { ...owning.test,
  include: ['test/mote-input-consumer.test.tsx'], passWithNoTests: false, testTimeout: 15000
} })
