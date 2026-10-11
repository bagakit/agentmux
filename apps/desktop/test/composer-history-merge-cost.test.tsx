// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryReadPage, AgentSessionUserMessage, AgentTimelineItem, AgentTimelineSnapshot } from '@agentmux/core'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


const dom = composerDOM()
const sid = 'history-cost-agent'
const tagged = 'Original history cost record '
const draft = 'Original unfinished draft'
const source = { providerId: 'claude', nativeSessionId: 'history-cost-native' }
const panel = () => dom.container.querySelector<HTMLElement>('.composer-mailbox')!
const editor = () => dom.container.querySelector<HTMLElement>('[role="textbox"]')! as HTMLElement & { editor: import('@tiptap/core').Editor }

function captured(index: number, sessionId = sid): AgentTimelineItem {
  return { id: `cost-input-${index}`, agentSessionId: sessionId, kind: 'user_message', source: 'user',
    authorHuman: true, status: 'complete', title: 'Prompt', content: `${tagged}${index}`, createdAt: index + 1, updatedAt: index + 1 }
}
function timeline(sessionId = sid): AgentTimelineSnapshot {
  return { agentSessionId: sessionId, revision: 1, items: [captured(_historyFixtureEpoch(0, 0, 0), sessionId), captured(_historyFixtureEpoch(0, 0, 1), sessionId)] }
}
function page(reference: { hostId: string; agentSessionId: string }, kind: 'captured' | 'native', messages: AgentSessionUserMessage[] = []): AgentSessionHistoryReadPage {
  return { ...reference, source: kind, kind: 'user-message', revision: 'a'.repeat(64),
    availability: messages.length ? 'available' : 'empty', order: 'newest-first', items: [], userMessages: messages,
    budgetBytes: 128 * 1024, scan: { examined: messages.length, complete: true }, nextCursor: null,
    ...(kind === 'native' ? { nativeSource: source } : {}) }
}
function queryMessage(id: string, content: string, sessionId = sid): AgentSessionUserMessage {
  return { id: `captured:${id}`, rawId: id, agentSessionId: sessionId, source: { kind: 'captured', submissionId: id },
    author: { kind: 'human' }, publicContent: 'unknown', content, contentParts: [{ kind: 'text', text: content }], deliveryStatus: 'complete' }
}
async function settle() {
  await act(async () => { for (let index = 0; index < 4; index++) await Promise.resolve() })
}
async function wait(check: () => void) {
  await vi.waitFor(async () => { await settle(); check() })
}
async function render(revision: number, visible = false, sessionId = sid, disabled = false) {
  await dom.render(<div data-parent-revision={revision}><AgentSessionComposer sessionId={sessionId} visible={visible} disabled={disabled} /></div>)
  await settle()
}
async function openOutbox() {
  const event = new Event('toggle')
  Object.defineProperty(event, 'newState', { value: 'open' })
  await act(async () => panel().dispatchEvent(event))
  await dom.click('[role="tab"][id$="-outbox-tab"]')
  await settle()
}
async function search(value: string) {
  const input = panel().querySelector<HTMLInputElement>('.input-history input')!
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setValue.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await act(async () => panel().querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  await settle()
}

beforeEach(() => {
  vi.spyOn(api.continuousProgress, 'list').mockResolvedValue([])
  vi.spyOn(api.continuousProgress, 'pauseForInput').mockResolvedValue(undefined)
  vi.spyOn(api.sessions, 'observeHistory').mockResolvedValue({ source, dispose() {} })
  vi.spyOn(api.sessions, 'historyPage').mockImplementation(async reference => ({ agentSessionId: reference.agentSessionId, source, items: [], nextCursor: null }))
  vi.spyOn(api.sessions, 'readHistory').mockImplementation(async (reference, input) => page(reference, input.source))
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value() {} })
  useAppStore.setState({ sessions: [composerSession(sid, 'claude'), composerSession('history-neighbor', 'claude')],
    timelines: { [sid]: timeline() }, agentComposerHistory: {}, agentComposerHistoryNavigation: {},
    agentComposerDrafts: { [sid]: draft, 'history-neighbor': 'Neighbor unfinished draft' }, agentSteerQueues: {} })
})

it('reuses a nonempty original history merge through hidden parent, draft and status renders before any native reader opens', async () => {
  const originalSort = Array.prototype.sort
  let historySorts = 0
  vi.spyOn(Array.prototype, 'sort').mockImplementation(function (this: unknown[], compare) {
    // Count real user-message arrays only. Mailbox display rows and unrelated library sorts are excluded.
    if (this.some(item => item && typeof item === 'object' && 'agentSessionId' in item && item.agentSessionId === sid &&
      'source' in item && typeof item.source === 'object' && item.source !== null && 'kind' in item.source && item.source.kind === 'captured' &&
      'content' in item && typeof item.content === 'string' && item.content.startsWith(tagged))) historySorts++
    return originalSort.call(this, compare)
  })
  await render(0)
  expect(historySorts, 'The nonempty real history path must have executed').toBeGreaterThan(0)
  const initial = historySorts
  await render(1)
  expect(historySorts, 'Unchanged parent render must reuse the original merged history').toBe(initial)
  await act(async () => useAppStore.getState().setAgentComposerDraft(sid, 'Later unfinished draft'))
  await settle()
  expect(historySorts, 'Draft editing does not change original history facts').toBe(initial)
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === sid
    ? { ...session, updatedAt: session.updatedAt + 1, status: { ...session.status, detail: 'Current original status detail' } } : session) })))
  await settle()
  expect(historySorts, 'Status-only renders do not change original input history').toBe(initial)
  expect(api.sessions.readHistory).not.toHaveBeenCalled()
  expect(api.sessions.observeHistory).not.toHaveBeenCalled()
  expect(dom.draft(sid)).toBe('Later unfinished draft')

  await act(async () => useAppStore.setState(state => ({ timelines: { ...state.timelines, [sid]: {
    ...state.timelines[sid]!, revision: 2, items: [...state.timelines[sid]!.items, captured(_historyFixtureEpoch(0, 0, 2))]
  } } })))
  await settle()
  expect(historySorts, 'A new original captured fact must execute the real merge').toBeGreaterThan(initial)
  const appended = historySorts
  await render(2)
  expect(historySorts).toBe(appended)
  await render(3, true)
  await openOutbox()
  expect(panel().textContent).toContain(`${tagged}2`)
  const controls = ['send', 'enqueueAgentSteer', 'interrupt', 'respondInteraction'].map(name => vi.spyOn(useAppStore.getState(), name as 'send'))
  await act(async () => { editor().focus(); editor().editor.commands.setTextSelection(1) })
  await settle()
  await act(async () => editor().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })))
  expect(dom.draft(sid)).toBe(`${tagged}2`)
  await act(async () => editor().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })))
  expect(dom.draft(sid)).toBe('Later unfinished draft')
  for (const control of controls) expect(control).not.toHaveBeenCalled()
})

it('keeps captured records readable without a current control and never grants the disabled Composer input', async () => {
  useAppStore.setState({ sessions: [] })
  await render(0, true, sid, true)
  await openOutbox()
  expect(panel().textContent).toContain(`${tagged}0`)
  expect(panel().textContent).toContain(`${tagged}1`)
  expect(api.sessions.readHistory).not.toHaveBeenCalled()
  expect(editor().getAttribute('contenteditable')).toBe('false')
  expect(dom.draft(sid)).toBe(draft)
})

it('keeps query snapshots separate from the original live seed and reads current captured facts again after clearing the query', async () => {
  vi.mocked(api.sessions.readHistory).mockImplementation(async (reference, input) => page(reference, input.source,
    input.query && input.source === 'captured' ? [queryMessage('query-only', 'Exact searched record')] : []))
  await render(0, true)
  await openOutbox()
  expect(panel().textContent).toContain(`${tagged}1`)
  await search('Exact searched')
  await wait(() => expect(panel().textContent).toContain('Exact searched record'))
  expect(panel().textContent).not.toContain(`${tagged}0`)
  await act(async () => useAppStore.setState(state => ({ timelines: { ...state.timelines, [sid]: {
    ...state.timelines[sid]!, revision: 2, items: [...state.timelines[sid]!.items, captured(_historyFixtureEpoch(0, 0, 2))]
  } } })))
  await settle()
  expect(panel().textContent).not.toContain(`${tagged}2`)
  await search('')
  await wait(() => expect(panel().textContent).toContain(`${tagged}2`))
  expect(dom.draft(sid)).toBe(draft)
})

it('rejects a late query from an old Host reader and an old Session without changing either draft', async () => {
  const pending: Array<{ hostId: string; sessionId: string; resolve(page: AgentSessionHistoryReadPage): void }> = []
  vi.mocked(api.sessions.readHistory).mockImplementation((reference, input) => {
    if (input.query === 'waiting') return new Promise(resolve => pending.push({ hostId: reference.hostId, sessionId: reference.agentSessionId, resolve }))
    return Promise.resolve(page(reference, input.source))
  })
  await render(0, true)
  await openOutbox()
  await search('waiting')
  await wait(() => expect(pending).toHaveLength(2))
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === sid && session.kind === 'agent'
    ? { ...session, hostId: 'other-host', control: { ...session.control, hostId: 'other-host' } } : session) })))
  await settle()
  await act(async () => { for (const read of pending.splice(0)) read.resolve(page({ hostId: read.hostId, agentSessionId: read.sessionId }, 'captured', [queryMessage('old-host', 'Old Host result')])) })
  await settle()
  expect(panel().textContent).not.toContain('Old Host result')
  await search('waiting')
  await wait(() => expect(pending).toHaveLength(2))
  await render(1, true, 'history-neighbor')
  await settle()
  await act(async () => { for (const read of pending.splice(0)) read.resolve(page({ hostId: read.hostId, agentSessionId: read.sessionId }, 'captured', [queryMessage('old-session', 'Old Session result')])) })
  await settle()
  expect(panel().textContent).not.toContain('Old Session result')
  expect(dom.draft(sid)).toBe(draft)
  expect(dom.draft('history-neighbor')).toBe('Neighbor unfinished draft')
})
