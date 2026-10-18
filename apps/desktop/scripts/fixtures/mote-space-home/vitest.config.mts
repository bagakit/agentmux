import { defineConfig } from 'vitest/config'
import owning from '../mote-workspace/vitest.config.mts'

export default defineConfig({ ...owning, test: { ...owning.test,
  include: ['test/mote-space-home.test.tsx', 'test/mote-home-open-response.test.tsx', 'test/mote-workspace.test.tsx', 'test/mote-cooperation.test.tsx', 'test/mote-daily-work.test.tsx', 'test/mote-memory-profile.test.tsx'],
  passWithNoTests: false, maxWorkers: 1
} })
