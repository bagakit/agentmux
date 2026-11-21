import { defineConfig } from 'vitest/config'
import owning from '../../../test/vitest.ui-controls-owning.config.mts'

// Keep independent mounted source tests on the same current package exports as Desktop.
// Their historical business assertions are separate from this fixture's native geometry gate.
export default defineConfig({
  ...owning,
  test: {
    ...owning.test,
    include: [
      'apps/desktop/test/session-mailbox.test.tsx',
      'apps/desktop/test/session-mailbox-receipts.test.tsx'
    ]
  }
})
