import { defineConfig } from 'vitest/config'
import sourceConfig from '../settings-overview/vitest.config.mts'
export default defineConfig({ ...sourceConfig, test: { ...sourceConfig.test, include: [
  'apps/desktop/test/session-mailbox.test.tsx', 'apps/desktop/test/session-mailbox-receipts.test.tsx',
  'apps/desktop/test/session-mailbox-native-messages.integration.test.tsx',
  'apps/desktop/test/provider-user-message-mailbox-spine.integration.test.tsx',
  'apps/desktop/test/session-mailbox-reading-flow.test.tsx',
  'apps/desktop/test/agent-steer-queue-deliverability.test.tsx', 'apps/desktop/test/prompt-uncertain-turn-continuation.test.tsx',
  'apps/desktop/test/provider-ingress-consumers.test.tsx'
] } })
