// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { ConnectorDeliveryDetails } from '../src/renderer/src/components/ConnectorDeliveryDetails'
import { ConnectorBindingNotices } from '../src/renderer/src/components/ConnectorBindingNotices'
import { api } from '../src/renderer/src/lib/api'
import { groupTarget } from '../src/renderer/src/lib/group-diagnosis'
import type { RoomBinding } from '@agentmux/core/connections'

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
  expect(host?.textContent).toContain('Your Agent keeps running')
  const check = [...host!.querySelectorAll('button')].find(button => button.textContent === 'Check notice')!
  await act(async () => check.click())
  await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2))
  expect(call.mock.calls).toEqual([['connection.delivery.inspect', { operationId: 'end-notice' }], ['connection.delivery.inspect', { operationId: 'end-notice' }]])
})
