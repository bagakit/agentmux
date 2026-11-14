import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const leaf = 'packages/core/src/providers/grok-session-status.ts', client = 'packages/core/src/client.ts'
export const grokStatusMutations = {
  'cold-empty-keeps-old-idle': [leaf, [["if (initial && !latest) throw new AgentMuxError('The original native source has no qualified turn boundary.', 'AGENT_NATIVE_STATUS_UNCONFIRMED')", '']]],
  'grant-idle-before-cut-validation': [leaf, [['if (next) latest = next', 'if (next) { latest = next; emit(next) }']]],
  'descriptor-source-race': [leaf, [['BigInt(actual.dev) !== original.stat.dev || BigInt(actual.ino) !== original.stat.ino', 'false']]],
  'missing-provider-wiring': ['packages/core/src/providers/grok.ts', [['    observeSessionStatus: observeGrokSessionStatus,', '']]],
  'missing-original-environment': [client, [["return { ...this.providerLaunch(session, run), ...(env ? { env } : {}), workspacePath: session.workspacePath,", "return { ...this.providerLaunch(session, run), workspacePath: session.workspacePath,"]]],
  'foreign-native-record': [leaf, [["!object(params) || params.sessionId !== nativeSessionId", "!object(params)"]]],
  'foreign-source-generation': [leaf, [["context.nativePromptPredecessor && context.nativePromptPredecessor.sourceId !== sourceId", 'false']]],
  'late-other-turn-end': [leaf, [['if (end && !same || activity &&', 'if (activity &&']]],
  'stop-is-completion': [leaf, [["const end = value.method === '_x.ai/session/update' && kind === 'turn_completed'", "const end = value.method === '_x.ai/session/update' && (kind === 'turn_completed' || kind === 'hook_execution' && update.event_name === 'stop')"], ["if (update.stop_reason !== 'end_turn') return null", "if (kind !== 'hook_execution' && update.stop_reason !== 'end_turn') return null"]]],
  'keep-idle-after-source-loss': [client, [['(!watch || watch.key !== JSON.stringify([session.run.runId, session.nativeHandle]) || watch.unconfirmed)', 'Boolean(watch && (watch.key !== JSON.stringify([session.run.runId, session.nativeHandle]) || watch.unconfirmed))']]],
  'keep-idle-after-unknown': [client, [['watch.unconfirmed = true\n            watch.ingressRecordId', 'watch.unconfirmed = false\n            watch.ingressRecordId']]],
  'older-write-clears-new-ingress': [client, [['if (watch.ingressRecordId === observation.recordId) watch.unconfirmed = false', 'watch.unconfirmed = false']]],
  'renew-retained-clock': [client, [["observedAt: observation.initialSnapshot || observation.state === 'working' ? observation.nativeObservedAt ?? 0 :", "observedAt: observation.state === 'working' ? observation.nativeObservedAt ?? 0 :"]]],
  'forget-predecessor': [leaf, [['if (context.nativePromptPredecessor?.evidenceId === evidence.id) return', 'if (false) return']]],
  'old-run-overwrites-successor': [client, [["if (!this.currentSessionObservation(target) || watch.controller.signal.aborted || this.nativeStatusWatches.get(session.agentSessionId) !== watch ||\n              observation.recordId", "if (watch.controller.signal.aborted || this.nativeStatusWatches.get(session.agentSessionId) !== watch ||\n              observation.recordId"], ["if (!sameRun(current.run, session.run) || current.providerId !== session.providerId || !sameNativeHandle(current.nativeHandle, session.nativeHandle) || this.endedRuns.has(current.run.runId)) return", "if (current.providerId !== session.providerId || !sameNativeHandle(current.nativeHandle, session.nativeHandle) || this.endedRuns.has(current.run.runId)) return"]]],
  'old-end-overwrites-new-hook': [client, [["if (this.hookTurnPhases.get(session.run.runId) === 'in-turn' && savedHook?.nativeTurnId && savedHook.nativeTurnId !== observation.nativeTurnId &&\n                (observation.nativeObservedAt === undefined || observation.nativeObservedAt <= savedHook.observedAt)) return saved", 'if (false) return saved']]]
}
export const grokStatusMutationCases = {
  'cold-empty-keeps-old-idle': '^cold ', 'grant-idle-before-cut-validation': '^a whole native cut',
  'descriptor-source-race': '^a same-size source', 'missing-provider-wiring': '^native final',
  'missing-original-environment': '^native final', 'foreign-native-record': '^a foreign native row',
  'foreign-source-generation': '^same source predecessor', 'late-other-turn-end': '^Stop, mismatched',
  'stop-is-completion': '^Stop, mismatched', 'keep-idle-after-source-loss': '^cold |^a confirmed own idle',
  'keep-idle-after-unknown': '^the generic status lane|^a new working', 'renew-retained-clock': '^native final',
  'forget-predecessor': '^same source predecessor', 'old-run-overwrites-successor': '^original private environment',
  'old-end-overwrites-new-hook': '^a newer original Hook', 'older-write-clears-new-ingress': '^an older completion write'
}
const owners = new Set([client, leaf, 'packages/core/src/native-jsonl-history-reader.ts', 'packages/core/src/providers/grok.ts', 'packages/core/src/providers/grok-native-history.ts',
  'packages/core/src/public-rpc-service.ts', 'apps/host/src/goal-runtime.ts', 'apps/host/src/continuous-progress-loop-manager.ts', 'apps/host/src/continuous-progress-delivery.ts'])
export function instrumentGrokStatus(source, file) {
  if (!owners.has(file)) return source
  const selected = process.env.MOTE_GROK_STATUS_MUTATION
  if (selected && !grokStatusMutations[selected]) throw Error('Unknown Grok status mutation ' + selected)
  const mutation = grokStatusMutations[selected], edits = mutation?.[0] === file ? mutation[1] : []
  let code = source
  for (const [before, after] of edits) {
    if (code.split(before).length !== 2) throw Error('Exactly one current production anchor required: ' + selected)
    code = code.replace(before, after)
  }
  if (process.env.MOTE_GROK_STATUS_LOADED) {
    const sha = value => createHash('sha256').update(value).digest('hex')
    appendFileSync(process.env.MOTE_GROK_STATUS_LOADED, JSON.stringify({ file, originalSHA256: sha(source), loadedSHA256: sha(code),
      mutation: edits.length ? selected : null, editCount: edits.length }) + '\n')
  }
  return code
}
