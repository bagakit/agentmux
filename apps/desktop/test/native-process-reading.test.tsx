import { fixtureCivil as _hygiene_fixtureCivil, fixtureData as _hygiene_fixtureData, fixtureYear as _hygiene_fixtureYear } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryPage } from '@agentmux/core'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { ConversationView } from '@agentmux/client-ui/components/ConversationView'
import { NativeProcessObservation } from '@agentmux/client-ui/components/NativeProcessObservation'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import type { ConversationAnnotationSelection } from '@agentmux/client-ui/conversation-annotation'
import relativeFixture_fixture from './fixtures/native-process-public-pages.json'
const fixture = _hygiene_fixtureData(relativeFixture_fixture)

// Produced by the registered public Codex reader + private FileStore, using
// official record shapes over controlled readonly stdio; not a vendor Writer.
const current: AgentSessionHistoryPage = fixture.current as AgentSessionHistoryPage
let root: Root, host: HTMLDivElement
let readGroups: Set<string>
const initial = useAppStore.getState()
const flush = async () => { await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }) }
async function show(page = current): Promise<void> {
  await act(async () => root.render(<ActivityView capability="complete-events" items={[]} userMessages={[]}
    sessionId={page.agentSessionId} nativeHistoryPage={page} />))
  await flush()
  for (const head of host.querySelectorAll<HTMLButtonElement>('.conversation-native-thread .wf-head')) {
    const id = head.closest<HTMLElement>('[data-observation-id]')!.dataset.observationId!
    if (readGroups.has(id)) continue
    readGroups.add(id)
    if (head.getAttribute('aria-expanded') === 'false') await act(async () => head.click())
  }
}
function row(id: string): HTMLElement {
  const element = host.querySelector<HTMLElement>(`[data-native-record-id="${id}"]`)
  expect(element).not.toBeNull()
  return element!
}
async function open(id: string): Promise<HTMLElement> {
  const element = row(id)
  const button = element.querySelector<HTMLButtonElement>('[data-observation-step-id]')!
  expect(button).not.toBeNull()
  await act(async () => button.click())
  expect(button.getAttribute('aria-expanded')).toBe('true')
  return element
}
beforeEach(() => {
  readGroups = new Set()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  useAppStore.setState({ timelines: {} })
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); useAppStore.setState(initial, true) })

it('keeps every raw record in public source order and separates progress from the final reply', async () => {
  await show()
  expect([...host.querySelectorAll<HTMLElement>('[data-native-record-id]')].map(el => el.dataset.nativeRecordId))
    .toEqual(current.items.map(item => item.id))
  expect(row('progress-a').querySelector('.log-turn')?.getAttribute('data-message-phase')).toBe('progress')
  expect(row('progress-a').querySelector('.log-turn')?.hasAttribute('data-message-bubble')).toBe(false)
  expect(row('final-a').querySelector('.log-turn')?.getAttribute('data-message-phase')).toBe('final')
  expect(row('final-a').querySelector('.log-turn')?.getAttribute('data-message-bubble')).toBe('true')
  expect(row('progress-a').querySelector('.log-turn__body')?.textContent).toContain('公开进度说明 exact 中')
})

it('does not deduplicate equal progress and final text or infer phase from words', async () => {
  await show()
  for (const id of ['progress-a', 'final-a', 'progress-b']) {
    expect(row(id).querySelector('.log-turn__body')?.textContent).toContain('公开进度说明 exact 中')
  }
  for (const id of ['missing-phase', 'null-phase', 'future-phase']) {
    expect(row(id).querySelector('.log-turn')?.hasAttribute('data-message-phase')).toBe(false)
    expect(row(id).querySelector('.log-turn')?.getAttribute('data-message-bubble')).toBe('true')
  }
})

it('uses real Workflow observations between speeches without inventing agent totals or phases', async () => {
  await show()
  const cards = host.querySelectorAll('.wf-card--observation')
  expect(cards.length).toBe(2)
  expect(cards[0]?.querySelector('.log-fold__steps')?.textContent).toBe('3 步')
  expect(cards[1]?.querySelector('.log-fold__steps')?.textContent).toBe('5 步')
  expect(host.querySelector('.wf-progress')).toBeNull()
  expect(host.querySelector('[data-workflow-id]')).toBeNull()
  expect(host.textContent).not.toMatch(/tokens|第 1 次/u)
})

it('keeps recorded running separate from target completion and from Streaming', async () => {
  await show()
  const element = await open('collab-call')
  expect(element.querySelector('[data-observation-step-id]')?.getAttribute('data-status')).toBe('running')
  expect(element.textContent).toContain('Recorded running')
  expect(host.querySelector('.wf-streaming-glyph')).toBeNull()
  expect(host.textContent).not.toContain('Streaming')
  const states = [...element.querySelectorAll<HTMLButtonElement>('.wf-agent__button')]
  expect(states.length).toBe(2)
  await act(async () => states[0]!.click())
  expect(element.querySelector('[data-for-recorded-agent]')?.textContent).toContain('Recorded result A')
  expect(element.textContent).toContain('completed')
  expect(element.querySelector('[data-observation-step-id]')?.getAttribute('data-status')).toBe('running')
  expect(element.querySelector('.wf-detail')?.textContent).not.toMatch(/阶段|尝试|tokens/u)
})

it('shows native references and exact prompt without pretending they are AgentMux navigation', async () => {
  await show()
  const element = await open('collab-call')
  const receivers = [...element.querySelectorAll('.wf-native-process__references dd code')].map(el => el.textContent)
  expect(receivers).toEqual(['codex · private-native-main', 'codex · native-worker-b', 'codex · native-worker-a'])
  const item = current.items.find(item => item.id === 'collab-call')!
  expect(item.collaboration?.kind).toBe('operation')
  expect(element.querySelector('.wf-native-process__prompt pre')?.textContent)
    .toBe(item.collaboration?.kind === 'operation' ? item.collaboration.prompt : undefined)
  expect(element.querySelector('a')).toBeNull()
  expect(element.querySelector('[data-agent-session-id]')).toBeNull()
})

it('keeps the complete original collaboration payload and its one message body reachable', async () => {
  await show()
  const element = await open('collab-call')
  const original = element.querySelector<HTMLDetailsElement>('.wf-native-process__raw')!
  expect(original).not.toBeNull(); original.open = true
  const item = current.items.find(item => item.id === 'collab-call')!
  const text = item.contentParts[0]
  expect(text?.kind).toBe('text')
  expect(element.querySelector('.log-turn__text')?.textContent).toBe(text?.kind === 'text' ? text.text : undefined)
  expect(element.querySelectorAll('.log-turn__body').length).toBe(1)
  expect(element.textContent).toContain('complete native payload')
  expect(element.querySelector('[aria-label="Copy message"]')).not.toBeNull()
})

it('keeps agent activity and unknown collaboration honest and readable', async () => {
  await show()
  const activity = await open('agent-activity')
  expect(activity.textContent).toContain('Agent interacted')
  expect(activity.textContent).toContain('root/reviewer')
  expect(activity.querySelector('.wf-native-process__prompt')).toBeNull()
  const unknown = await open('unknown-call')
  expect(unknown.textContent).toContain('Recorded collaboration')
  expect(unknown.textContent).toContain('Status not recorded')
  const button = unknown.querySelector<HTMLButtonElement>('.wf-agent__button')!
  await act(async () => button.click())
  expect(unknown.textContent).toContain('State not recorded')
  expect(unknown.textContent).toContain('Exact unknown-state message')
  expect(unknown.querySelector('.log-turn')?.getAttribute('data-speaker-role')).toBeNull()
})

it('does not borrow another record time for a process whose own time is absent', async () => {
  await show()
  const element = row('collab-call')
  expect(element.querySelector('.log-row__time')).toBeNull()
  expect(element.querySelector('[data-observation-step-id]')?.getAttribute('data-recorded-time')).toBe('false')
  expect(host.querySelector('.wf-card--observation .log-fold__time')).toBeNull()
  expect(row('progress-a').querySelector('.log-turn__time')).not.toBeNull()
})

it('retains the same raw body and Range when the process head is clipped', async () => {
  await show()
  const element = await open('agent-activity')
  element.querySelector<HTMLDetailsElement>('.wf-native-process__raw')!.open = true
  const body = element.querySelector('.log-turn__body')!
  const text = body.querySelector('p')!.firstChild!
  const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 1)
  const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range)
  const oldText = range.toString()
  const page = { ...current, items: current.items.filter(item => item.id !== 'collab-call') }
  await show(page)
  expect(row('agent-activity').querySelector('.log-turn__body')).toBe(body)
  expect(range.startContainer.isConnected).toBe(true)
  expect(selection.toString()).toBe(oldText)
  expect(row('agent-activity').querySelector('.wf-native-process__raw')?.hasAttribute('open')).toBe(true)
})

it('never merges already mounted groups after their intervening speech leaves the window', async () => {
  await show()
  const element = await open('unknown-call')
  const body = element.querySelector('.log-turn__body')!
  const page = { ...current, items: current.items.filter(item => item.kind === 'activity') }
  await show(page)
  expect(row('unknown-call').querySelector('.log-turn__body')).toBe(body)
  expect(host.querySelectorAll('.wf-card--observation').length).toBe(2)
})

it('keeps previously read bodies mounted through record and whole-group disclosure', async () => {
  await show()
  const element = await open('agent-activity')
  const body = element.querySelector('.log-turn__body')!
  const step = element.querySelector<HTMLButtonElement>('[data-observation-step-id]')!
  await act(async () => step.click())
  expect(body.isConnected).toBe(true)
  const card = element.closest('.wf-card--observation')!
  const head = card.querySelector<HTMLButtonElement>('.wf-head')!
  await act(async () => head.click())
  expect(body.isConnected).toBe(true)
  await act(async () => head.click())
  await act(async () => step.click())
  expect(element.querySelector('.log-turn__body')).toBe(body)
})

it('adds no reads or execution calls for rendering, disclosure or an unrelated Store publication', async () => {
  const reads = vi.spyOn(api.sessions, 'historyPage')
  const observe = vi.spyOn(api.sessions, 'observeHistory')
  await show()
  await open('collab-call')
  const body = row('progress-a').querySelector('.log-turn__body')!
  await act(async () => useAppStore.setState({ timelines: {} }))
  expect(row('progress-a').querySelector('.log-turn__body')).toBe(body)
  expect(reads).not.toHaveBeenCalled()
  expect(observe).not.toHaveBeenCalled()
})

it('keeps the expanded target and its body under its native identity after a state snapshot reorder', async () => {
  await show()
  const element = await open('collab-call')
  const first = element.querySelector<HTMLButtonElement>('.wf-agent__button')!
  await act(async () => first.click())
  const detail = element.querySelector<HTMLElement>('.wf-detail')!
  const message = detail.querySelector('pre')!
  expect(message.textContent).toBe('Recorded result A')
  const items = current.items.map(item => item.collaboration?.kind === 'operation' && item.id === 'collab-call'
    ? { ...item, collaboration: { ...item.collaboration, agentStates: [...item.collaboration.agentStates].reverse() } }
    : item)
  await show({ ...current, items })
  expect(message.isConnected).toBe(true)
  expect(message.textContent).toBe('Recorded result A')
  expect(detail.hidden).toBe(false)
  expect([...element.querySelectorAll('.wf-agent__button')].at(-1)).toBe(first)
})

it('formats a multi-day recorded span in the noncompact observation without calling it execution duration', async () => {
  const records = current.items.filter(item => item.id === 'collab-call' || item.id === 'agent-activity')
  expect(records.length).toBe(2)
  const start = new Date(_hygiene_fixtureYear - 1, 2, 1, 1, 30, 0).getTime()
  const page = { ...current, items: records.map((item, index) => ({
    ...item, startedAt: start + index * 48 * 60 * 60 * 1000
  })) }
  await act(async () => root.render(<ConversationView page={page} sessionId={page.agentSessionId}
    renderProcess={props => <NativeProcessObservation {...props} />} />))
  const time = host.querySelector('.wf-card--observation .log-fold__time')!
  expect(time.textContent).toContain(_hygiene_fixtureCivil(3, 1, -1))
  expect(time.textContent).toContain(_hygiene_fixtureCivil(3, 3, -1))
  expect(time.getAttribute('title')).toContain('not execution duration')
})

it('keeps exact progress copy and the shared real text selection annotation', async () => {
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  const annotate = vi.fn<(selection: ConversationAnnotationSelection) => void>()
  await act(async () => root.render(<ActivityView capability="complete-events" items={[]} userMessages={[]}
    sessionId={current.agentSessionId} nativeHistoryPage={current} onSelectAnnotation={annotate} />))
  await flush()
  const element = row('progress-a')
  const button = element.querySelector<HTMLButtonElement>('[aria-label="Copy message"]')!
  await act(async () => button.click()); await flush()
  const textPart = current.items.find(item => item.id === 'progress-a')!.contentParts[0]
  expect(copy).toHaveBeenCalledWith(textPart?.kind === 'text' ? textPart.text : undefined)
  const text = element.querySelector('.log-turn__text p')!.firstChild!
  const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 4)
  const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range)
  await act(async () => element.querySelector('.log-turn__body')!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })))
  expect(annotate).toHaveBeenCalledTimes(1)
  expect(annotate.mock.calls[0]![0].quote).toBe(range.toString())
  expect(annotate.mock.calls[0]![0].range.startContainer).toBe(text)
})
