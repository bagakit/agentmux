import { defineConfig } from 'vitest/config'
import owning from '../mote-navigation-footer/vitest.owning.config.mts'

// Keep the maintained current-Source public export aliases and isolated test setup.
// This template gate exercises Core envelope planning, without claiming a live Run.
export default defineConfig({
  ...owning,
  test: {
    ...owning.test,
    include: ['test/mote-default-knowledge.test.ts', 'test/space-role-soul-session.test.ts'],
    passWithNoTests: false
  }
})
