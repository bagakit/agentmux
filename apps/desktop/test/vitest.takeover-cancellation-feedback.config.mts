import { defineConfig } from 'vitest/config'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import assert from 'node:assert/strict'
import source from './vitest.mote-context.config.mts'

const mutations: Record<string, [string, string, string]> = {
  'legacy-remains-on-card': ['AgentOperationFeedback.tsx', '!isRetainedTakeoverRecord(operation) &&', ''],
  'legacy-invents-placement': ['space-agent-control.ts', '!atTarget && !agent?.retirement && !unsavedBeforeDispatch', '!atTarget && !agent?.retirement'],
  'legacy-result-forgotten': ['agent-operation.ts', ' || isRetainedTakeoverRecord(operation) ||', ' ||'],
  'settle-unknown-save': ['agent-operation.ts', "result?.outcome === 'cancelled' && result.diskDurability === 'confirmed'", "result?.outcome === 'cancelled'"],
  'settle-keeps-row': ['AgentOperationFeedback.tsx', "operation.kind !== 'takeover' || !isDurableTakeoverCancellation(operation.cancellation?.result) || operation.cancellation?.settlingFeedback", 'Boolean(operation)'],
  'offscreen-consumes-settlement': ['AgentOperationFeedback.tsx', "if (operation.kind === 'takeover' && operation.cancellation?.settlingFeedback && visibleFeedback.has(agentOperationKey(operation))) return", ''],
  'desktop-owner-unavailable': ['public-rpc-service.ts', "method === 'runtime.owner.identity' && !this.ports.hostedRuntime && this.ports.callOriginalCore", "method === 'runtime.owner.identity' && this.ports.hostedRuntime && this.ports.callOriginalCore"],
  'desktop-cancellation-unavailable': ['public-rpc-service.ts', 'if (this.ports.callOriginalCore) {\n          const result = await this.ports.callOriginalCore<', 'if (false && this.ports.callOriginalCore) {\n          const result = await this.ports.callOriginalCore<'],
  'unknown-write-replayed': ['session-takeover-cancellation.ts', "if (held.cancellation?.dispatch === 'unconfirmed' && !continueOriginal) return inspectTakeoverCancellation(held)", ''],
  'inspection-writes': ['session-takeover-cancellation.ts', 'api.sessions.takeoverCancelInspect(cancellation.input)', 'api.sessions.takeoverCancel(cancellation.input)'],
  'effect-requires-lost-write-ack': ['session-takeover-cancellation.ts', "phase: accepted.outcome === 'cancelled' ? 'cancelled'", "phase: accepted.outcome === 'cancelled' && accepted.diskDurability === 'confirmed' ? 'cancelled'"],
  'save-ack-hidden': ['AgentOperationFeedback.tsx', "cancellation?.result?.outcome !== 'unconfirmed' && cancellation?.result?.diskDurability === 'unconfirmed'", 'false'],
  'cancelled-revived': ['agent-operation-feedback.ts', "held.phase === 'cancelled' || ", ''],
  'restored-cancellation-reset': ['agent-operation.ts', "phase: result?.outcome === 'cancelled' ? 'cancelled' : 'unconfirmed'", "phase: 'unconfirmed'"],
  'discard-original-message': ['session-takeover-cancellation.ts', '...held, cancellation: next,', '...held, message: undefined, cancellation: next,'],
  'weaker-observation-wins': ['session-takeover-cancellation.ts', "const weaker = known && known.outcome !== 'unconfirmed' &&", "const weaker = false && known && known.outcome !== 'unconfirmed' &&"],
  'source-runtime-used': ['session-takeover-cancellation.ts', 'operation.takeoverSource.coreRuntimeId ?? await api.spatial.owner()', 'operation.takeoverSource.expectedRuntimeId ?? await api.spatial.owner()'],
  'checkpoint-blocks-owner': ['session-takeover-cancellation.ts', 'retain(held, pending)\n  try {', 'retain(held, pending)\n  await checkpointAgentOperations()\n  try {'],
  'random-recovery-control': ['session-takeover-cancellation.ts', 'new TextEncoder().encode(request.operationId)', 'new TextEncoder().encode(crypto.randomUUID())'],
  'cancel-recovery-skipped': ['agent-operation-feedback.ts', 'if (await recoverTakeoverCancellation(started) || !stillCurrent()) return', 'if (!stillCurrent()) return'],
  'observed-unknown-forgotten': ['session-takeover-cancellation.ts', "if (result.cancellationAdmission !== 'observed' && result.outcome === 'unconfirmed') return false", "if (result.outcome === 'unconfirmed') return false"],
  'check-blocks-cancel': ['AgentOperationFeedback.tsx', 'disabled={preparingCancel || cancellation?.pending}', 'disabled={checking || preparingCancel || cancellation?.pending}'],
  'owner-failure-hidden': ['AgentOperationFeedback.tsx', '未能确认原工作区。', '未能准备取消请求。'],
  'check-erases-owner-failure': ['AgentOperationFeedback.tsx', 'function check() {\n    setChecking(true)', 'function check() {\n    setCancelIssue(null)\n    setChecking(true)'],
  'legacy-record-clutters-card': ['AgentOperationFeedback.tsx', 'Boolean(takeover && !hasRequest && !cancellation &&', 'Boolean(false && takeover && !hasRequest && !cancellation &&'],
  'legacy-check-hides-result': ['AgentOperationFeedback.tsx', ': recordedCreation ? recordedCreation.initialPrompt', ': false && recordedCreation ? recordedCreation!.initialPrompt'],
  'inspection-renames': ['session-takeover.ts', 'return takeoverReport(result.request.report)', 'return nameTakeover(source, takeoverReport(result.request.report))'],
  'continuation-replaces-control': ['session-takeover-cancellation.ts', 'const cancellation: TakeoverCancellation = held.cancellation ??', 'const cancellation: TakeoverCancellation =']
}
const mutation = process.env.AGENTMUX_TAKEOVER_FEEDBACK_MUTATION
if (mutation) assert.ok(mutations[mutation], 'Known original feedback consumer mutation')
export default defineConfig({ ...source,
  define: { ...source.define, __AGENTMUX_WEB_PREVIEW__: 'false' },
  cacheDir: resolve(source.root!, '.tmp/takeover-cancellation-feedback-cache', mutation ?? 'baseline'),
  plugins: [...source.plugins ?? [], { name: 'actual-takeover-cancellation-consumer', enforce: 'pre', transform(original, id) {
    const path = relative(source.root!, id.split('?')[0]!)
    if (!path.startsWith('apps/desktop/src/') && !path.startsWith('packages/core/src/') && !path.startsWith('apps/host/src/')) return
    let loaded = original
    const change = mutation && mutations[mutation]
    if (change && path.endsWith('/' + change[0])) {
      assert.equal(original.split(change[1]).length - 1, 1, 'One loaded original mutation anchor')
      loaded = original.replace(change[1], change[2])
    }
    if (process.env.AGENTMUX_TAKEOVER_FEEDBACK_LOADED) appendFileSync(process.env.AGENTMUX_TAKEOVER_FEEDBACK_LOADED,
      JSON.stringify({ path, originalSHA256: createHash('sha256').update(original).digest('hex'), loadedSHA256: createHash('sha256').update(loaded).digest('hex'),
        mutation: original === loaded ? null : mutation }) + '\n')
    return loaded === original ? undefined : { code: loaded, map: null }
  } }],
  test: { ...source.test, include: ['apps/desktop/test/takeover-cancellation-feedback.test.tsx'], setupFiles: [], globalSetup: [],
    passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 15000, hookTimeout: 15000 }
})
