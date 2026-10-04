import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../../../../../', import.meta.url))
export default defineConfig({ root,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@agentmux/core/agent-message-render': `${root}packages/core/src/agent-message-render.ts`, '@agentmux/core/session-user-messages': `${root}packages/core/src/session-user-messages.ts` } },
  test: { include: ['packages/client-ui/test/conversation-files.test.tsx'], environment: 'happy-dom', globals: false, maxWorkers: 1 }
})
