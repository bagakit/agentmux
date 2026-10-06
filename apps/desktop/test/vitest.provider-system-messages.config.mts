import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config'

// Match the Renderer export condition so the real Desktop adapter and shared
// consumers share one platform context and mutations exercise current source.
export default defineConfig({
  ...original,
  root: resolve(import.meta.dirname, '../../..'),
  resolve: { conditions: ['browser', 'import', 'default'] },
  ssr: { noExternal: ['@agentmux/client-ui'], resolve: { conditions: ['browser', 'import', 'default'] } },
  esbuild: { jsx: 'automatic' },
  test: {
    ...original.test,
    server: { deps: { inline: ['@agentmux/client-ui'] } },
    include: ['packages/core/test/provider-system-messages.test.ts', 'apps/desktop/test/conversation-system-message.test.tsx',
      'apps/desktop/test/focus-provider-system-message.test.tsx'],
    passWithNoTests: false,
    fileParallelism: false
  }
})
