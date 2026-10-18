// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { ConnectorDeliveryDetails } from '../src/renderer/src/components/ConnectorDeliveryDetails'
import { ConnectorBindingNotices } from '../src/renderer/src/components/ConnectorBindingNotices'
import { api } from '../src/renderer/src/lib/api'
import { groupTarget } from '../src/renderer/src/lib/group-diagnosis'
import type { ConnectionDeliveryObservation, RoomBinding } from '@agentmux/core/connections'

const binding = { bindingId: 'binding', revision: 1, state: 'active', connectionId: 'connection', application: { domain: 'chat.example', appId: 'app' },
  executionHostId: 'local', agentSessionId: 'agent', externalConversationId: 'group', sourceCheckpoints: [],
  scope: { input: 'mentions-and-replies', publication: 'future-shared-conversation' } } as RoomBinding
let root: Root | undefined, host: HTMLDivElement | undefined
afterEach(async () => { if (root) await act(async () => root!.unmount()); host?.remove(); root = undefined; vi.restoreAllMocks() })
async function render(value: React.ReactNode) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(async () => root!.render(value)) }
async function ready(text: string) { await vi.waitFor(async () => { await act(async () => {}); expect(host?.textContent).toContain(text) }) }

it('shows the exact recorded message separately from Agent submission and refuses to call a connection notice a conversation delivery', async () => {
  const call = vi.spyOn(api.connections, 'call').mockImplementation(async (method, input) => {
    if (method !== 'connection.diagnose') throw Error('Only original local diagnosis expected')
    return { target: input, service: { value: { enabled: true, revision: 1 }, issue: null }, groups: { value: { nextBindingId: null, items: [{ target: groupTarget(binding), window: {}, limit: 5,
      connection: { value: null, issue: null }, binding: { value: { ...binding, currentRevision: 1, activeInputGrants: 0, activeAnswerGrants: 0, activePermissionGrants: 0 }, issue: null },
      outgoing: { value: { after: null, afterContent: null, next: null, deliveries: [{ kind: 'binding-notice', operationId: 'notice', state: 'confirmed', receipt: 'confirmed', platformMessageId: 'notice-message', reason: null, resourceUpload: null }], observation: { state: 'ready' }, coverage: null }, issue: null },
      incoming: { value: { beforeIngressId: null, next: null, rows: [{ ingressId: 'ingress', sourceConnectionId: 'connection', kind: 'message', state: 'refused', code: 'INGRESS_ACTOR_NOT_AUTHORIZED', codeRecorded: true,
        bindingId: 'binding', bindingRevision: 1, targetConnectionId: 'connection', scope: 'current-binding', inputOperationId: null, recording: { state: 'recorded' }, coreStatus: null, coreObservation: 'not-started', nativeAdoption: null, waiting: null }] }, issue: null }
    }] }, issue: null } } as never
  })
  await render(<ConnectorDeliveryDetails binding={binding} />)
  await ready('Message saved in this conversation.')
  await ready('Not sent to the Agent. This member has no request access.')
  expect(host?.textContent).not.toContain('Delivery confirmed in this window')
  expect(host?.textContent).toContain('No new delivery receipt recorded')
  expect(call.mock.calls.every(([method]) => method === 'connection.diagnose')).toBe(true)
})

it('retains the applied disconnect when its original notice is unknown and inspects without sending again', async () => {
  const detached = { ...binding, state: 'detached' as const, revision: 2 }
  const call = vi.spyOn(api.connections, 'call').mockResolvedValue({ delivery: { operationId: 'end-notice', bindingId: 'binding', bindingRevision: 2,
    reference: { hostId: 'local', agentSessionId: 'agent', source: { kind: 'binding-operation', operationId: 'detach', event: 'disconnected' } }, target: { connectionId: 'connection', application: binding.application, externalConversationId: 'group' }, state: 'unknown', receipt: { state: 'unknown', reason: 'effect-unconfirmed' } } } as never)
  await render(<ConnectorBindingNotices operation={{ operationId: 'detach', action: 'detach', state: 'applied', binding: detached, notices: [{ event: 'disconnected', deliveryOperationId: 'end-notice' }] }} />)
  await ready('Delivery is not confirmed. The connection change is saved.')
  expect(host?.textContent).toContain('Disconnection notice')
  const check = [...host!.querySelectorAll('button')].find(button => button.textContent === 'Check notice')!
  await act(async () => check.click())
  await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2))
  expect(call.mock.calls).toEqual([['connection.delivery.inspect', { operationId: 'end-notice' }], ['connection.delivery.inspect', { operationId: 'end-notice' }]])
})

it.each([
  { state: 'unknown', reason: 'effect-unconfirmed' },
  { state: 'unavailable', reason: 'effect-unconfirmed' },
  { state: 'unavailable', reason: 'source-gap' },
  { state: 'unavailable', reason: 'content-unconfirmed' }
] satisfies ConnectionDeliveryObservation[])('distinguishes $reason/$state from each original platform receipt in the mounted disclosure', async observation => {
  const effect = observation.reason === 'effect-unconfirmed'
  const deliveries = [
    { kind: 'conversation', operationId: 'confirmed-original', state: 'confirmed', receipt: 'confirmed', platformMessageId: 'confirmed-message', reason: null, resourceUpload: null },
    { kind: 'conversation', operationId: 'unknown-original', state: 'unknown', receipt: 'unknown', platformMessageId: null, reason: 'effect-unconfirmed', resourceUpload: null }
  ]
  // The aggregate observation cannot replace either original receipt. Exercise both first-row summaries.
  if (!effect) deliveries.reverse()
  const call = vi.spyOn(api.connections, 'call').mockImplementation(async (method, input) => {
    if (method !== 'connection.diagnose') throw Error('Reading the disclosure must not resend an effect')
    return { target: input, service: { value: { enabled: true, revision: 1 }, issue: null }, groups: { value: { nextBindingId: null, items: [{
      target: groupTarget(binding), window: {}, limit: 5, connection: { value: null, issue: null }, binding: { value: null, issue: null },
      outgoing: { value: { after: null, afterContent: null, next: null, deliveries, observation, coverage: null }, issue: null },
      incoming: { value: { beforeIngressId: null, next: null, rows: [] }, issue: null }
    }] }, issue: null } } as never
  })
  await render(<ConnectorDeliveryDetails binding={binding} />)
  await ready(effect ? 'Delivery confirmed in this window' : 'Delivery not confirmed. Check the original receipt below.')
  await act(async () => host!.querySelector('summary')!.click())
  expect(host!.querySelector('details')!.open).toBe(true)
  const detail = host!.querySelector('details')!.textContent!
  if (effect) {
    expect(detail).toContain('Platform request observation: ' + observation.state)
    expect(detail).toContain('Some original platform request results are unconfirmed. Each request has its own receipt below. Unconfirmed requests are not sent again.')
    expect(detail).not.toContain('Source observation:')
    expect(detail).not.toContain('This describes local source reading')
  } else {
    expect(detail).toContain('Source observation: ' + observation.state + ' · ' + observation.reason)
    expect(detail).toContain('This describes local source reading, not platform delivery.')
    expect(detail).not.toContain('Platform request observation:')
  }
  const rows = [...host!.querySelectorAll('.agent-connector-receipt')]
  expect(rows.find(row => row.textContent!.includes('confirmed-original'))!.textContent).toContain('Platform receipt: confirmed')
  expect(rows.find(row => row.textContent!.includes('unknown-original'))!.textContent).toContain('Platform receipt: unknown')
  await act(async () => [...host!.querySelectorAll('button')].find(button => button.textContent === 'Check group activity')!.click())
  expect(call.mock.calls.map(([method]) => method)).toEqual(['connection.diagnose', 'connection.diagnose'])
})
