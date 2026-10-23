import { resolve } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import base from './hook-postcommit-observation.vitest.config.mts'
const mutation = process.env.AGENTMUX_INITIALIZATION_SERVICE_MUTATION
if (mutation && !['trust-running', 'drop-native-record-discovery', 'old-initial-observation-order'].includes(mutation)) throw new Error('Unknown initialization service mutation')
export default { ...base, resolve: { alias: [
  { find: '@agentmux/identity/runtime-source', replacement: resolve(import.meta.dirname, '../../identity/dist/runtime-source.js') },
  ...base.resolve.alias
] }, plugins: [{ name: 'actual-initialization-service-mutation', enforce: 'pre' as const,
  transform(code: string, id: string) {
    const owner = mutation === 'trust-running' ? 'continuity-attempt.ts' : 'reconciliation.ts'
    if (id.split('?')[0] !== resolve(import.meta.dirname, '../src/agent-session-recovery/' + owner)) return
    let changed = code
    if (mutation === 'old-initial-observation-order') {
      const early = '  observeInitialInput(session: AgentMuxStoredAgentSession): void {\n    if (this.signal.aborted) return\n'
      const enumeration = 'const retained = controlled ? Object.values'
      const controlled = "operation.launchInput.state)) : []"
      const late = '    if (!initial && !retained.length) return'
      if ([early, enumeration, controlled, late].some(anchor => code.split(anchor).length !== 2)) throw new Error('Observation mutation must match the actual reconciler exactly once')
      changed = code.replace(early, '  observeInitialInput(session: AgentMuxStoredAgentSession): void {\n')
        .replace(enumeration, 'const retained = Object.values').replace(controlled, 'operation.launchInput.state))')
        .replace(late, '    if (this.signal.aborted || !initial && !retained.length) return')
    } else if (mutation) {
      const before = mutation === 'drop-native-record-discovery'
        ? 'this.ports.terminal.queueNativeIdentityCapture(current)'
        : 'if (receipt.initializationRecovery || initialization && !initializedTarget || current.nativeActor?.initializationControl && !initializedTarget) {'
      if (code.split(before).length !== 2) throw new Error('Initialization mutation must match its actual owner exactly once')
      changed = code.replace(before, mutation === 'drop-native-record-discovery' ? 'void current' : 'if (false) {')
    }
    if (process.env.AGENTMUX_INITIALIZATION_SERVICE_LOADED) appendFileSync(process.env.AGENTMUX_INITIALIZATION_SERVICE_LOADED,
      JSON.stringify({ mutation: mutation ?? 'none', source: id, originalSHA256: createHash('sha256').update(code).digest('hex'),
        loadedSHA256: createHash('sha256').update(changed).digest('hex') }) + '\n')
    if (mutation) return { code: changed, map: null }
  }
}], test: { ...base.test, include: ['packages/core/test/agent-session-initialization-service.test.ts'],
  fileParallelism: false, maxWorkers: 1, passWithNoTests: false, testTimeout: 15_000 } }
