import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import source from '../scripts/fixtures/file-save-recovery/vitest.config.mts'

export default defineConfig({ ...source,
  root: resolve(import.meta.dirname, '../../..'),
  resolve: { ...source.resolve, dedupe: [], conditions: ['browser', 'import', 'default'] },
  ssr: { noExternal: ['@agentmux/client-ui'], resolve: { conditions: ['browser', 'import', 'default'] } },
  test: { ...source.test, include: ['apps/desktop/test/note-passive-reading.test.tsx', 'apps/desktop/test/file-preview-pane.test.tsx'],
    testNamePattern: /cold passive Mote preview|keeps passive updates, editing and hidden retention|current source preview is bounded/,
    server: { deps: { inline: ['@agentmux/client-ui'] } } }
})
