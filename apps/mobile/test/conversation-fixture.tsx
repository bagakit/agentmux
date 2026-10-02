import { fixturePath } from '../../../test/fixture-values.mjs'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { expect, vi } from 'vitest'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxAgentSession, AgentMuxClientEvent, AgentSessionHistoryObservation, AgentSessionHistoryPage, AgentTimelineSnapshot } from '@agentmux/core'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
export const evidence = { source: 'native-hook' as const, observedAt: 1, run: { runId: 'run-original' } }
export function session(id = 'session-original'): AgentMuxAgentSession {
  return { kind: 'agent', agentSessionId: id, providerId: 'codex', executorId: 'local', hostId: 'host-original',
    workspacePath: fixturePath("workspace"), run: { runId: id === 'session-original' ? 'run-original' : `run-${id}` },
    retiredRuns: [], createdAt: 1, updatedAt: 1 }
}
export function history(id = 'session-original'): AgentSessionHistoryPage {
  return { agentSessionId: id, source: { providerId: 'codex', nativeSessionId: `native-${id}` }, nextCursor: 'older-opaque',
    items: [
      { id: 'native-input', kind: 'user-message', startedAt: 900, contentParts: [{ kind: 'text', text: '原生输入 [文档](https://example.test/docs)' }] },
      { id: 'native-answer', kind: 'assistant-message', startedAt: 100, contentParts: [{ kind: 'text', text: '原生回答' }] }
    ] }
}
export function fixture() {
  const sessions = new Map([['session-original', session()], ['other', session('other')], ['peer', session('peer')]])
  let page = history(), timeline: AgentTimelineSnapshot = { agentSessionId: 'session-original', revision: 1, items: [] }
  const listeners = new Set<(event: AgentMuxClientEvent) => void>()
  const observers = new Set<(observation: AgentSessionHistoryObservation) => void>()
  const disposeHistory = vi.fn(), unsubscribe = vi.fn()
  const submit = vi.fn<AgentMuxHostedClient['submitAgentPrompt']>().mockResolvedValue()
  const respond = vi.fn<AgentMuxHostedClient['respondAgentInteraction']>().mockResolvedValue()
  const readHistory = vi.fn<AgentMuxHostedClient['sessionHistoryPage']>(async id => page.agentSessionId === id ? page : history(id))
  const readTimeline = vi.fn<AgentMuxHostedClient['sessionTimeline']>(async id => timeline.agentSessionId === id
    ? timeline : { agentSessionId: id, revision: 0, items: [] })
  // The fake is confined to tests; every product read/write goes through the public SDK method.
  const client = {
    agentSession: (id: string) => { const value = sessions.get(id); if (!value) throw new Error('unknown Session'); return value },
    agentSessions: () => [...sessions.values()],
    onEvent(listener: (event: AgentMuxClientEvent) => void) { listeners.add(listener); return () => { listeners.delete(listener); unsubscribe() } },
    observeSessionHistory: vi.fn<AgentMuxHostedClient['observeSessionHistory']>(async (id, listener) => {
      observers.add(listener)
      return { source: history(id).source, dispose() { observers.delete(listener); disposeHistory() } }
    }),
    sessionHistoryPage: readHistory, sessionTimeline: readTimeline, submitAgentPrompt: submit, respondAgentInteraction: respond
  } as unknown as AgentMuxHostedClient
  return { client, sessions, submit, respond, readHistory, readTimeline, disposeHistory, unsubscribe,
    setPage(value: AgentSessionHistoryPage) { page = value },
    setTimeline(value: AgentTimelineSnapshot) { timeline = value },
    emit(event: AgentMuxClientEvent) { for (const listener of listeners) listener(event) },
    observe(observation: AgentSessionHistoryObservation) { for (const listener of observers) listener(observation) }
  }
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
export function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
