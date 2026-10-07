import { defineConfig } from 'vitest/config'
import { resolve, relative } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import shared from '../workbench-identity/vitest.owning.config.mts'
const root = resolve(import.meta.dirname, '../../../../..')
const target = 'apps/desktop/src/renderer/src/lib/session-user-messages.ts'
const changes = {
  display: ['const sessions = agentSessionPresentationIndex(state.sessions).get(control.agentSessionId)', 'const sessions = state.sessions.filter(session => session.kind === "agent" && session.id === control.agentSessionId)'],
  host: ['session.control.hostId !== control.hostId || ', '']
} as const
export default defineConfig({ ...shared, cacheDir: resolve(root, '.tmp/agent-reading-preview/source-cache'),
  plugins: [...shared.plugins ?? [], { name: 'exact-shared-reader-source', enforce: 'pre', transform(code, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!path.startsWith('apps/desktop/src/') && path !== 'apps/desktop/test/session-user-message-source.test.tsx') return
    let served = code
    const mutation = process.env.AGENT_READING_SOURCE_MUTATION as keyof typeof changes | undefined
    if (mutation && path === target) {
      const change = changes[mutation]
      if (!change || code.split(change[0]).length !== 2) throw Error('One original source lookup is required: ' + mutation)
      served = code.replace(change[0], change[1])
    }
    if (process.env.AGENT_READING_SOURCE_LOADED) appendFileSync(process.env.AGENT_READING_SOURCE_LOADED, JSON.stringify({ path,
      sourceSha256: createHash('sha256').update(code).digest('hex'), servedSha256: createHash('sha256').update(served).digest('hex'), mutated: code !== served }) + '\n')
    return served !== code ? { code: served, map: null } : undefined
  } }],
  test: { ...shared.test, include: ['apps/desktop/test/session-user-message-source.test.tsx'], passWithNoTests: false, maxWorkers: 1, fileParallelism: false }
})
