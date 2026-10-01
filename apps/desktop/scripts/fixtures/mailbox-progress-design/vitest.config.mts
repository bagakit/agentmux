import { defineConfig } from 'vitest/config'
import sourceConfig from '../settings-overview/vitest.config.mts'

// Renderer tests use the existing source exports and normal fixture setup, without building shared dist.
export default defineConfig({ ...sourceConfig, test: { ...sourceConfig.test, include: [
  'apps/desktop/test/session-mailbox.test.tsx',
  'apps/desktop/test/session-mailbox-receipts.test.tsx',
  'apps/desktop/test/continuous-progress-panel.test.tsx',
  'apps/desktop/test/continuous-progress-recovery-projection.test.tsx',
  'apps/desktop/test/product-quality-foundation.test.tsx'
] } })
