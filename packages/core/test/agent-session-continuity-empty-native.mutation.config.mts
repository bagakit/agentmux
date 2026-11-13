import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './durable-direct-resume.config.mts'

// Loaded mutants for Core's "holds no native conversation to continue" decision. Each one must fail
// a designated case in agent-session-continuity-empty-native.test.ts; the unmutated run must pass.
const root = resolve(import.meta.dirname, '../../..')
const attempt = 'packages/core/src/agent-session-recovery/continuity-attempt.ts'
const policy = 'packages/core/src/agent-session-recovery/continuity-policy.ts'
const supervisor = 'packages/core/src/agent-session-recovery/supervisor.ts'
const service = 'packages/core/src/public-rpc-service.ts'
export const mutations: Record<string, Array<[string, string, string]>> = {
  // Old ordering: automatic admission parks the empty Session as idle-unknown again.
  'admission-before-fact': [[attempt, '} else if (!nativeConversationAbsent) admission = agentContinuityAdmission(', '} else admission = agentContinuityAdmission(']],
  // The fact short-circuits authorization: a revoked standing source is no longer refused.
  'fact-skips-authorization': [[attempt, '    if (receipt.intentOperationId) {\n      const root = current.continuityOperations?.[receipt.intentOperationId]',
    '    if (nativeConversationAbsent) admission = undefined\n    else if (receipt.intentOperationId) {\n      const root = current.continuityOperations?.[receipt.intentOperationId]']],
  // Candidates awaiting selection are wrongly treated as "no conversation".
  'ignore-candidates': [[policy, '  if (session.nativeHandle || session.observedNativeHandle || session.nativeSourceObservation) return true',
    '  if (session.nativeHandle || session.observedNativeHandle) return true']],
  // An unconfirmed identity save is wrongly treated as final.
  'ignore-durability': [[policy, '  if (!facts.durabilityConfirmed || !facts.managedIdentityChannel || agentSessionHoldsNativeEvidence(session)) return false',
    '  if (!facts.managedIdentityChannel || agentSessionHoldsNativeEvidence(session)) return false']],
  // A native fact committed after the earlier observation is overwritten by the stale absence.
  'stale-absence-at-commit': [[attempt, "          if (result.kind === 'unavailable' && result.reason === 'native-conversation-absent') {",
    '          if (false) {']],
  // A rejected receipt fence still returns the old absence rather than reading the current target.
  'stale-absence-fence-retained': [[attempt,
    "        if (result.kind === 'unavailable' && result.reason === 'native-conversation-absent' && error instanceof AgentMuxError && error.code === 'STALE_AGENT_SESSION') {",
    '        if (false) {']],
  // A Provider whose identity channel Core does not install is wrongly treated as fully observed.
  'ignore-identity-channel': [[policy, '  if (!facts.durabilityConfirmed || !facts.managedIdentityChannel || agentSessionHoldsNativeEvidence(session)) return false',
    '  if (!facts.durabilityConfirmed || agentSessionHoldsNativeEvidence(session)) return false']],
  // Input typed straight into the terminal, or an unknown input count, is ignored.
  'ignore-run-input': [[policy, '  return facts.acceptedInputBytes === 0 || facts.acceptedInputBytes === protocolBytes', '  return true']],
  // An authored or unknown first prompt is ignored.
  'ignore-first-prompt': [[policy, "  if (session.creation?.initialPrompt !== 'not-requested') return true\n", '']],
  // A protocol initialization that may have created a native object is ignored.
  'ignore-initialization': [[policy, ' || session.forkedFrom || session.nativeActor?.initializationControl) return true', ' || session.forkedFrom) return true']],
  // Native status, Hook or activity evidence is ignored.
  'ignore-native-activity': [[policy, '    session.semanticStatus || session.hookReceipt || session.recoveryActivity || session.activityCommit)', '    false)']],
  // A Session parked as idle-unknown by an earlier startup is never re-decided.
  'parked-root-retained': [[supervisor, "    if (input.trigger === 'startup' && root.kind === 'pending' && root.reason === 'idle-unknown' &&",
    "    if (false && input.trigger === 'startup' && root.kind === 'pending' && root.reason === 'idle-unknown' &&"]],
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
