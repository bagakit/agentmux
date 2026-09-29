import { defineConfig } from 'vitest/config'
import sourceConfig from '../settings-overview/vitest.config.mts'

// Actual Core/Demand sources and normal setup; this slice does not certify compiled Runtime.
export default defineConfig({
  ...sourceConfig,
  test: {
    ...sourceConfig.test,
    include: ['apps/desktop/test/session-mailbox.test.tsx', 'apps/desktop/test/session-mailbox-receipts.test.tsx']
  }
})
