import base from '../scripts/fixtures/conversation-latest-auto/vitest.owning.config.mts'
import { defineConfig } from 'vitest/config'
export default defineConfig({ ...base, cacheDir: '.cache/conversation-unified-consumers', test: { ...base.test, testTimeout: 20000, environment: 'happy-dom',
 include: ['apps/desktop/test/conversation-source-roles.test.tsx', 'apps/desktop/test/conversation-chronological-reading.test.tsx',
 'apps/desktop/test/native-process-reading.test.tsx', 'apps/desktop/test/conversation-shared-native-reading.integration.test.tsx',
 'apps/desktop/test/conversation-system-message.test.tsx', 'apps/desktop/test/conversation-question-reply-reading.test.tsx',
 'packages/client-ui/test/conversation-metrics.test.tsx', 'packages/client-ui/test/conversation-native-resource.test.tsx', 'apps/desktop/test/conversation-landmarks.test.tsx'] } })
