import { defineConfig } from 'vitest/config'
import owning from './vitest.xterm-selection-snapshot.config.mts'

export default defineConfig({
  ...owning,
  test: { ...owning.test, include: ['test/xterm-local-link-gesture.test.ts'], passWithNoTests: false }
})
