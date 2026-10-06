// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { AttentionRequestPanel } from '../src/renderer/src/components/AttentionRequestPanel.js'
import { RuntimeController } from '../src/main/runtime-controller.js'
import { useAppStore } from '../src/renderer/src/store.js'
import { api } from '../src/renderer/src/lib/api.js'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture.js'
import { connectedClient, permission, AGENT_SESSION_ID, RUN_ID } from '../../../packages/core/test/fixtures/interaction-client.js'
import type { AgentMuxInteractionOperationIntent } from '@agentmux/core'

vi.mock('electron', () => ({ app: {}, nativeImage: {} }))

const dom = composerDOM()
const resources: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of resources.splice(0).reverse()) await close() })
async function fixture() {
  const request = permission('desktop-original')
  const h = await connectedClient(request); resources.push(() => h.client.dispose())
  const session = { ...composerSession(AGENT_SESSION_ID), pendingInteraction: request,
    control: { kind: 'agent' as const, hostId: 'local', agentSessionId: AGENT_SESSION_ID, run: { runId: RUN_ID } } }
  useAppStore.setState({ sessions: [session], agentSteerQueues: {}, agentComposerDrafts: { [AGENT_SESSION_ID]: 'Retain this draft' } })
  // The configured host is the test seam; actual lifecycle tracking and response forwarding stay real.
  const runtime = Object.create(RuntimeController.prototype) as RuntimeController
  Object.assign(runtime, { hostReconfigurationReservations: new Map(), hostLifecycleOperations: new Map(), configuredClient: () => h.client })
  const inspect = vi.spyOn(api.sessions, 'inspectInteraction').mockImplementation((control, operationId) => runtime.inspectInteraction(control, operationId))
  const respond = vi.spyOn(api.sessions, 'respondInteraction').mockImplementation((control, response, intent) => runtime.respondInteraction(control, response, intent))
  await dom.render(createElement(AttentionRequestPanel, { sessionId: AGENT_SESSION_ID, onClose: () => {} }))
  const button = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent?.trim() === 'Reject')!
  expect(button).toBeTruthy()
  return { ...h, request, runtime, respond, inspect, button }
}

it('the original Desktop request card reaches the same Core operation owner with its displayed request', async () => {
  const h = await fixture()
  await act(async () => h.button.click())
  expect(h.respond).toHaveBeenCalledOnce()
  const intent = h.respond.mock.calls[0]![2]
  expect(intent).toEqual({ operationId: expect.any(String), expectedRequest: h.request })
  expect(await h.client.inspectAgentInteractionOperation({ agentSessionId: AGENT_SESSION_ID, operationId: intent.operationId }))
    .toMatchObject({ delivery: 'bytes-accepted', nativeAdoption: 'unknown' })
  expect(h.writes).toEqual(['\u001b'])
  expect(dom.container.textContent).toContain('Waiting for confirmation')
  expect(useAppStore.getState().agentComposerDrafts[AGENT_SESSION_ID]).toBe('Retain this draft')
})

it('a lost IPC response queries the same operation instead of submitting another answer', async () => {
  const h = await fixture()
  let submitted: AgentMuxInteractionOperationIntent | undefined
  h.respond.mockImplementation(async (control, response, intent) => {
    submitted = intent
    await h.runtime.respondInteraction(control, response, intent)
    throw new Error('IPC receipt lost')
  })
  await act(async () => h.button.click())
  expect(h.inspect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ agentSessionId: AGENT_SESSION_ID }), submitted!.operationId)
  expect(h.writes).toHaveLength(1)
  expect(dom.container.textContent).not.toContain('IPC receipt lost')
  await act(async () => h.button.click())
  expect(h.respond).toHaveBeenCalledOnce()
})

it('unknown input keeps the original question and reports an unknown receipt without replay', async () => {
  const h = await fixture()
  const input = vi.fn(async () => { throw new Error('Input receipt lost') }); h.state.kernel.input = input
  await act(async () => h.button.click())
  expect(input).toHaveBeenCalledOnce()
  expect(h.inspect).toHaveBeenCalledOnce()
  expect(dom.container.textContent).toContain('Delivery unknown')
  const check = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Check original response')!
  expect(check).toBeTruthy()
  await act(async () => check.click())
  expect(h.inspect).toHaveBeenCalledTimes(2)
  expect(h.client.agentSession(AGENT_SESSION_ID).pendingInteraction?.request.id).toBe(h.request.id)
  await act(async () => h.button.click())
  expect(input).toHaveBeenCalledOnce()
})
