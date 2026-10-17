import { defineConfig } from 'vitest/config'
import messageData from './vitest.a2a-message-data.config.mts'

export default defineConfig({
  ...messageData,
  define: { ...messageData.define, __AGENTMUX_WEB_PREVIEW__: 'true' },
  test: { ...messageData.test, include: ['apps/desktop/test/a2a-relation-preview.test.ts'] }
})
