import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
const root = resolve(import.meta.dirname, '../../../../..')
const mutations: Record<string, [string, string, string]> = {
  'diagnose-before-source-fact': ['packages/core/src/client.ts', "      this.publisher.publish({ type: 'agent-session', session: cloneSession(next) })\n      if (witness.reason ===", "      this.publisher.publish({ type: 'agent-error', agentSessionId: session.agentSessionId, code: 'AGENT_NATIVE_IDENTITY_UNCONFIRMED', message: 'Source witness pending', evidence: { source: 'agentmux', run: { ...session.run }, observedAt: Date.now() } })\n      this.publisher.publish({ type: 'agent-session', session: cloneSession(next) })\n      if (witness.reason ==="],
  'drop-source-save-diagnostic': ['packages/core/src/client.ts', "code: stale ? error.code : 'AGENT_NATIVE_IDENTITY_PERSIST_FAILED', message: stale ? error.message : 'The native source observation could not be saved.", "code: stale ? error.code : 'AGENT_NATIVE_IDENTITY_UNCONFIRMED', message: stale ? error.message : 'The native source observation could not be saved."],
  'mislabel-source-cas-stale': ['packages/core/src/client.ts', "const stale = error instanceof AgentMuxError && (error.code === 'AGENT_NATIVE_CONFIRMATION_STALE' || error.code === 'STALE_AGENT_SESSION')", 'const stale = false'],
  'skip-candidate': ['packages/core/src/client.ts', "if (witnessTargetMismatch || witness.reason === 'native-witness-unavailable' || witness.reason === 'native-main-ambiguous') {", "if (witness.reason === 'native-witness-unavailable' || witness.reason === 'native-main-ambiguous') {"],
  'keep-old-interaction': ['packages/core/src/client.ts', 'delete result.pendingInteraction', 'void result.pendingInteraction'],
  'discard-confirmation-history': ['packages/core/src/client.ts', 'nativeConfirmationHistory: [...(stored.nativeConfirmationHistory ?? []), structuredClone(stored.nativeConfirmation)]', 'nativeConfirmationHistory: []'],
  'promote-claude-sidechain': ['packages/core/src/providers/claude-native-session.ts', 'p.isSidechain === false', 'p.isSidechain !== undefined'],
  'ignore-observation-version': ['packages/core/src/client.ts', 'stored.nativeSourceObservation.observedAt !== input.expectedObservationAt', 'false'],
  'keep-unknown-source': ['packages/core/src/client.ts', 'delete next.nativeSourceObservation\n              return next', 'return next'],
  'forget-historical-source': ['packages/core/src/prompt-submission.ts', '...(session.nativeConfirmationHistory ?? [])', '...[]'],
  'overwrite-confirmed-source-with-unknown': ['packages/core/src/client.ts', "if (!sameNativeHandle(value.nativeHandle, retained)) throw new AgentMuxError('The original failed source observation is stale.'", "if (false) throw new AgentMuxError('The original failed source observation is stale.'"],
  'hide-history-save-failure': ['packages/core/src/client.ts', "code: persistenceFailure === undefined ? 'AGENT_NATIVE_SOURCE_UNCONFIRMED' : 'AGENT_NATIVE_IDENTITY_PERSIST_FAILED'", "code: 'AGENT_NATIVE_SOURCE_UNCONFIRMED'"],
  'skip-history-save-failure-source-fence': ['packages/core/src/client.ts', "throw saveError\n            await checkStored()", "throw saveError\n            // no source fence"],
  'replay-old-prompt': ['packages/core/src/prompt-submission.ts', "if (promptBelongsToPreviousNativeSource(session, submissionId)) {", 'if (false) {'],
  'disconnect-rpc': ['packages/core/src/public-rpc-service.ts', "if (method === 'agent.native.confirm') {", "if (method === '__disabled_native_confirm__') {"]
}
export default defineConfig({ root, cacheDir: resolve(root, '.local/cache/native-session-change-vite'), plugins: [{
  name: 'loaded-current-native-source', enforce: 'pre', transform(code, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!path.startsWith('packages/core/src/') || !/\.ts$/u.test(path)) return
    const before = code, mutation = process.env.AMX_SOURCE_CHANGE_MUTATION
    if (mutation) {
      const change = mutations[mutation]
      if (!change) throw new Error('Unknown mutation')
      if (path === change[0]) {
        if (code.split(change[1]).length !== 2) throw new Error('Mutation anchor is not unique: ' + mutation)
        code = code.replace(change[1], change[2])
      }
    }
    if (process.env.AMX_SOURCE_CHANGE_LOADED) appendFileSync(process.env.AMX_SOURCE_CHANGE_LOADED, JSON.stringify({ path,
      originalSHA256: createHash('sha256').update(before).digest('hex'), sha256: createHash('sha256').update(code).digest('hex'),
      ...(before !== code ? { mutation } : {}) }) + '\n')
    if (before !== code) return { code, map: null }
  }
}], test: { include: ['packages/core/test/native-session-change.test.ts'], passWithNoTests: false, fileParallelism: false,
  maxWorkers: 1, testTimeout: 30000, hookTimeout: 30000 } })
