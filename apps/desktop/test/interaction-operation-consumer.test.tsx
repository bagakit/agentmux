// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { AttentionRequestPanel } from '../src/renderer/src/components/AttentionRequestPanel.js'
import { RuntimeController } from '../src/main/runtime-controller.js'
import { useAppStore } from '../src/renderer/src/store.js'
import { api } from '../src/renderer/src/lib/api.js'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture.js'
import { interactionOperationHook, OPERATION_SESSION_ID as AGENT_SESSION_ID, OPERATION_RUN_ID as RUN_ID } from '../../../packages/core/test/fixtures/interaction-operation-hook.js'
import type { AgentMuxInteractionOperationIntent } from '@agentmux/core'

vi.mock('electron', () => ({ app: {}, nativeImage: {} }))

const dom = composerDOM()
const resources: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of resources.splice(0).reverse()) await close() })
async function fixture() {
  const h = await interactionOperationHook('desktop-original'); resources.push(h.close)
  const request = h.request
  const session = { ...composerSession(AGENT_SESSION_ID), pendingInteraction: request,
    control: { kind: 'agent' as const, hostId: 'local', agentSessionId: AGENT_SESSION_ID, run: { runId: RUN_ID } } }
  useAppStore.setState({ sessions: [session], agentSteerQueues: {}, agentComposerDrafts: { [AGENT_SESSION_ID]: 'Retain this draft' } })
  // The configured host is the test seam; actual lifecycle tracking and response forwarding stay real.
  const runtime = Object.create(RuntimeController.prototype) as RuntimeController
  Object.assign(runtime, { hostReconfigurationReservations: new Map(), hostOperations: new Map(), configuredClient: () => h.client })
  const inspect = vi.spyOn(api.sessions, 'inspectInteraction').mockImplementation((control, operationId) => runtime.inspectInteraction(control, operationId))
  const respond = vi.spyOn(api.sessions, 'respondInteraction').mockImplementation((control, response, intent) => runtime.respondInteraction(control, response, intent))
  const submit = vi.spyOn(useAppStore.getState(), 'respondInteraction')
  await dom.render(createElement(AttentionRequestPanel, { sessionId: AGENT_SESSION_ID, onClose: () => {} }))
  const rejectLabel = request.options.find(option => option.id === 'reject-once')!.label
  const button = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent?.trim() === rejectLabel)!
  expect(button).toBeTruthy()
  return { ...h, request, runtime, respond, inspect, submit, button }
}

it('the original Desktop request card reaches the same Core operation owner with its displayed request', async () => {
  const h = await fixture()
  await act(async () => { h.button.click(); await h.submit.mock.results[0]!.value })
  expect(h.respond).toHaveBeenCalledOnce()
  const intent = h.respond.mock.calls[0]![2]
  expect(intent).toEqual({ operationId: expect.any(String), expectedRequest: h.request })
  expect(await h.client.inspectAgentInteractionOperation({ agentSessionId: AGENT_SESSION_ID, operationId: intent.operationId }))
    .toMatchObject({ delivery: 'hook-written', nativeAdoption: 'unknown' })
  expect(await h.callback).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'deny' } } })
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
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
  await act(async () => { h.button.click(); await h.submit.mock.results[0]!.value })
  expect(h.inspect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ agentSessionId: AGENT_SESSION_ID }), submitted!.operationId)
  expect(await h.callback).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'deny' } } })
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
  expect(dom.container.textContent).not.toContain('IPC receipt lost')
  await act(async () => h.button.click())
  expect(h.respond).toHaveBeenCalledOnce()
})

it('an unknown callback keeps the original question and reports its receipt without replay', async () => {
  const h = await fixture()
  const original = h.server.respondPermission.bind(h.server)
  const dispatch = vi.spyOn(h.server, 'respondPermission').mockImplementation(async (...args) => { await original(...args); throw new Error('Hook receipt lost') })
  await act(async () => { h.button.click(); await h.submit.mock.results[0]!.value })
  expect(dispatch).toHaveBeenCalledOnce()
  expect(await h.callback).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'deny' } } })
  expect(h.inspect).toHaveBeenCalledOnce()
  expect(dom.container.textContent).toContain('Delivery unknown')
  const check = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Check original response')!
  expect(check).toBeTruthy()
  await act(async () => { check.click(); await h.inspect.mock.results.at(-1)!.value })
  expect(h.inspect).toHaveBeenCalledTimes(2)
  expect(h.client.agentSession(AGENT_SESSION_ID).pendingInteraction?.request.id).toBe(h.request.id)
  await act(async () => h.button.click())
  expect(dispatch).toHaveBeenCalledOnce()
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
})
