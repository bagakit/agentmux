import { defineConfig } from 'vitest/config'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const mutants: Record<string, [string, string]> = {
  'ignore-source': ['evidence?.sourceId === previousTurn.sourceId && evidence.nativeTurnId === previousTurn.nativeTurnId', 'true'],
  'ignore-thread': ['thread?.id !== nativeHandle.sessionId', 'false'],
  'ignore-latest-turn': ['turn?.id !== previousTurn.nativeTurnId', 'false'],
  'ignore-root-generation': ['await nativeProcessBirth(processId, signal) !== birth', 'false'],
  'guess-unknown-status': [": turn.status === 'failed' ? 'failed' : undefined", ": turn.status === 'failed' ? 'failed' : 'interrupted'"],
  'renew-activity-clock': ['{ observedAt: previousTurn.observedAt }', '{ observedAt: Date.now() }']
}
export default defineConfig({ root,
  cacheDir: resolve(root, '.tmp/recovery-protocol-convergence/provider-cache', process.env.AGENTMUX_RESUMED_TURN_MUTATION ?? 'positive'),
  plugins: [{ name: 'actual-resumed-turn-source', enforce: 'pre', transform(code, id) {
    const path = relative(root, id.split('?')[0]!)
    if (path !== 'packages/core/src/providers/codex-resumed-turn-interruption.ts') return
    const original = code, mutation = process.env.AGENTMUX_RESUMED_TURN_MUTATION
    const change = mutation ? mutants[mutation] : undefined
    if (mutation && !change) throw new Error('Unknown resumed-turn source mutation')
    if (change) {
      if (code.split(change[0]).length !== 2) throw new Error('Resumed-turn mutation anchor must be unique')
      code = code.replace(change[0], change[1])
    }
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_RESUMED_TURN_LOADED) appendFileSync(process.env.AGENTMUX_RESUMED_TURN_LOADED,
      JSON.stringify({ path, originalSHA256: sha(original), sha256: sha(code), ...(mutation ? { mutation } : {}) }) + '\n')
    if (code !== original) return { code, map: null }
  } }],
  test: { environment: 'node', globalSetup: [], passWithNoTests: false, fileParallelism: false,
    include: ['packages/core/test/codex-resumed-turn-interruption.test.ts'], testTimeout: 20_000 }
})
