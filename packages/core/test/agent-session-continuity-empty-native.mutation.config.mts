import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './durable-direct-resume.config.mts'

// Loaded mutants for the "no native conversation to continue" decision. Each one must fail a
// designated case in agent-session-continuity-empty-native.test.ts; the unmutated run must pass.
const root = resolve(import.meta.dirname, '../../..')
const attempt = 'packages/core/src/agent-session-recovery/continuity-attempt.ts'
const policy = 'packages/core/src/agent-session-recovery/continuity-policy.ts'
const service = 'packages/core/src/public-rpc-service.ts'
export const mutations: Record<string, Array<[string, string, string]>> = {
  // Old ordering: automatic admission parks the empty Session as idle-unknown again.
  'admission-before-fact': [[attempt, 'if (nativeConversationAbsent) admission = undefined\n    else if (receipt.intentOperationId) {', 'if (receipt.intentOperationId) {']],
  // Candidates awaiting selection are wrongly treated as "never had a conversation".
  'ignore-candidates': [[policy, '!session.observedNativeHandle && !session.nativeSourceObservation', '!session.observedNativeHandle']],
  // An unconfirmed identity save is wrongly treated as final.
  'ignore-durability': [[policy, 'return durabilityConfirmed && !session.nativeHandle', 'return !session.nativeHandle']],
  // The public resume tells the caller to retry an operation that cannot succeed.
  'public-pending': [[service, "if (restored.kind === 'unavailable' && restored.reason === 'native-conversation-absent') throw", "if (false) throw"]]
}
const owned = new Set(Object.values(mutations).flat().map(([path]) => path))

export default defineConfig({ root, cacheDir: resolve(root, '.local/cache/empty-native-continuity'), plugins: [{
  name: 'empty-native-continuity-mutants', enforce: 'pre', transform(code, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!owned.has(path)) return
    const original = code, mutation = process.env.AMX_EMPTY_NATIVE_MUTATION
    if (mutation) {
      const edits = mutations[mutation]
      if (!edits) throw new Error('Unknown empty-native mutation: ' + mutation)
      for (const [target, anchor, replacement] of edits) if (path === target) {
        if (code.split(anchor).length !== 2) throw new Error('Mutation anchor not unique: ' + mutation)
        code = code.replace(anchor, replacement)
      }
    }
    if (process.env.AMX_EMPTY_NATIVE_LOADED) appendFileSync(process.env.AMX_EMPTY_NATIVE_LOADED,
      JSON.stringify({ path, originalSHA256: createHash('sha256').update(original).digest('hex'),
        sha256: createHash('sha256').update(code).digest('hex'), ...(code !== original ? { mutation } : {}) }) + '\n')
    if (code !== original) return { code, map: null }
  }
}], define: base.define, esbuild: base.esbuild, resolve: base.resolve,
test: { include: ['packages/core/test/agent-session-continuity-empty-native.test.ts'], passWithNoTests: false, fileParallelism: false, maxWorkers: 1,
  testTimeout: 60_000, hookTimeout: 30_000 } })
