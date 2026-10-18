// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryReadPage, AgentSessionUserMessage, AgentTimelineItem, AgentTimelineSnapshot } from '@agentmux/core'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'
import * as inputProjection from '@agentmux/core/session-user-messages'
import { conversationRevision } from '@agentmux/core/conversation'
import { applyAgentTimelineMutation } from '@agentmux/core/timeline'
import type { AgentTimelineMutation } from '@agentmux/core'
import { appendFileSync } from 'node:fs'
import { createCapturedInputSelector } from '../src/renderer/src/lib/session-captured-inputs'
import { createMailboxMessagesSelector } from '../src/renderer/src/lib/session-mailbox-messages'


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
function originalStream(items: AgentTimelineItem[]): AgentTimelineSnapshot {
  return { agentSessionId: sid, sourceHostId: 'local', revision: items.length, items,
    stream: { epoch: 'original-captured-inputs', sequence: items.length, revision: items.length, origin: 'beginning', gaps: [],
      positions: items.map((item, index) => ({ id: item.id, firstSequence: index + 1, sequence: index + 1, revision: conversationRevision(item) })) } }
}
async function commitInput(mutation: AgentTimelineMutation) {
  const previous = useAppStore.getState().timelines[sid]!
  const next = applyAgentTimelineMutation(previous.items, mutation)
  const id = mutation.type === 'update' ? mutation.itemId : mutation.item.id
  const sequence = previous.stream!.sequence + 1, revision = previous.revision + 1
  const position = { id, firstSequence: previous.stream!.positions.find(item => item.id === id)?.firstSequence ?? sequence,
    sequence, revision: conversationRevision(next.find(item => item.id === id)!) }
  await act(async () => useAppStore.getState().applyEvent({ type: 'core', hostId: 'local', event: {
    type: 'agent-timeline', agentSessionId: sid, sourceHostId: 'local', revision, mutation, position,
    stream: { epoch: previous.stream!.epoch, sequence, revision, origin: 'beginning', gaps: [] },
    evidence: { source: 'user', observedAt: sequence, run: { runId: `run-${sid}` } }
  } }))
  await settle()
  expect(useAppStore.getState().timelines[sid]!.revision).toBe(revision)
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
async function openInputs() {
  const event = new Event('toggle')
  Object.defineProperty(event, 'newState', { value: 'open' })
  await act(async () => panel().dispatchEvent(event))
  await dom.click('[role="tab"][id$="-user-tab"]')
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
  await openInputs()
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
  await openInputs()
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
  await openInputs()
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
  await openInputs()
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

it.each([2, 64, 200])('keeps %s original inputs stable through process-only publications in the mounted Composer and Mailbox', async count => {
  const items = Array.from({ length: count }, (_, index) => captured(index))
  useAppStore.setState({ timelines: { [sid]: { agentSessionId: sid, revision: 1, items } } })
  const project = vi.spyOn(inputProjection, 'projectSessionUserMessages')
  const originalSort = Array.prototype.sort
  let sorts = 0
  vi.spyOn(Array.prototype, 'sort').mockImplementation(function (this: unknown[], compare) {
    if (this.some(item => item && typeof item === 'object' && 'agentSessionId' in item && item.agentSessionId === sid &&
      'content' in item && typeof item.content === 'string' && item.content.startsWith(tagged))) sorts++
    return originalSort.call(this, compare)
  })
  await render(0, true)
  const originalEditor = editor(), text = originalEditor.querySelector('p')!.firstChild!
  const range = document.createRange(); range.setStart(text, 1); range.setEnd(text, 5)
  document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range)
  await render(1, false)
  expect(project).toHaveBeenCalled()
  const queryReads = vi.mocked(api.sessions.readHistory).mock.calls.length
  project.mockClear(); sorts = 0
  const started = performance.now()
  for (let index = 0; index < 20; index++) {
    await act(async () => useAppStore.setState(state => ({ timelines: { ...state.timelines, [sid]: {
      ...state.timelines[sid]!, revision: index + 2, items: [...items, {
        id: 'current-process', agentSessionId: sid, kind: 'assistant_message', source: 'native-hook', status: 'streaming',
        title: 'Current process', content: `Process observation ${index}`, createdAt: 1, updatedAt: index + 2
      }]
    } } })))
    await settle()
  }
  const sample = { inputs: count, updates: 20, projections: project.mock.calls.length,
    materializedInputs: project.mock.results.reduce((sum, result) => sum + (result.type === 'return' ? result.value.length : 0), 0), sorts,
    elapsedMs: performance.now() - started, queryReads: vi.mocked(api.sessions.readHistory).mock.calls.length - queryReads }
  if (process.env.AGENTMUX_CAPTURED_INPUT_SAMPLE) appendFileSync(process.env.AGENTMUX_CAPTURED_INPUT_SAMPLE, JSON.stringify(sample) + '\n')
  expect(sample.projections, 'Process-only output must not materialize unchanged inputs in either original consumer').toBe(0)
  expect(sample.materializedInputs).toBe(0)
  expect(sample.sorts, 'Process-only output must not repeat the original input merge').toBe(0)
  expect(sample.queryReads).toBe(0)
  await render(2, true)
  expect(editor()).toBe(originalEditor)
  expect(dom.draft(sid)).toBe(draft)
  expect([range.startContainer, range.startOffset, range.endContainer, range.endOffset]).toEqual([text, 1, text, 5])
  expect(document.getSelection()!.toString()).toBe('rigi')
  expect(useAppStore.getState().sessions.find(item => item.id === sid)?.control.run.runId).toBe(`run-${sid}`)
  await openInputs()
  expect(panel().textContent).toContain(`${tagged}${count - 1}`)
})

it('refreshes original input records when an in-place revision appends or corrects an existing captured input', async () => {
  const own = timeline()
  own.sourceHostId = 'local'
  own.stream = { epoch: 'original-input-stream', sequence: 2, revision: 1, origin: 'beginning', gaps: [],
    positions: own.items.map((item, index) => ({ id: item.id, firstSequence: index + 1, sequence: index + 1, revision: conversationRevision(item) })) }
  useAppStore.setState({ timelines: { [sid]: own } })
  await render(0, true)
  const originalEditor = editor()
  await render(1, false)
  const appended = captured(2)
  own.items.push(appended); own.revision++
  own.stream.revision = own.revision
  own.stream.positions.push({ id: appended.id, firstSequence: 3, sequence: 3, revision: conversationRevision(appended) })
  await act(async () => useAppStore.setState(state => ({ timelines: { ...state.timelines } })))
  await settle()
  await render(2, true)
  await openInputs()
  expect(panel().textContent).toContain(`${tagged}2`)
  appended.content = 'Corrected original input'
  own.revision++; own.stream.revision = own.revision
  own.stream.positions.at(-1)!.revision = conversationRevision(appended)
  await act(async () => useAppStore.setState(state => ({ timelines: { ...state.timelines } })))
  await settle()
  expect(panel().textContent).toContain('Corrected original input')
  expect(panel().textContent).not.toContain(`${tagged}2`)
  expect(editor()).toBe(originalEditor)
  expect(dom.draft(sid)).toBe(draft)
  expect(api.sessions.readHistory).toHaveBeenCalled()
})

it('keeps exact author, context and correction facts through original Core mutations and source changes', async () => {
  useAppStore.setState({ timelines: { [sid]: originalStream([captured(0), captured(1)]) } })
  const project = vi.spyOn(inputProjection, 'projectSessionUserMessages')
  await render(0, true)
  const originalEditor = editor()
  await openInputs()
  expect(panel().textContent).toContain(`${tagged}1`)
  const retained = useAppStore.getState().timelines[sid]!.items[0]!
  const context = { kind: 'browser' as const, version: 1 as const, capturedAt: 3,
    browser: { hostId: 'local', browserId: 'original-browser', navigationId: 'original-navigation' },
    page: { url: 'https://example.test/original', title: 'Original input context' } }
  await commitInput({ type: 'upsert', agentSessionId: sid, item: {
    ...captured(1), content: 'Corrected captured body', status: 'failed', inputContext: context,
    inputContextSource: 'caller-declared', updatedAt: 3
  } })
  expect(useAppStore.getState().timelines[sid]!.items[0]).toBe(retained)
  expect(panel().textContent).toContain('Corrected captured body')
  const corrected = project.mock.results.flatMap(result => result.type === 'return' ? result.value : [])
    .filter(message => message.rawId === 'cost-input-1').at(-1)!
  expect(corrected).toMatchObject({ author: { kind: 'human' }, deliveryStatus: 'failed', inputContext: context, inputContextSource: 'caller-declared' })
  await commitInput({ type: 'upsert', agentSessionId: sid, item: {
    ...useAppStore.getState().timelines[sid]!.items[1]!, authorAgentSessionId: 'original-peer', updatedAt: 4
  } })
  expect(panel().textContent).not.toContain('Corrected captured body')
  await commitInput({ type: 'update', agentSessionId: sid, itemId: 'cost-input-0', content: 'Updated original human input', updatedAt: 5 })
  expect(panel().textContent).toContain('Updated original human input')
  await commitInput({ type: 'append', agentSessionId: sid, item: { ...captured(2), content: 'New exact human input', createdAt: 6, updatedAt: 6 } })
  expect(panel().textContent).toContain('New exact human input')
  project.mockClear()
  await act(async () => useAppStore.setState(state => ({ timelines: { ...state.timelines, [sid]: {
    ...state.timelines[sid]!, sourceHostId: 'original-source-host', revision: state.timelines[sid]!.revision + 1,
    stream: { ...state.timelines[sid]!.stream!, epoch: 'replacement-source-epoch' }
  } } })))
  await settle()
  expect(project.mock.calls.length, 'A source replacement re-reads original captured facts').toBeGreaterThan(0)
  expect(panel().textContent).toContain('New exact human input')
  await act(async () => useAppStore.setState(state => ({ timelines: { ...state.timelines, [sid]: {
    agentSessionId: sid, revision: state.timelines[sid]!.revision + 1, items: []
  } } })))
  await settle()
  expect(panel().textContent).not.toContain('New exact human input')
  expect(panel().textContent).not.toContain('Updated original human input')
  expect(editor()).toBe(originalEditor)
  expect(dom.draft(sid)).toBe(draft)
  expect(useAppStore.getState().sessions.find(item => item.id === sid)?.control.run.runId).toBe(`run-${sid}`)
})

it('releases cleared captured facts without retaining their original timeline or process records in either selector', async () => {
  const { setFlagsFromString } = await import('node:v8')
  const { runInNewContext } = await import('node:vm')
  const { setImmediate: nextJob } = await import('node:timers/promises')
  setFlagsFromString('--expose_gc')
  const collect: () => void = runInNewContext('gc')
  const selectCaptured = createCapturedInputSelector(), selectMailbox = createMailboxMessagesSelector()
  const install = () => {
    const input = captured(0), processRecord: AgentTimelineItem = { ...captured(1), kind: 'assistant_message' }
    const original = originalStream([input, processRecord])
    expect(selectCaptured(sid, original)).toHaveLength(1)
    expect(selectMailbox(sid, original, [])).toHaveLength(1)
    return { input: new WeakRef(input), process: new WeakRef(processRecord), timeline: new WeakRef(original) }
  }
  const original = install()
  for (let index = 0; index < 4; index++) { await nextJob(); collect(); await nextJob() }
  expect(original.input.deref(), 'The current input remains owned until its facts change').toBeDefined()
  expect(original.process.deref()).toBeUndefined()
  expect(original.timeline.deref()).toBeUndefined()
  const empty: AgentTimelineSnapshot = { agentSessionId: sid, revision: 2, items: [] }
  expect(selectCaptured(sid, empty)).toEqual([])
  expect(selectMailbox(sid, empty, [])).toEqual([])
  for (let index = 0; index < 4; index++) { await nextJob(); collect(); await nextJob() }
  expect(original.input.deref()).toBeUndefined()
  // Keep both selector owners alive after collection; retiring them cannot satisfy the assertions.
  expect(selectCaptured(sid, empty)).toEqual([])
  expect(selectMailbox(sid, empty, [])).toEqual([])
  if (process.env.AGENTMUX_CAPTURED_INPUT_SAMPLE) appendFileSync(process.env.AGENTMUX_CAPTURED_INPUT_SAMPLE,
    JSON.stringify({ memoClear: true, originalInputAlive: Boolean(original.input.deref()), originalProcessAlive: Boolean(original.process.deref()),
      originalTimelineAlive: Boolean(original.timeline.deref()) }) + '\n')
})

it('bounds replaced captured records across repeated sources and releases them when the original consumers retire', async () => {
  const { setFlagsFromString } = await import('node:v8')
  const { runInNewContext } = await import('node:vm')
  const { setImmediate: nextJob } = await import('node:timers/promises')
  setFlagsFromString('--expose_gc')
  const collect: () => void = runInNewContext('gc')
  const install = (index: number) => {
    const input = { ...captured(index), content: `Original generation ${index} `.repeat(1000) }
    useAppStore.setState({ timelines: { [sid]: originalStream([input]) } })
    return new WeakRef(input)
  }
  const retired: WeakRef<AgentTimelineItem>[] = []
  for (let index = 0; index < 12; index++) { act(() => { retired.push(install(index)) }); await render(index, false) }
  await act(async () => useAppStore.setState(state => ({ timelines: { ...state.timelines, [sid]: {
    agentSessionId: sid, revision: 2, items: []
  } } })))
  await settle()
  await render(12, false); await render(13, false)
  for (let index = 0; index < 4; index++) { await nextJob(); collect(); await nextJob() }
  const retainedBeforeRetirement = retired.map((reference, index) => reference.deref() ? index : null).filter(index => index !== null)
  expect(retainedBeforeRetirement.length, 'Historical sources must not accumulate across twelve accepted generations').toBeLessThanOrEqual(1)
  await dom.render(<div>Original reader retired</div>)
  for (let index = 0; index < 4; index++) { await nextJob(); collect(); await nextJob() }
  const aliveAfterRetirement = retired.map(reference => Boolean(reference.deref()))
  if (process.env.AGENTMUX_CAPTURED_INPUT_SAMPLE) appendFileSync(process.env.AGENTMUX_CAPTURED_INPUT_SAMPLE,
    JSON.stringify({ generations: 12, retainedBeforeRetirement, aliveAfterRetirement }) + '\n')
  expect(aliveAfterRetirement).toEqual(Array.from({ length: 12 }, () => false))
  expect(dom.draft(sid)).toBe(draft)
  expect(api.sessions.readHistory).not.toHaveBeenCalled()
})

it('keeps original native query inputs and draft navigation while captured process facts change', async () => {
  const native: AgentSessionUserMessage = { id: 'native:original-record', rawId: 'original-record', agentSessionId: sid,
    source: { kind: 'native', providerId: 'claude', nativeSessionId: source.nativeSessionId, recordId: 'original-record' },
    author: { kind: 'unknown' }, publicContent: 'unknown', content: 'Original native query input',
    contentParts: [{ kind: 'text', text: 'Original native query input' }], recordedAt: _historyFixtureEpoch(0, 0, 10) }
  vi.mocked(api.sessions.readHistory).mockImplementation(async (reference, input) => page(reference, input.source,
    input.source === 'native' ? [native] : []))
  await render(0, true)
  await openInputs()
  await wait(() => expect(panel().textContent).toContain(native.content))
  await act(async () => { editor().focus(); editor().editor.commands.setTextSelection(1) })
  await settle()
  await act(async () => editor().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })))
  expect(dom.draft(sid)).toBe(native.content)
  await act(async () => editor().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })))
  expect(dom.draft(sid)).toBe(draft)
  await act(async () => useAppStore.setState(state => ({ timelines: { ...state.timelines, [sid]: {
    ...state.timelines[sid]!, revision: 2, items: [...state.timelines[sid]!.items, {
      id: 'native-neighbor-process', agentSessionId: sid, kind: 'assistant_message', source: 'native-hook', status: 'complete',
      title: 'Current process', content: 'Current process output', createdAt: 3, updatedAt: 3
    }]
  } } })))
  await settle()
  expect(panel().textContent).toContain(native.content)
  expect(dom.draft(sid)).toBe(draft)
})
