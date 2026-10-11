import { defineConfig } from 'vitest/config'
import original from '../scripts/fixtures/workbench-identity/vitest.owning.config.mts'
import { resolve, relative } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const root = resolve(import.meta.dirname, '../../..')
const model = 'apps/desktop/src/renderer/src/lib/agent-bookmarks.ts'
const changes = {
  host: [model, 'JSON.stringify([hostId, agentSessionId])', 'JSON.stringify([agentSessionId])'],
  restore: [model, 'state = { bookmarks: restored.bookmarks, persistenceIssue:', 'state = { bookmarks: [], persistenceIssue:'],
  fence: [model, 'if (!readConfirmed) return', 'if (false && !readConfirmed) return'],
  checkpoint: ['apps/desktop/src/renderer/src/main.tsx', 'void agentBookmarks.flush()', 'void 0']
} as const
const sha = (code: string) => createHash('sha256').update(code).digest('hex')
export default defineConfig({ ...original, cacheDir: resolve(root, '.tmp/agent-bookmarks/model-cache'),
  plugins: [...original.plugins ?? [], { name: 'original-bookmark-model', enforce: 'pre', transform(code, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!path.startsWith('apps/desktop/src/') && !path.startsWith('apps/desktop/test/')) return
    const mutation = process.env.AGENT_BOOKMARK_MODEL_MUTATION as keyof typeof changes | undefined
    let served = code
    if (mutation) {
      if (!changes[mutation]) throw Error('Unknown bookmark model mutation')
      const [target, needle, replacement] = changes[mutation]
      if (path === target) {
        if (code.split(needle).length !== 2) throw Error('Expected one exact original bookmark mutation target')
        served = code.replace(needle, replacement)
      }
    }
    if (process.env.AGENT_BOOKMARK_MODEL_LOADED) appendFileSync(process.env.AGENT_BOOKMARK_MODEL_LOADED,
      JSON.stringify({ path, sourceSha256: sha(code), servedSha256: sha(served), mutated: served !== code }) + '\n')
    return served !== code ? { code: served, map: null } : undefined
  } }],
  test: { ...original.test, include: ['apps/desktop/test/agent-bookmarks-model.test.ts', 'apps/desktop/test/agent-bookmarks-checkpoint.test.tsx'], maxWorkers: 1, fileParallelism: false, passWithNoTests: false }
})
