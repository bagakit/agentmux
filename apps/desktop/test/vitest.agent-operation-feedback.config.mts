import source from './vitest.mote-context.config.mts'
import { defineConfig } from 'vitest/config'
import assert from 'node:assert/strict'
import { relative } from 'node:path'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'

const mutations: Record<string, { file: string; before: string; after: string }> = {
  'wrong-stop-receipt': { file: 'lib/agent-operation-feedback.ts', before: 'receipt.expectedRun.runId !== control.run.runId', after: 'false' },
  'repeat-stop-on-inspect': { file: 'lib/agent-operation-feedback.ts', before: 'await api.sessions.inspectStop(operation.control, operation.operationId)', after: '(await api.sessions.stop(operation.control, operation.operationId), await api.sessions.inspectStop(operation.control, operation.operationId))' },
  'modal-waits-for-stop': { file: 'components/SessionStop.tsx', before: '    setRequest(null)\n    void stopSessionInBackground(request.intent)', after: '    void stopSessionInBackground(request.intent).then(() => setRequest(null))' },
  'missing-card-feedback': { file: 'components/FocusContextRow.tsx', before: "{context.kind === 'agent' && context.control ? <AgentOperationFeedback subject={{ hostId: context.control.hostId, agentSessionId: context.control.agentSessionId }} /> : null}", after: '{null}' },
  'hidden-motion-runs': { file: 'components/AgentOperationFeedback.tsx', before: "visible && decoration.phase === 'pending'", after: "decoration.phase === 'pending'" },
  'takeover-picker-waits': { file: 'lib/session-takeover.ts', before: 'onSubmitted?.(operation)', after: 'void operation' },
  'takeover-partial-spins': { file: 'lib/session-takeover.ts', before: 'settleAgentCreation(operation, report)', after: "updateAgentOperation(operation, { phase: 'pending' })" },
  'fork-menu-stays': { file: 'components/AgentCurrentForkControls.tsx', before: '    submitted()\n    let dispatched = false', after: '    let dispatched = false' },
  'fork-shared-observation-missing': { file: 'components/AgentCurrentForkControls.tsx', before: 'operationKey ? current.agentOperations[operationKey] : undefined', after: 'undefined' }
}
export default defineConfig({ ...source, cacheDir: '.tmp/agent-operation-feedback-vitest',
  plugins: [{ name: 'original-agent-operation-proof', enforce: 'pre', transform(original, id) {
    const mutant = process.env.AGENTMUX_AGENT_OPERATION_MUTANT, spec = mutant ? mutations[mutant] : undefined
    if (!spec || !id.split('?')[0]!.endsWith('/renderer/src/' + spec.file)) return
    assert.equal(original.split(spec.before).length - 1, 1, 'Actual source mutation has one loaded target')
    const code = original.replace(spec.before, spec.after)
    if (process.env.AGENTMUX_AGENT_OPERATION_LOADED) appendFileSync(process.env.AGENTMUX_AGENT_OPERATION_LOADED,
      JSON.stringify({ mutant, file: relative(source.root!, id.split('?')[0]!), source: createHash('sha256').update(original).digest('hex'), loaded: createHash('sha256').update(code).digest('hex') }) + '\n')
    process.stderr.write(`MUTATION_APPLIED=${mutant}\n`)
    return { code, map: null }
  } }],
  test: { ...source.test, setupFiles: [], globalSetup: [], maxWorkers: 1, fileParallelism: false,
    passWithNoTests: false, testTimeout: 25000,
    include: ['apps/desktop/test/agent-operation-feedback.test.tsx', 'apps/desktop/test/session-stop-dialog-operation.test.tsx',
      'apps/desktop/test/focus-stop-agent.test.tsx', 'apps/desktop/test/workspace-agent-close-operation.test.tsx',
      'apps/desktop/test/session-stop-operation-ipc.test.ts', 'apps/desktop/test/session-takeover.test.tsx',
      'apps/desktop/test/current-agent-fork-ui.test.tsx', 'apps/desktop/test/current-fork-direction-contract.test.ts', 'packages/core/test/stop-receipt.test.ts'] } })
