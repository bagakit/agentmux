import { defineConfig } from 'vitest/config'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import base from '../../../../../vitest.config'
const changes: Record<string, { path: string; from: string; to: string }> = {
  'directory-ack-omitted': { path: 'packages/core/src/agent-session-store.ts', from: 'mode: 0o600, requireDirectorySync: true,', to: 'mode: 0o600, requireDirectorySync: false,' },
  'writer-lock-bypassed': { path: 'packages/core/src/agent-session-store.ts', from: 'if (native.tryLock(handle.fd)) return async () => { await handle.close() }', to: 'if (true) return async () => { await handle.close() }' },
  'confirmation-snapshot-bypassed': { path: 'packages/core/src/agent-session-store.ts', from: 'const current = document.sessions.find(session => session.agentSessionId === agentSessionId)\n      if (!current || current.run.runId !== expectedRun.runId || !sameSession(current, expectedSession))', to: 'const current = document.sessions.find(session => session.agentSessionId === agentSessionId)\n      if (!current || current.run.runId !== expectedRun.runId)' },
  'readable-binding-discarded': { path: 'packages/core/src/agent-session-registry.ts', from: 'this.remember(session)\n        this.unconfirmedDurability.add', to: '/* mutation discards readable original binding */\n        this.unconfirmedDurability.add' }
}
const sha = (v: string) => createHash('sha256').update(v).digest('hex')
export default defineConfig({ ...base, plugins: [...(base.plugins ?? []), {
 name: 'session-durability-loaded-production-mutation', enforce: 'pre',
 transform(source, id) {
  const name = process.env.AGENTMUX_SESSION_DURABILITY_MUTANT
  if (!name) return
  const change = changes[name]
  if (!change) throw new Error('Unknown Session durability mutation')
  if (!id.replaceAll('\\', '/').endsWith('/' + change.path)) return
  const replacements = source.split(change.from).length - 1
  if (replacements !== 1) throw new Error('Mutation does not name one exact production site')
  const transformed = source.replace(change.from, change.to)
  appendFileSync(process.env.AGENTMUX_SESSION_DURABILITY_RECEIPT!, JSON.stringify({ name, path: change.path, replacements, sourceSha: sha(source), transformedSha: sha(transformed) }) + '\n')
  return { code: transformed, map: null }
 }
}], test: { ...base.test, passWithNoTests: false,
 include: ['packages/core/test/agent-session-durability.test.ts', 'packages/core/test/durable-write.test.ts'] } })
