import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
const root = resolve(import.meta.dirname, '../../../../..')
const mutations: Record<string, [string, string, string]> = {
  'failure-is-success': ['packages/core/src/providers/codex-turn-outcome.ts', "if (payload.error != null) return { status: 'failed', failure: codexFailure(payload.error, payload.turn_id) }", "if (payload.error != null) return { status: 'completed' }"],
  'drop-history-outcome': ['packages/core/src/session-history.ts', '...normalizeTurnOutcome(item),', ''],
  'drop-deferred-outcome': ['packages/core/src/conversation-process-detail.ts', "'metrics', 'metricsDiagnostic', 'turnOutcome', 'turnOutcomeDiagnostic'", "'metrics', 'metricsDiagnostic'"],
  'lose-suppressed-failure': ['packages/core/src/client.ts', 'if (observation.failure) {\n              const observedAt', 'if (displayAccepted && observation.failure) {\n              const observedAt']
}
export default defineConfig({ root, cacheDir: resolve(root, '.local/cache/provider-outcome'), plugins: [{
  name: 'provider-outcome-production-mutation', enforce: 'pre', transform(code, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!path.startsWith('packages/core/src/') || !path.endsWith('.ts')) return
    const before = code, mutation = process.env.AMX_OUTCOME_MUTATION
    if (mutation) {
      const edit = mutations[mutation]
      if (!edit) throw Error('Unknown outcome mutation: ' + mutation)
      if (path === edit[0]) {
        if (code.split(edit[1]).length !== 2) throw Error('Outcome mutation anchor is not unique: ' + mutation)
        code = code.replace(edit[1], edit[2])
      }
    }
    if (process.env.AMX_OUTCOME_LOADED) appendFileSync(process.env.AMX_OUTCOME_LOADED, JSON.stringify({ path,
      original: createHash('sha256').update(before).digest('hex'), loaded: createHash('sha256').update(code).digest('hex'),
      ...(before === code ? {} : { mutation }) }) + '\n')
    if (before !== code) return { code, map: null }
  }
}], test: { include: ['packages/core/test/provider-turn-outcome.test.ts', 'packages/core/test/provider-session-failure.test.ts',
  'packages/core/test/codex-error-classification.test.ts'], passWithNoTests: false, fileParallelism: false, maxWorkers: 1,
  testTimeout: 30_000, hookTimeout: 20_000 } })
