import base from './hook-postcommit-observation.vitest.config.mts'
import { resolve } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const mutation = process.env.AGENTMUX_FRONTEND_SUPERVISION_MUTATION
const mutations: Record<string, [string, string, string]> = {
  'drop-creation-observer': ['service.ts', 'const operationId = creationFrontendIntent(session)', 'const operationId: string | undefined = undefined'],
  'borrow-another-created-run': ['service.ts', 'if (!createdRun || !sameRun(createdRun, session.run)) return', 'if (!createdRun) return'],
  'split-manual-budget': ['supervisor.ts', "const manualFrontend = input.trigger === 'manual' && session.nativeActor?.frontendControl", 'const manualFrontend = false'],
  'forget-observer-identity': ['supervisor.ts', "const observer = manualFrontend && requested?.kind === 'pending'", "const observer = false && requested?.kind === 'pending'"],
  'drop-slow-promotion': ['continuity-attempt.ts', 'const supervision = frontendObservation && latest?.supervision?.attemptCount === 0 &&', 'const supervision = false && latest?.supervision?.attemptCount === 0 &&'],
  'drop-queued-exact-wake': ['supervisor.ts', 'retryObservation || this.reobservations.has(JSON.stringify([session.agentSessionId, op.operationId]))', 'retryObservation'],
  'drop-original-run-observer': ['supervisor.ts', "active.frontendReconnect || active.kind === 'reattachable'", 'active.frontendReconnect'],
  'resume-ended-frontend-backend': ['supervisor.ts', 'const pendingFrontendOnly = sameRunFrontend &&', 'const pendingFrontendOnly = false &&'],
  'ignore-original-stop': ['supervisor.ts', "if (lifecycle?.kind === 'stop' && sameRun(lifecycle.expectedRun, session.run) && activeRun &&", "if (false && lifecycle?.kind === 'stop' && sameRun(lifecycle.expectedRun, session.run) && activeRun &&"]
}
if (mutation && !mutations[mutation]) throw new Error('Unknown frontend supervision mutation')
export default { ...base, resolve: { alias: [
  { find: '@agentmux/identity/runtime-source', replacement: resolve(import.meta.dirname, '../../identity/dist/runtime-source.js') },
  ...base.resolve.alias
] }, plugins: [{ name: 'loaded-frontend-supervision-owner', enforce: 'pre' as const,
  transform(source: string, id: string) {
    const path = id.split('?')[0]!
    if (!['service.ts', 'supervisor.ts', 'continuity-attempt.ts'].some(name => path === resolve(import.meta.dirname, '../src/agent-session-recovery', name))) return
    let loaded = source
    const change = mutation ? mutations[mutation] : undefined
    if (change && path === resolve(import.meta.dirname, '../src/agent-session-recovery', change[0])) {
      if (source.split(change[1]).length !== 2) throw new Error('Mutation requires exactly one loaded causal boundary: ' + mutation)
      loaded = source.replace(change[1], change[2])
    }
    if (process.env.AGENTMUX_FRONTEND_SUPERVISION_LOADED) appendFileSync(process.env.AGENTMUX_FRONTEND_SUPERVISION_LOADED,
      JSON.stringify({ mutation: mutation ?? null, source: path, originalSHA256: createHash('sha256').update(source).digest('hex'),
        loadedSHA256: createHash('sha256').update(loaded).digest('hex') }) + '\n')
    if (loaded !== source) return { code: loaded, map: null }
  }
}], test: { ...base.test, include: ['packages/core/test/frontend-supervision-service.test.ts'],
  passWithNoTests: false, fileParallelism: false, maxWorkers: 1, testTimeout: 12_000 } }
