import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
const root = resolve(import.meta.dirname, '../../../../..')
const mutations: Record<string, [string, string, string]> = {
  capacity: ['packages/core/src/providers/codex-errors.ts', "server_overloaded: ['AGENT_MODEL_OVERLOADED'", "server_overloaded: ['AGENT_PROVIDER_ERROR'"],
  'failure-is-done': ['packages/core/src/providers/codex-session-status.ts', "evidence.endReason === 'failed' ? 'error'", "evidence.endReason === 'failed' ? 'done'"],
  'ignore-native-error': ['packages/core/src/providers/codex-prompt-execution-evidence.ts', "state === 'ended' && event.error != null", 'false'],
  'late-old-turn': ['packages/core/src/providers/codex-prompt-execution-evidence.ts', "if (latest && evidence.state === 'ended' && evidence.nativeTurnId !== latest.nativeTurnId) continue", '/* accept an old turn end */'],
  'late-stop': ['packages/core/src/client.ts', "!(nativeEnd && normalized.lifecycleEvent === 'turn-end')", 'true'],
  'no-reconnect': ['packages/core/src/client.ts', "if (code !== 'AGENT_NATIVE_STATUS_GAP') {", 'if (false) {'],
  'old-run': ['packages/core/src/client.ts', '!sameRun(current.run, session.run) || !sameNativeHandle(current.nativeHandle, session.nativeHandle) || this.endedRuns.has(current.run.runId)', '!sameNativeHandle(current.nativeHandle, session.nativeHandle) || this.endedRuns.has(current.run.runId)'],
  'batch-start-clock': ['packages/core/src/client.ts', "if (observation.initialSnapshot && observation.state === 'working' &&", "if (observation.state === 'working' &&"],
  'late-phase': ['packages/core/src/client.ts', 'await this.flushAgentActivity(next)\n            if (watch.controller.signal.aborted || this.nativeStatusWatches.get(session.agentSessionId) !== watch) return', 'await this.flushAgentActivity(next)']
}
export default defineConfig({ root, cacheDir: resolve(root, '.local/cache/provider-session-failure'), plugins: [{
  name: 'provider-failure-actual-source', enforce: 'pre', transform(code, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!path.startsWith('packages/core/src/') || !path.endsWith('.ts')) return
    const before = code, mutation = process.env.AMX_FAILURE_MUTATION
    if (mutation) {
      const edit = mutations[mutation]; if (!edit) throw new Error('Unknown mutation ' + mutation)
      if (path === edit[0]) { if (code.split(edit[1]).length !== 2) throw new Error('Mutation anchor not unique ' + mutation); code = code.replace(edit[1], edit[2]) }
    }
    if (process.env.AMX_FAILURE_LOADED) appendFileSync(process.env.AMX_FAILURE_LOADED, JSON.stringify({ path,
      originalSHA256: createHash('sha256').update(before).digest('hex'), sha256: createHash('sha256').update(code).digest('hex'),
      ...(before === code ? {} : { mutation }) }) + '\n')
    if (before !== code) return { code, map: null }
  }
}], test: { include: ['packages/core/test/provider-session-failure.test.ts', 'packages/core/test/codex-error-classification.test.ts'],
  passWithNoTests: false, fileParallelism: false, maxWorkers: 1, testTimeout: 20000, hookTimeout: 15000 } })
