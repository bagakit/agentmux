import { resolve } from 'node:path'
import { defineConfig, defaultExclude } from 'vitest/config'
import owning from '../../../vitest.config'
const root = resolve(import.meta.dirname, '../../..')
const mutations: Record<string, { file: string; before: string; after: string }> = {
  'working-gate': { file: 'packages/core/src/agent-session-recovery/continuity.ts', before: "status.state === 'working'", after: "status.state === 'done'" },
  'unknown-missing': { file: "packages/core/src/agent-session-recovery/service.ts", before: "if (!(error instanceof AgentMuxError && error.code === 'CTXMUX_run_not_found')) {", after: "if (false) {" },
  'expected-run': { file: "packages/core/src/agent-session-recovery/service.ts", before: "if (current && !sameRun(current.run, input.expectedRun)) {", after: "if (false) {" },
  'healthy-resume': { file: 'packages/core/src/agent-session-recovery/continuity.ts', before: "if (facts.run?.state === 'running') {", after: 'if (false) {' },
  'atomic-receipt': { file: "packages/core/src/agent-session-recovery/service.ts", before: "if (continuity?.operationId === input.operationId && continuity.kind === 'starting') {", after: "if (false) {" },
  'committed-health': { file: 'packages/core/src/agent-session-recovery/service.ts', before: "if (reservation.kind === 'resume' && continuity?.operationId === input.operationId) {", after: 'if (false) {' },
  'parked-rejoin': { file: "packages/core/src/agent-session-recovery/service.ts", before: "['active-delay', 'operation-unconfirmed'].includes(current.continuity.reason)", after: "true" },
  'ended-fresh-input': { file: 'apps/desktop/src/renderer/src/store.ts', before: "entry.promptCondition === null && session.processState === 'running' && !session.pendingInteraction)", after: 'entry.promptCondition === null && !session.pendingInteraction)' },
  'startup-trigger': { file: 'apps/desktop/src/renderer/src/store.ts', before: "{ stillCurrent: current, trigger: 'startup' }", after: "{ stillCurrent: current, trigger: 'manual' }" }
}
const mutation = process.env.AGENTMUX_CONTINUITY_MUTATION ? mutations[process.env.AGENTMUX_CONTINUITY_MUTATION] : undefined
if (process.env.AGENTMUX_CONTINUITY_MUTATION && !mutation) throw new Error('Unknown continuity mutation')
export default defineConfig({ ...owning, root,
  plugins: mutation ? [{ name: 'loaded-continuity-mutation', enforce: 'pre', transform(code, id) {
    if (id.split('?')[0] !== resolve(root, mutation.file)) return
    if (code.split(mutation.before).length !== 2) throw new Error('Mutation target must match the actual owner exactly once')
    return { code: code.replace(mutation.before, mutation.after), map: null }
  } }] : [],
  test: { ...owning.test, exclude: defaultExclude,
    include: ['packages/core/test/agent-session-continuity.test.ts', 'apps/desktop/test/session-continuity-consumers.test.ts'],
    passWithNoTests: false, maxWorkers: 1 }
})
