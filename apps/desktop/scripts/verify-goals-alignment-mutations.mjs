import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const goals = 'packages/demand/src/goals.ts'
const owner = 'packages/demand/src/demand-store.ts'
const control = 'packages/core/src/control-host.ts'
const store = 'apps/desktop/src/renderer/src/store.ts'
const main = 'apps/desktop/src/main/ipc.ts'
await verifyRendererSourceMutations({
  name: 'goals-alignment-t2-mutations',
  tests: ['packages/demand/test/demand-alignment.test.ts', 'packages/core/test/demand-control.test.ts', 'apps/desktop/test/goals-durable-adapter.test.ts', 'apps/desktop/test/demand-pmo-tab-context.test.ts'],
  sources: [goals, owner, control, store, main],
  mutations: [
    { label: 'empty-standard-confirmed', file: goals, before: 'if (alignment.criteria.length === 0)', after: 'if (false)' },
    { label: 'agent-forgery-ignored', file: goals, before: 'if (!keys.includes(key))', after: 'if (false)' },
    { label: 'stale-goal-confirmed', file: owner, before: 'demand.alignment.revision !== expectedRevision', after: 'false' },
    { label: 'changed-result-accepted', file: owner, before: 'demand.grounding?.submissionId !== expectedSubmissionId', after: 'false' },
    { label: 'unknown-result-accepted', file: goals, before: "if (check.outcome === 'unknown')", after: 'if (false)' },
    { label: 'control-drops-goal-facts', file: control, before: '    ...goalFacts,\n', after: '' },
    { label: 'mapped-mote-task-not-delivered', file: store, before: 'if (!get().send(mappedRegion.sessionId, buildPmoPrompt()))', after: 'if (false)' },
    { label: 'audit-projected-before-receipt', file: store, before: 'const decisionLog: AgentMuxDemandDecision[] = []', after: 'const decisionLog: AgentMuxDemandDecision[] = [...(input.decisionLog ?? [])]' },
    { label: 'reload-keeps-stale-proposal', file: store, before: '  async refreshDemand(id) {\n', after: '  async refreshDemand(id) {\n    return\n' },
    { label: 'main-confirmation-not-persisted', file: main, before: 'await demands.confirmAlignment(id, expectedRevision)', after: 'await demands.get(id)' }
  ]
})
