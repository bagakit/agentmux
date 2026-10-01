import { defineConfig } from 'vitest/config'
import sourceConfig from '../settings-overview/vitest.config.mts'

// Actual Core/Demand sources and normal setup; this slice does not certify compiled Runtime.
export default defineConfig({
  ...sourceConfig,
  resolve: {
    ...sourceConfig.resolve,
    alias: [
      { find: /^@agentmux\/client-ui\/components\/(.+)$/, replacement: new URL('../../../../../packages/client-ui/src/components/$1.tsx', import.meta.url).pathname },
      { find: /^@agentmux\/client-ui\/platform$/, replacement: new URL('../../../../../packages/client-ui/src/platform.tsx', import.meta.url).pathname },
      { find: /^@agentmux\/client-ui\/(.+)$/, replacement: new URL('../../../../../packages/client-ui/src/lib/$1.ts', import.meta.url).pathname },
      { find: /^@agentmux\/client-ui$/, replacement: new URL('../../../../../packages/client-ui/src/index.ts', import.meta.url).pathname },
      ...(sourceConfig.resolve?.alias ?? [])
    ]
  },
  test: {
    ...sourceConfig.test,
    include: ['apps/desktop/test/session-mailbox.test.tsx', 'apps/desktop/test/session-mailbox-receipts.test.tsx']
  }
})
