import type { AgentInputSubmissionReceipt } from '@agentmux/core'
import type { ConnectionDelivery } from '@agentmux/core/connections'
import { deliveryFacts } from '@agentmux/core/connections'
import { api } from '../../../src/renderer/src/lib/api'
import { channelFixture } from './facts'
const { proof, connection, target } = channelFixture
const scene = { active: false, mode: 'busy' as 'busy' | 'ready' | 'waiting' | 'admitted', bindingId: '', revision: 1, room: '', longName: false }
Object.assign(proof, { diagnosis: scene })
const oldOperation = 'preview-original-older-result', before = 'preview-before-older-results'
function receipt(): AgentInputSubmissionReceipt {
  const key = { kind: 'message' as const, agentSessionId: target.agentSessionId, expectedRun: { runId: 'preview-original-run' }, messageId: 'preview-original-message' }, ref = { key, waitGeneration: 1 }
  return { key, ref, originalControlOperationId: 'preview-original-agent-input', persistence: 'confirmed', status: 'waiting', observation: 'rejoin-needed', admission: null,
    control: { ref, state: 'enabled', at: 1, waiting: { phase: 'input-environment', reason: 'original-input-unconfirmed', wake: 'explicit-rejoin', failure: { name: 'AgentMuxError', message: 'Controlled original input environment observation' } } } }
}
function delivery(id = oldOperation, unknown = true): ConnectionDelivery {
  return { operationId: id, projectionId: id + '-projection', sourceRevision: 'preview-original-version', bindingId: scene.bindingId, bindingRevision: scene.revision,
    reference: { hostId: target.executionHostId, agentSessionId: target.agentSessionId, source: { kind: 'native', providerId: 'fixture', nativeSessionId: 'original-native', recordId: id } },
    target: { connectionId: connection.config.connectionId, application: connection.config.application, externalConversationId: scene.room }, effect: 'upsert', fragment: { ordinal: 0, count: 1 },
    state: unknown ? 'unknown' : 'confirmed', ...(unknown ? { reason: 'effect-unconfirmed', receipt: { state: 'unknown', reason: 'effect-unconfirmed' } } : { mapping: { messageId: id + '-platform' }, receipt: { state: 'confirmed', mapping: { messageId: id + '-platform' } } }) }
}
const original = api.connections.call
api.connections.call = (async (method: any, input: any, owner: any) => {
  if (method === 'connection.delivery.inspect') { proof.calls.push(method); proof.requests.push({ method, input: structuredClone(input), owner: structuredClone(owner) }); return { delivery: delivery(input.operationId) } }
  if (method === 'connection.ingress.inspect') {
    proof.calls.push(method); proof.requests.push({ method, input: structuredClone(input), owner: structuredClone(owner) })
    const inputReceipt = receipt()
    return { ingress: { kind: 'message', ingressId: input.ingressId, application: connection.config.application, externalConversationId: scene.room,
      input: { operationId: inputReceipt.originalControlOperationId, hostId: target.executionHostId, agentSessionId: target.agentSessionId, expectedRun: inputReceipt.key.expectedRun, messageId: 'preview-original-message', author: { bindingId: scene.bindingId, bindingRevision: scene.revision, connectionId: connection.config.connectionId } } }, inputReceipt, observation: 'observed' }
  }
  const result: any = await original(method, input, owner)
  if (method === 'connection.metadata.get' && input.subject?.kind === 'conversation' && scene.longName && result.entry?.observation?.profile) result.entry.observation.profile.name = 'Research and Engineering · Customer investigation and release planning'
  if (method === 'connection.diagnose') for (const group of result.groups.value?.items ?? []) {
    scene.bindingId = group.target.bindingId; scene.revision = group.target.publicationRevision; scene.room = group.target.externalConversationId
    if (!scene.active) continue
    group.connection.value = { ...group.connection.value, receiver: { ref: 'preview-original-receiver', state: 'ready' }, transport: { state: 'ready' }, authentication: { state: 'ready' }, intake: { state: 'unknown', reason: 'check-failed' } }
    const out = group.outgoing.value
    out.sourceObservation = scene.mode === 'busy' || scene.mode === 'waiting' ? { state: 'unavailable', reason: 'source-gap', code: scene.mode === 'busy' ? 'AGENT_SESSION_HISTORY_BUSY' : 'AGENT_SESSION_HISTORY_TIMEOUT', codeRecorded: true, checkpointKey: 'a'.repeat(64) } : { state: 'ready', code: null, codeRecorded: false, checkpointKey: 'a'.repeat(64) }
    out.observation = { state: 'unavailable', reason: 'content-unconfirmed' }; out.effectObservation = { state: 'unknown', reason: 'effect-unconfirmed' }
    out.coverage = { state: 'incomplete', nextContent: null, gaps: [{ gapKey: 'b'.repeat(64), reason: 'public-content-unconfirmed', code: null, codeRecorded: false, sourceKind: null, association: { sourceKey: null, recordKey: null, eventKey: null, partKey: null } }], omittedGapCount: 0, originCount: 0 }
    out.deliveries = input.after === before ? [deliveryFacts(delivery())] : Array.from({ length: 5 }, (_, index) => index < 3 ? deliveryFacts(delivery('preview-current-' + index, false)) : { ...deliveryFacts(delivery('preview-superseded-' + index, false)), state: 'superseded', receipt: null, platformMessageId: null })
    out.next = input.after === before ? null : before
    group.incoming.value.rows = [{ ingressId: 'preview-original-intake', sourceConnectionId: connection.config.connectionId, kind: 'message', state: 'claimed', code: null, codeRecorded: false,
      bindingId: group.target.bindingId, bindingRevision: group.target.bindingRevision, targetConnectionId: connection.config.connectionId, scope: 'current-binding', inputOperationId: 'preview-original-agent-input', recording: { state: 'recorded' }, coreStatus: scene.mode === 'waiting' ? 'waiting' : scene.mode === 'admitted' ? 'admitted' : 'terminal-confirmed', coreObservation: 'observed', nativeAdoption: null, waiting: scene.mode === 'waiting' ? receipt().control.waiting : null }]
  }
  return result
}) as typeof api.connections.call
api.sessions.inspectInput = async () => receipt()
await import('./entry')
