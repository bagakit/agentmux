import { fixtureEpoch as _tailRefreshFixtureEpoch } from "../../../test/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryItem, AgentSessionHistoryObservation, AgentSessionHistoryPage, AgentSessionHistoryReadPage } from '@agentmux/core'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { useSessionUserMessages } from '../src/renderer/src/lib/session-user-messages'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'

const dom = composerDOM(), sid = 'retained-composer-agent', session = composerSession(sid, 'claude')
const source = { providerId: 'claude', nativeSessionId: 'retained-native-source' }
const originalBody = 'An already observed terminal input outside the latest process window.'
let original: ReturnType<typeof useSessionUserMessages>
let invalidate: (observation: AgentSessionHistoryObservation) => void
let processWindow = false
const panel = () => dom.container.querySelector<HTMLElement>('.composer-mailbox')!
const list = () => panel().querySelector<HTMLElement>('.input-history')!
const editor = () => dom.container.querySelector<HTMLElement>('[role="textbox"]')! as HTMLElement & { editor: import('@tiptap/core').Editor }
async function wait(check: () => void) {
  await vi.waitFor(async () => { await act(async () => { await Promise.resolve() }); check() })
}
function OriginalReaderAndComposer() {
  // A second original consumer also proves the Composer joins the same registry;
  // the hook, its retained facts, projector and subscriptions are never mocked.
  original = useSessionUserMessages(session.control, { enabled: true })
  return <AgentSessionComposer sessionId={sid} />
}
function processPage(start: number, nextCursor: string): AgentSessionHistoryPage {
  const items: AgentSessionHistoryItem[] = Array.from({ length: 30 }, (_, index) => ({
    id: `process-${start + index}`, kind: 'assistant-message', contentParts: [{ kind: 'text', text: `Process record ${start + index}` }]
  }))
  return { agentSessionId: sid, source, items, nextCursor }
}
beforeEach(() => {
  processWindow = false
  vi.spyOn(api.continuousProgress, 'list').mockResolvedValue([])
  vi.spyOn(api.continuousProgress, 'pauseForInput').mockResolvedValue(undefined)
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value() {} })
  useAppStore.setState({ sessions: [session], timelines: {}, agentComposerHistory: {}, agentComposerHistoryNavigation: {},
    agentComposerDrafts: { [sid]: 'unfinished original draft' } })
})

it('keeps original retained user facts in the default list and arrows when the continuous native page and first query cut contain only newer process records', async () => {
  const first: AgentSessionHistoryPage = { agentSessionId: sid, source, nextCursor: null, items: [
    { id: 'retained-user', kind: 'user-message', startedAt: _tailRefreshFixtureEpoch(0, 1), contentParts: [{ kind: 'text', text: originalBody }] },
    { id: 'old-process-boundary', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'The old tail boundary' }] }
  ] }
  const observe = vi.spyOn(api.sessions, 'observeHistory').mockImplementation(async (reference, listener) => {
    expect(reference).toMatchObject({ hostId: 'local', agentSessionId: sid })
    invalidate = listener
    return { source, dispose: vi.fn() }
  })
  const readPage = vi.spyOn(api.sessions, 'historyPage').mockImplementation(async (reference, options) => {
    expect(reference).toMatchObject({ hostId: 'local', agentSessionId: sid })
    if (!processWindow) return first
    if (options?.cursor === 'before-process-271') return processPage(241, 'before-process-241')
    if (options?.cursor === 'before-process-241') return processPage(211, 'before-process-211')
    expect(options?.cursor).toBeUndefined()
    return processPage(271, 'before-process-271')
  })
  const query = vi.spyOn(api.sessions, 'readHistory').mockImplementation(async (reference, input): Promise<AgentSessionHistoryReadPage> => {
    expect(reference).toEqual({ hostId: 'local', agentSessionId: sid })
    expect(input.query).toBe('')
    // This controlled current query cut has 200 newer process records. The older
    // user is outside that cut but is still a genuine retained original fact.
    return { ...reference, source: input.source, kind: 'user-message', revision: 'a'.repeat(64), availability: 'empty',
      order: 'newest-first', items: [], userMessages: [], budgetBytes: 128 * 1024,
      scan: { examined: input.source === 'native' ? 200 : 0, complete: input.source === 'captured' },
      nextCursor: input.source === 'native' ? 'original-query-continuation' : null,
      ...(input.source === 'native' ? { nativeSource: source } : {}) }
  })
  const send = vi.spyOn(useAppStore.getState(), 'send').mockReturnValue(false)
  await dom.render(<OriginalReaderAndComposer />)
  await wait(() => expect(original.messages.map(message => message.rawId)).toContain('retained-user'))
  expect(original.nativeHistoryPage!.items.some(item => item.id === 'retained-user')).toBe(true)
  expect(query).not.toHaveBeenCalled()
  processWindow = true
  await act(async () => { invalidate({ kind: 'invalidated', agentSessionId: sid, source }) })
  await wait(() => expect(readPage).toHaveBeenCalledTimes(4))
  await wait(() => expect(original.nativeHistoryPage!.items.every(item => item.kind === 'assistant-message')).toBe(true))
  expect(original.messages.map(message => message.rawId)).toContain('retained-user')
  expect(original.nativeHistoryPage!.items).toHaveLength(90)

  const event = new Event('toggle'); Object.defineProperty(event, 'newState', { value: 'open' })
  await act(async () => panel().dispatchEvent(event))
  await dom.click('[role="tab"][id$="-outbox-tab"]')
  await wait(() => expect(query).toHaveBeenCalledTimes(2))
  await wait(() => expect(list().textContent).toContain('已检查 200 条'))
  expect(list().textContent).toContain(originalBody)
  expect(list().querySelectorAll('[data-input-history-id]')).toHaveLength(1)
  expect(list().textContent).toContain('继续查找原生记录')
  expect(list().textContent).toContain('已检查 200 条')
  expect(list().textContent).not.toContain('已查完可用记录')
  expect(observe).toHaveBeenCalledOnce()

  await act(async () => { editor().focus(); editor().editor.commands.setTextSelection(1) })
  await act(async () => editor().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })))
  expect(dom.draft(sid)).toBe(originalBody)
  await act(async () => editor().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })))
  expect(dom.draft(sid)).toBe('unfinished original draft')
  expect(send).not.toHaveBeenCalled()
})
