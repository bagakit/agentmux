import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config'

export default defineConfig({
  ...original,
  root: resolve(import.meta.dirname, '../../..'),
  resolve: { conditions: ['browser', 'import', 'default'] },
  ssr: { noExternal: ['@agentmux/client-ui'], resolve: { conditions: ['browser', 'import', 'default'] } },
  esbuild: { jsx: 'automatic' },
  test: {
    ...original.test,
    server: { deps: { inline: ['@agentmux/client-ui'] } },
    include: ['packages/core/test/codex-question-reply-history.test.ts',
      'apps/desktop/test/conversation-question-reply-reading.test.tsx',
      'apps/desktop/test/question-reply-consumers.test.tsx'],
    passWithNoTests: false,
    fileParallelism: false
  }
})
