import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const repository = resolve(root, '../..')
export default defineConfig({
  root,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: {
    '@agentmux/core/agent-message-render': resolve(repository, 'packages/core/src/agent-message-render.ts')
  } },
  test: { include: ['test/conversation-declared-avatar.test.tsx'], passWithNoTests: false, environment: 'happy-dom' }
})
