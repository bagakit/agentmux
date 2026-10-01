import { defineConfig } from 'vitest/config'
import owning from '../mote-navigation-footer/vitest.owning.config.mts'

// The operative entry contract consumes its five original owning files from
// current Source. Published Core dist and live Runtime/Run are outside this gate.
export default defineConfig({
  ...owning,
  test: {
    ...owning.test,
    include: ['test/mote-hover-surface.test.tsx', 'test/mote-directory-focus.test.ts',
      'test/mote-shortcut-context.test.tsx', 'test/workbench-projection-ownership.test.tsx',
      'test/pmo-focus-isolation.test.ts'],
    passWithNoTests: false
  }
})
