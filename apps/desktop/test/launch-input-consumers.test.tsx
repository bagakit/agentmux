// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { parseAgentInputSubmissionReceipt } from '../../../packages/core/src/agent-input-receipt-codec.js'
import type { AgentInputSubmissionReceipt } from '@agentmux/core'
import { parseMoteChatDiagnosis, moteChatDiagnosisKey, type MoteChatTarget } from '@agentmux/core/mote-chat'
import { parseConnectionResult } from '@agentmux/core/connections'
import { projectInputReceipt } from '@agentmux/client-ui/input-receipt-projection'
import { MessageDeliveryFailure } from '@agentmux/client-ui/components/MessageDeliveryFailure'
import { presentMessageDeliveryFailure } from '@agentmux/client-ui/message-delivery-presentation'
import { MoteChatActivity } from '../src/renderer/src/components/MoteChatActivity'
import { OriginalInputWaitingControl } from '../src/renderer/src/components/OriginalInputWaitingControl'
import { ComposerOutbox, queuedMessageState } from '../src/renderer/src/components/ComposerOutbox'
import { pendingSteerInput } from '../src/renderer/src/lib/steer-queue-delivery'
import { connectorGroupDiagnostics, connectorGroupSummary } from '../src/renderer/src/lib/connector-group-status'
import type { GroupDiagnosis } from '../src/renderer/src/lib/group-diagnosis'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM } from './helpers/composer-dom-fixture'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'

const dom = composerDOM()
function receipt(): AgentInputSubmissionReceipt {
  const run = { runId: 'original-run' }, key = { kind: 'message', agentSessionId: 'original-session', expectedRun: run, messageId: 'original-message' }
  const ref = { key, waitGeneration: 1 }, gateId = 'original-gate'
  const plan = { kind: 'runtime-launch', lifecycleOperationId: 'original-start', program: 'fixture-cli', argsDigest: 'original-argv',
    nativeTarget: { kind: 'provider', providerId: 'fixture', sessionId: 'original-native' } }
  return parseAgentInputSubmissionReceipt({ key, ref, persistence: 'confirmed', status: 'launch-carried', observation: 'closed',
    control: { ref, state: 'dispatch-authorized', at: 1, gateId }, admission: { agentSessionId: key.agentSessionId, run,
      admission: { inputKey: key, inputDispatch: { ref, gateId }, submissionId: key.messageId, operationId: key.messageId, transport: 'launch', acknowledged: true,
        intent: { run, ownerInstanceId: 'original-owner', prompt: 'Original external message', execution: 'immediate',
          admissionIntent: { kind: 'session-conversation', expectedRun: run }, plan, message: { userContent: 'Original external message', sourceChannel: 'agent-message' } },
        launch: { plan, outcome: 'launch-carried', receipt: { kind: 'runtime-launch', operationId: plan.lifecycleOperationId, run: { runId: 'successor-run' }, observedAt: 2 } } } } })
}

it('keeps the original launch identity and final transport result across later observations', () => {
  const original = receipt(), unknown = structuredClone(original)
  unknown.status = 'unknown'
  const unknownClaim = unknown.admission!.admission!
  if (unknownClaim.transport !== 'launch') throw Error('Expected launch claim')
  unknownClaim.acknowledged = false
  unknownClaim.launch = { plan: unknownClaim.launch.plan, outcome: 'unknown' }
  expect(projectInputReceipt(unknown, original)).toBe(original)
  expect(projectInputReceipt(original, unknown)).toBe(original)
  for (const change of ['plan', 'run'] as const) {
    const changed = structuredClone(original), claim = changed.admission!.admission!
    if (claim.transport !== 'launch' || claim.launch.outcome !== 'launch-carried') throw Error('Expected launch receipt')
    if (change === 'plan') claim.launch.plan = { ...claim.launch.plan, argsDigest: 'replacement-argv' }
    else claim.launch.receipt.run = { runId: 'replacement-run' }
    expect(() => projectInputReceipt(original, changed)).toThrow(expect.objectContaining({ code: 'CONTROL_REQUEST_CONFLICT' }))
  }
  expect(pendingSteerInput({ archived: true, inputReceipt: original })).toBe(false)
})

it('shows the original carrier with read-only controls and never exposes a resend or waiting action', async () => {
  const original = receipt(), inspect = vi.spyOn(api.sessions, 'inspectInput').mockResolvedValue(original)
  const stop = vi.spyOn(api.sessions, 'stopInputWaiting'), rejoin = vi.spyOn(api.sessions, 'rejoinInputWaiting')
  await dom.render(<OriginalInputWaitingControl hostId="original-host" receipt={original} />)
  expect(dom.container.textContent).toContain('恢复启动已携带消息，Agent 是否接收未确认')
  expect(dom.container.querySelector('[data-input-wait-action="stop"]')).toBeNull()
  expect(dom.container.querySelector('[data-input-wait-action="rejoin"]')).toBeNull()
  await dom.click('[data-input-wait-action="check"]')
  expect(inspect).toHaveBeenCalledWith({ kind: 'agent', hostId: 'original-host', agentSessionId: original.key.agentSessionId, run: original.key.expectedRun }, original.key)
  expect(stop).not.toHaveBeenCalled(); expect(rejoin).not.toHaveBeenCalled()
  const retry = vi.fn()
  await dom.render(<MessageDeliveryFailure error={new Error('Earlier reply was lost')} inputReceipt={original} onRetry={retry} copyText={async () => true} />)
  expect(dom.container.textContent).toContain('Agent 是否接收尚未确认')
  expect([...dom.container.querySelectorAll('button')].some(button => button.textContent?.includes('重试'))).toBe(false)
  expect(presentMessageDeliveryFailure({ error: null, inputReceipt: original }).kind).toBe('launch-carried')
  expect(retry).not.toHaveBeenCalled()
})

it('retains the message in the outbox without send or restore-to-pending capability', async () => {
  const original = receipt(), send = vi.fn(), archive = vi.fn()
  const entry = { id: original.key.kind === 'message' ? original.key.messageId : original.key.submissionId,
    text: 'Original external message', status: 'deferred' as const, deliverable: true, inputReceipt: original }
  expect(queuedMessageState(entry).detail).toContain('Agent 是否接收尚未确认')
  await dom.render(<ComposerOutbox queued={[entry]} selectedId={entry.id} onSelect={() => {}} onSend={send} onArchive={archive} />)
  expect(dom.container.querySelector('.composer-outbox__send')).toBeNull()
  await dom.render(<ComposerOutbox queued={[{ ...entry, archived: true }]} selectedId={entry.id} onSelect={() => {}} onSend={send} onArchive={archive} />)
  const restore = dom.container.querySelector<HTMLButtonElement>('[aria-label="恢复为待发"]')!
  expect(restore.disabled).toBe(true)
  await act(async () => restore.click())
  expect(send).not.toHaveBeenCalled(); expect(archive).not.toHaveBeenCalled()
})

it('reads the private-chat diagnosis as launch-carried rather than unknown or Agent acceptance', async () => {
  const target: MoteChatTarget = { spaceId: 'mote', zoneId: 'zone', expectedResource: { hostId: 'local', workspaceId: 'workspace', workspacePath: fixturePath('repo') } }
  const report = parseMoteChatDiagnosis({ targetKey: moteChatDiagnosisKey(target), limit: 5, configuration: null,
    readiness: { state: 'ready', code: null }, service: { enabled: true, revision: 1 }, adapterService: null, connection: null,
    incoming: { rows: [{ key: moteChatDiagnosisKey(target, 'original-intake'), state: 'claimed', code: null, codeRecorded: false, preparation: 'ready',
      input: { status: 'launch-carried', observation: 'observed', controlState: 'dispatch-authorized', receiptObservation: 'closed',
        waiting: null, preparationReason: null, failureCode: null, runtime: null } }], more: false }, publications: [], issues: [] })
  const call = vi.spyOn(api.moteChat, 'call').mockResolvedValue(report)
  await dom.render(<MoteChatActivity target={target} hostingTarget={{ hostId: 'local', runtimeId: 'original-runtime' }} active revision={1} />)
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Message carried by recovery startup'))
  expect(dom.container.textContent).toContain('The Agent has not yet confirmed receiving it')
  expect(dom.container.textContent).not.toContain('Agent received the message')
  expect(dom.container.textContent).not.toContain('Delivery could not be checked')
  expect(call).toHaveBeenCalledTimes(1)
})

it('preserves launch delivery and unknown native adoption in group status consumers', () => {
  const absent = { value: null, issue: 'read-unavailable' as const }
  const fixture: GroupDiagnosis = { target: { executionHostId: 'local', agentSessionId: 'original-session', bindingId: 'binding', bindingRevision: 1,
    publicationRevision: 1, connectionId: 'connection', domain: 'fixture', appId: 'app', externalConversationId: 'conversation' }, window: {}, limit: 5,
    service: absent, adapterService: absent, connection: absent, binding: absent, outgoing: absent,
    incoming: { issue: null, value: { beforeIngressId: null, next: null, rows: [{ ingressId: 'original-intake', sourceConnectionId: 'connection', kind: 'message', state: 'claimed',
      code: null, codeRecorded: false, bindingId: 'binding', bindingRevision: 1, targetConnectionId: 'connection', scope: 'current-binding', inputOperationId: 'original-message',
      recording: { state: 'recorded' }, coreStatus: 'launch-carried', coreObservation: 'observed', nativeAdoption: 'unknown', waiting: null }] } } }
  const { service, ...group } = fixture
  const request = { executionHostId: 'local', agentSessionId: 'original-session', bindingId: 'binding', bindingRevision: 1 }
  const decoded = parseConnectionResult('connection.diagnose', { target: request, service, groups: { value: { items: [group], nextBindingId: null }, issue: null } }, request)
  const report: GroupDiagnosis = { ...decoded.groups.value!.items[0]!, service: decoded.service }
  expect(report.incoming.value!.rows[0]!.coreStatus).toBe('launch-carried')
  const summary = connectorGroupSummary(report)
  expect(summary.incoming.value).toBe('Message carried by recovery startup')
  expect(summary.incoming.detail).toContain('Agent acceptance is unconfirmed')
  expect(connectorGroupDiagnostics({ report, checking: false, checkedAt: 2 }).rows.find(row => row[0] === 'Group → Agent')?.[1]).toContain('Recovery startup carried the message')
  expect(report.incoming.value!.rows[0]!.nativeAdoption).toBe('unknown')
})
