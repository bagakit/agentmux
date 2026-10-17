import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import source from './performance-capture.config.mts'
export default defineConfig({ ...source,
  cacheDir: resolve(import.meta.dirname, '../../../.cache/notification-demand'),
  test: { ...source.test, setupFiles: ['apps/desktop/test/fixtures/notification-publication-boundary.ts'], include: process.env.AGENTMUX_NOTIFICATION_OWNING
    ? ['apps/desktop/test/{notification-demand,notification-preview,notification-item,unified-notifications,startup-snapshot-notice-resolution,agent-launch-resume-feedback,focus-terminal-recovery,layered-human-interaction,displaced-agent-notice,native-identity-notice-reconciliation,agent-fault-notice,runtime-endpoint-notice}.test.{ts,tsx}']
    : ['apps/desktop/test/notification-demand.test.tsx', 'apps/desktop/test/notification-preview.test.ts'] }
})
