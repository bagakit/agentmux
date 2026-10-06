import { fixtureEpoch as _liveTailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { fixtureEpoch as _reshape_fixtureEpoch } from "../../../test/fixture-values.mjs"
import { fixturePath } from '../../../test/fixture-values.mjs'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { expect, vi } from 'vitest'
import { AgentProviderRegistry } from '../../../packages/core/src/agent-provider'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentInputSubmissionReceipt, AgentMuxAgentSession, AgentMuxClientEvent, AgentSessionHistoryObservation, AgentSessionHistoryPage, AgentTimelineSnapshot } from '@agentmux/core'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
export const evidence = { source: 'native-hook' as const, observedAt: _reshape_fixtureEpoch(0, 0, 1), run: { runId: 'run-original' } }
export function session(id = 'session-original'): AgentMuxAgentSession {
  return { kind: 'agent', agentSessionId: id, providerId: 'codex', executorId: 'local', hostId: 'host-original',
    workspacePath: fixturePath("workspace"), run: { runId: id === 'session-original' ? 'run-original' : `run-${id}` },
    retiredRuns: [], createdAt: _reshape_fixtureEpoch(0, 0, 1), updatedAt: _reshape_fixtureEpoch(0, 0, 1) }
}
export function history(id = 'session-original'): AgentSessionHistoryPage {
  return { agentSessionId: id, source: { providerId: 'codex', nativeSessionId: `native-${id}` }, nextCursor: 'older-opaque',
    items: [
      { id: 'native-input', kind: 'user-message', startedAt: _reshape_fixtureEpoch(0, 0, 900), contentParts: [{ kind: 'text', text: '原生输入 [文档](https://example.test/docs)' }] },
      { id: 'native-answer', kind: 'assistant-message', startedAt: _reshape_fixtureEpoch(0, 0, 100), contentParts: [{ kind: 'text', text: '原生回答' }] }
    ] }
}
export function fixture() {
  const sessions = new Map([['session-original', session()], ['other', session('other')], ['peer', session('peer')]])
  let page = history(), timeline: AgentTimelineSnapshot = { agentSessionId: 'session-original', revision: 1, items: [] }
  const listeners = new Set<(event: AgentMuxClientEvent) => void>()
  const observers = new Set<(observation: AgentSessionHistoryObservation) => void>()
  const disposeHistory = vi.fn(), unsubscribe = vi.fn()
  const submit = vi.fn<AgentMuxHostedClient['submitAgentPrompt']>().mockImplementation(acceptedPrompt)
  const inspectInput = vi.fn<AgentMuxHostedClient['inspectAgentInput']>().mockResolvedValue(null)
  const rejoinInput = vi.fn<AgentMuxHostedClient['rejoinAgentInputWaiting']>()
  const stopInput = vi.fn<AgentMuxHostedClient['stopAgentInputWaiting']>()
  const respond = vi.fn<AgentMuxHostedClient['respondAgentInteraction']>().mockRejectedValue(new Error('Agent interaction receipt is not configured in this fixture'))
  const readHistory = vi.fn<AgentMuxHostedClient['sessionHistoryPage']>(async id => page.agentSessionId === id ? page : history(id))
  const readTimeline = vi.fn<AgentMuxHostedClient['sessionTimeline']>(async id => timeline.agentSessionId === id
    ? timeline : { agentSessionId: id, revision: 0, items: [] })
  // The fake is confined to tests; every product read/write goes through the public SDK method.
  const client = {
    catalog: () => new AgentProviderRegistry().catalog(),
    runtimeOwnerIdentity: () => ({ runtimeId: 'original-runtime' }),
    agentSession: (id: string) => { const value = sessions.get(id); if (!value) throw new Error('unknown Session'); return value },
    agentSessions: () => [...sessions.values()],
    onEvent(listener: (event: AgentMuxClientEvent) => void) { listeners.add(listener); return () => { listeners.delete(listener); unsubscribe() } },
    observeSessionHistory: vi.fn<AgentMuxHostedClient['observeSessionHistory']>(async (id, listener) => {
      observers.add(listener)
      return { source: history(id).source, dispose() { observers.delete(listener); disposeHistory() } }
    }),
    sessionHistoryPage: readHistory, sessionTimeline: readTimeline, submitAgentPrompt: submit, respondAgentInteraction: respond,
    inspectAgentInput: inspectInput, rejoinAgentInputWaiting: rejoinInput, stopAgentInputWaiting: stopInput
  } as unknown as AgentMuxHostedClient
  return { client, sessions, submit, respond, readHistory, readTimeline, disposeHistory, unsubscribe, inspectInput, rejoinInput, stopInput,
    setPage(value: AgentSessionHistoryPage) { page = value },
    setTimeline(value: AgentTimelineSnapshot) { timeline = value },
    emit(event: AgentMuxClientEvent) { for (const listener of listeners) listener(event) },
    observe(observation: AgentSessionHistoryObservation) { for (const listener of observers) listener(observation) }
  }
}

/** Controlled SDK receipt port, not a real Runtime/Provider or Native acceptance. */
export async function acceptedPrompt(input: Parameters<AgentMuxHostedClient['submitAgentPrompt']>[0]): Promise<AgentInputSubmissionReceipt | void> {
  if (!('admissionIntent' in input) || input.admissionIntent?.kind !== 'manual-actor') return
  if (!input.operationId) throw new Error('The actual caller must provide its original input ID')
  const key = { kind: 'prompt' as const, agentSessionId: input.agentSessionId, expectedRun: input.expectedRun, submissionId: input.operationId }
  const ref = { key, waitGeneration: 1 }, gateId = 'controlled-gate-' + input.operationId
  return { key, ref, persistence: 'confirmed', status: 'terminal-confirmed', observation: 'closed', control: { ref, state: 'dispatch-authorized', gateId, at: _liveTailFixtureEpoch(0, 0, 1) },
    admission: { agentSessionId: input.agentSessionId, run: input.expectedRun, admission: { inputKey: key, inputDispatch: { ref, gateId },
      submissionId: input.operationId, operationId: input.operationId, transport: 'pty', startByte: 0,
      endByte: new TextEncoder().encode(input.prompt + '\r').byteLength, acknowledged: true,
      intent: { run: input.expectedRun, ownerInstanceId: 'controlled-original-owner', prompt: input.prompt, execution: 'immediate',
        admissionIntent: { kind: 'manual-actor', expectedRun: input.expectedRun }, plan: { kind: 'single-phase', data: input.prompt + '\r' },
        message: { userContent: input.prompt, authorHuman: true } } } } }
}
export const mounted: Array<{ root: Root; element: HTMLElement }> = []
export async function mount(content: ReactNode) {
  const element = document.createElement('div'); document.body.appendChild(element)
  const root = createRoot(element); mounted.push({ root, element })
  const render = async (next: ReactNode) => { await act(async () => { root.render(next) }) }
  await render(content)
  return { element, render }
}
export async function click(element: Element) {
  await act(async () => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}
export function button(element: HTMLElement, label: string): HTMLButtonElement {
  const match = [...element.querySelectorAll<HTMLButtonElement>('button')].find(value => value.getAttribute('aria-label') === label || value.textContent?.trim() === label)
  expect(match, `Actual mounted action ${label}`).toBeDefined()
  return match!
}
export function editor(element: HTMLElement): HTMLElement {
  const match = element.querySelector<HTMLElement>('[contenteditable="true"]')
  expect(match, 'The maintained shared editor is editable').not.toBeNull()
  return match!
}
export async function paste(element: HTMLElement, value: string) {
  await act(async () => {
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { items: [], getData: () => value } })
    editor(element).dispatchEvent(event)
  })
}
/** Exercise the existing queue/condition path, rather than an explicit manual Send. */
export async function plainEnter(element: HTMLElement) {
  await act(async () => { editor(element).dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', cancelable: true })) })
}
export function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

/** Directory disclosure is presentation; entering a Session requires its explicit original Tab row. */
export async function openTreeSession(element: HTMLElement): Promise<void> {
  const branch = element.querySelector<HTMLButtonElement>('.mobile-space-row')
  expect(branch, 'Original tree branch').not.toBeNull()
  if (branch!.getAttribute('aria-expanded') !== 'true') await click(branch!)
  const target = element.querySelector<HTMLButtonElement>('.mobile-spatial-tab .mobile-session-list button')
  expect(target, 'Original Tab Session row').not.toBeNull()
  await click(target!)
}
