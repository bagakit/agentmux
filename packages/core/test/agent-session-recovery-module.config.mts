import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import base from './hook-postcommit-observation.vitest.config.mts'
const mutation = process.env.AGENTMUX_RECOVERY_MODULE_MUTATION
if (mutation && !['unknown-as-missing', 'source-as-startup'].includes(mutation)) throw new Error('Unknown recovery module mutation')
export default { ...base, resolve: { alias: [{ find: '@agentmux/identity/runtime-source', replacement: resolve(import.meta.dirname, '../../identity/dist/runtime-source.js') }, ...base.resolve.alias] }, plugins: [{ name: 'actual-recovery-owner-mutation', enforce: 'pre' as const,
  transform(code: string, id: string) {
    const source = id.split('?')[0]
    if (source === resolve(import.meta.dirname, '../src/agent-session-recovery/continuity-contract.ts')) {
      const original = '  return value\n}\n\nexport type AgentMuxContinuityPendingReason'
      if (code.split(original).length !== 2) throw new Error('Recovery source mutation must match its actual parser exactly once')
      const loaded = mutation === 'source-as-startup' ? code.replace(original,
        "  return value.endsWith('-startup') ? 'startup' : value\n}\n\nexport type AgentMuxContinuityPendingReason") : code
      if (process.env.AGENTMUX_RECOVERY_SOURCE_RECEIPT) writeFileSync(process.env.AGENTMUX_RECOVERY_SOURCE_RECEIPT, JSON.stringify({
        schema: 'agentmux.recovery-source-loaded.v1', source: 'packages/core/src/agent-session-recovery/continuity-contract.ts',
        mutation: mutation ?? null, sourceSha256: createHash('sha256').update(code).digest('hex'), loadedSha256: createHash('sha256').update(loaded).digest('hex')
      }))
      return loaded === code ? undefined : { code: loaded, map: null }
    }
    if (mutation === 'unknown-as-missing' && source === resolve(import.meta.dirname, '../src/agent-session-recovery/service.ts')) {
      const original = "if (!(error instanceof AgentMuxError && error.code === 'CTXMUX_run_not_found')) {"
      if (code.split(original).length !== 2) throw new Error('Recovery mutation must match the actual owner exactly once')
      return { code: code.replace(original, 'if (false) {'), map: null }
    }
  }
}], test: { ...base.test, include: ['packages/core/test/agent-session-recovery-module.test.ts', 'packages/core/test/agent-session-recovery-sources.test.ts'], passWithNoTests: false, maxWorkers: 1 } }
