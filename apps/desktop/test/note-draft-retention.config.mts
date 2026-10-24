import { resolve } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { defineConfig } from 'vitest/config'
import source from '../scripts/fixtures/file-save-recovery/vitest.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const loaded: Record<string, string> = {}
const sources = ['apps/desktop/src/renderer/src/lib/file-workbench-state.ts', 'apps/desktop/src/renderer/src/store.ts',
  'apps/desktop/src/renderer/src/lib/persisted-ui-writer.ts', 'apps/desktop/src/main/workspace-files.ts']
export default defineConfig({ ...source, root,
  resolve: { ...source.resolve, dedupe: [], conditions: ['browser', 'import', 'default'] },
  ssr: { noExternal: ['@agentmux/client-ui'], resolve: { conditions: ['browser', 'import', 'default'] } },
  plugins: [{ name: 'note-retention-source-receipt', enforce: 'pre', transform(code, id) {
    const file = id.split('?')[0]!, name = sources.find(source => resolve(root, source) === file)
    if (name && process.env.NOTE_DRAFT_RETENTION_LOAD_REPORT) {
      if (code !== readFileSync(file, 'utf8')) throw Error('Source binding changed before receipt: ' + name)
      loaded[name] = createHash('sha256').update(code).digest('hex')
      writeFileSync(process.env.NOTE_DRAFT_RETENTION_LOAD_REPORT, JSON.stringify(loaded, null, 2) + '\n')
    }
  } }],
  test: { ...source.test, include: [process.env.NOTE_DRAFT_RETENTION_STAGE
    ? 'apps/desktop/test/fixtures/note-draft-retention-process.fixture.ts' : 'apps/desktop/test/note-draft-retention.test.ts'],
    ...(process.env.NOTE_DRAFT_RETENTION_SKIP_RESTART ? { testNamePattern: /original draft/ } : {}),
    environment: 'happy-dom', testTimeout: 60_000, server: { deps: { inline: ['@agentmux/client-ui'] } } }
})
