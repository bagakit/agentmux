import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
const root = resolve(import.meta.dirname, '../../..'), loaded: Record<string, string> = {}
export default defineConfig({ root,
  plugins: [{ name: 'original-note-file-owner-source', enforce: 'pre', transform(code, id) {
    const path = id.split('?')[0]!
    if (process.env.NOTE_FILE_OWNER_LOADED && path.startsWith(resolve(root, 'packages/core/src') + '/') && /\/(?:notebook-(?:store|files|sqlite-import)|notes-storage|durable-write)\.ts$/.test(path)) {
      if (readFileSync(path, 'utf8') !== code) throw Error('Original file owner source changed before transform')
      loaded[path.slice(root.length + 1)] = createHash('sha256').update(code).digest('hex')
      writeFileSync(process.env.NOTE_FILE_OWNER_LOADED, JSON.stringify(loaded, null, 2) + '\n')
    }
  } }],
  test: { include: ['packages/core/test/{notebook-files,notebook-sqlite,notebook-store,notes-storage,note-history,note-history-batch,notebook-provenance-batch,note-metadata-relocation}.test.ts'],
    setupFiles: [resolve(root, 'vitest.setup.ts')], maxWorkers: 1, testTimeout: 30_000 }
})
