import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import base from '../../../vitest.config'

const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ ...base,
  root,
  resolve: { ...base.resolve, conditions: ['browser'], dedupe: ['react', 'react-dom'],
    alias: { ...base.resolve?.alias as Record<string, string>,
      react: resolve(root, 'apps/desktop/node_modules/react'), 'react-dom': resolve(root, 'apps/desktop/node_modules/react-dom') } },
  test: { ...base.test, include: ['apps/desktop/test/conversation-process-dock.test.tsx',
    'apps/desktop/test/conversation-earlier-anchor.test.ts', 'apps/desktop/test/workflow-components.test.tsx',
    'apps/desktop/test/workflow-themed-status-glyph.test.tsx',
    'packages/client-ui/test/conversation-invocation-reading.test.tsx'], passWithNoTests: false }
})
