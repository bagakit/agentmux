import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../../../../..');
export default defineConfig({
  root,
  define: {
    __AGENTMUX_WEB_PREVIEW__: 'true'
  },
  resolve: {
    conditions: ['browser', 'import', 'default']
  },
  ssr: {
    noExternal: ['@agentmux/client-ui'],
    resolve: {
      conditions: ['browser', 'import', 'default']
    }
  },
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react'
  },
  cacheDir: resolve(root, '.question-adjacent-cache'),
  test: {
    include: ['apps/desktop/test/agent-interaction-card.test.tsx', 'apps/desktop/test/agent-interaction-plan.test.ts', 'apps/desktop/test/conversation-pending-interaction.integration.test.tsx'],
    passWithNoTests: false,
    fileParallelism: false,
    server: {
      deps: {
        inline: ['@agentmux/client-ui']
      }
    }
  }
});
