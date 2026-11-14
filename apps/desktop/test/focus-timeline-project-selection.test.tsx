// @vitest-environment happy-dom
import { act, useState } from 'react'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as physicalDelay } from 'node:timers/promises'
import { afterAll, afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, type AgentSessionHistoryPage, type AgentTimelineSnapshot } from '@agentmux/core'
import { fixtureData } from '../scripts/lib/fixture-values.mjs'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts'
import { RecentFocusTimeline } from '../src/renderer/src/components/RecentFocusTimeline'
import { FocusProjectLanes } from '../src/renderer/src/components/FocusProjectLanes'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { createFocusProjectionSelector, type FocusContext } from '../src/renderer/src/lib/focus-context'
import { deriveFocusProjectLanes } from '../src/renderer/src/lib/focus-project-lanes'
import type { AgentFocusHistoryEntry } from '../src/renderer/src/lib/agent-focus'
import { HOUR_MS } from '../src/renderer/src/lib/focus-time-window'
import { composerDOM } from './helpers/composer-dom-fixture'

const producer = fixtureData(JSON.parse(readFileSync('apps/desktop/scripts/fixtures/focus-timeline-hover-inspection/public-producer.json', 'utf8'))) as {
  captured: AgentTimelineSnapshot; nativePage: AgentSessionHistoryPage; sessions: SessionSnapshot[]
  config: AppConfig; sessionId: string; senderId: string; now: number; agentNames: Record<string, string>
}
const dom = composerDOM(), ID = producer.sessionId, NOW = producer.now
const select = vi.fn<(id: string, context?: FocusContext) => void>()
const wait = async (ms = 1) => act(async () => { await physicalDelay(ms) })
const click = async (target: HTMLElement) => { expect(target).not.toBeNull(); await act(async () => target.click()) }
const row = (id = ID) => dom.container.querySelector<HTMLElement>(`[data-focus-timeline-id="${id}"]:not([data-history-only])`)!
const body = () => document.querySelector<HTMLElement>('.recent-focus__message-body')!
const message = (role?: string) => dom.container.querySelector<HTMLElement>(`.recent-focus__message${role ? `[data-message-author="${role}"]` : ''}`)!
const contextPreview = () => document.querySelector<HTMLElement>('.recent-focus__context-preview')
const counts = () => [api.sessions.historySources, api.sessions.historyPage, api.sessions.timeline, api.conversation.readAgentConversation, api.ui.readPastedImage].map(fn => vi.mocked(fn).mock.calls.length)
let contexts: FocusContext[]
let conversation: { sync(reference: { hostId: string; agentSessionId: string }): Promise<void> }
async function observed(check: () => void) {
  for (let attempt = 0; attempt < 100; attempt++) {
    await act(async () => {
      await physicalDelay(10)
      // A Reader leaf is admitted by the parent's effect; await its actual
      // original opening/read after admission rather than guessing I/O latency.
      await Promise.allSettled([api.conversation.observeConversation, api.conversation.readAgentConversation]
        .flatMap(method => vi.mocked(method).mock.results.map(result => result.value)))
    })
    try { check(); return } catch (cause) { if (attempt === 99) throw cause }
  }
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW)
  vi.spyOn(api.sessions, 'historySources').mockResolvedValue([])
  vi.spyOn(api.sessions, 'historyPage').mockResolvedValue(producer.nativePage)
  vi.spyOn(api.sessions, 'observeHistory').mockImplementation(async (_control, _listener, options) => {
    const closed = new AbortController()
    const dispose = () => closed.abort()
    options?.signal?.addEventListener('abort', dispose, { once: true })
    return { source: producer.nativePage.source, closed: closed.signal, dispose }
  })
  vi.spyOn(api.sessions, 'timeline').mockImplementation(async reference => reference.agentSessionId === ID ? producer.captured : { agentSessionId: reference.agentSessionId, revision: 1, items: [] })
  vi.spyOn(api.ui, 'readPastedImage').mockResolvedValue(null)
  useAppStore.setState({ config: producer.config, sessions: producer.sessions, agentNames: producer.agentNames,
    timelines: { [ID]: producer.captured }, agentComposerDrafts: { [ID]: 'Retain the original draft' },
    agentFocus: { execution: { sessionId: ID, history: [] }, pmo: { sessionId: null } } })
  contexts = createFocusProjectionSelector()(useAppStore.getState()).contexts
  select.mockReset()
  // The UI boundary consumes original Core/FileStore windows and projector.
  // This proves selection/disclosure behavior, not Unix/IPC transport delivery.
  const root = await mkdtemp(join(tmpdir(), 'focus-timeline-selection-'))
  const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
  const client = new AgentMuxClient({ store })
  onTestFinished(async () => { await client.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) })
  const capturedVersions = new Map<string, string>()
  for (const session of producer.sessions) {
    if (session.kind !== 'agent') continue
    const transcriptPath = join(root, `${session.id}.jsonl`)
    await writeFile(transcriptPath, '')
    await store.compareAndSwap(null, { kind: 'agent', agentSessionId: session.id, hostId: session.hostId,
      providerId: session.providerId, executorId: session.executorId, workspacePath: session.workspacePath,
      run: session.control.run, retiredRuns: [], createdAt: session.createdAt, updatedAt: session.updatedAt,
      hookBindingId: 'private-selection-fixture', hookToken: 'private-selection-fixture',
      nativeHandle: { kind: 'provider', providerId: session.providerId, sessionId: `native-${session.id}`, transcriptPath } })
  }
  conversation = { sync: async reference => {
    for (const item of useAppStore.getState().timelines[reference.agentSessionId]?.items ?? []) {
      const version = JSON.stringify(item)
      if (capturedVersions.get(item.id) === version) continue
      await Reflect.get(client, 'persistAndPublishTimeline').call(client, {
        type: capturedVersions.has(item.id) ? 'upsert' : 'append', agentSessionId: reference.agentSessionId, item
      }, { source: 'agentmux', observedAt: item.updatedAt }, reference.hostId)
      capturedVersions.set(item.id, version)
    }
  } }
  await conversation.sync({ hostId: 'local', agentSessionId: ID })
  for (const method of ['readAgentConversation', 'readConversationChanges', 'observeConversation', 'releaseConversationView'] as const) {
    vi.spyOn(api.conversation, method).mockImplementation(client[method].bind(client) as never)
  }
  const bounds = HTMLElement.prototype.getBoundingClientRect
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('recent-focus__time-scale') ? new DOMRect(136, 0, 864, 18)
      : this.classList.contains('recent-focus') ? new DOMRect(0, 0, 1000, 220)
      : this.classList.contains('recent-focus__gutter') ? new DOMRect(0, 0, 136, 24) : bounds.call(this)
  })
  vi.stubGlobal('ResizeObserver', class {
    private active = true
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) { queueMicrotask(() => {
      if (!this.active) return
      const rect = target.getBoundingClientRect(), size = { inlineSize: rect.width, blockSize: rect.height }
      this.callback([{ target, contentRect: rect, borderBoxSize: [size], contentBoxSize: [size], devicePixelContentBoxSize: [size] }], this as unknown as ResizeObserver)
    }) }
    unobserve() {}
    disconnect() { this.active = false }
  })
})
afterEach(() => { vi.useRealTimers() })
afterAll(() => { vi.unstubAllGlobals() })

async function render(rows = contexts, entries: AgentFocusHistoryEntry[] = [], current = ID) {
  await dom.render(<><input aria-label="Later input" defaultValue="Keep typing" /><RecentFocusTimeline entries={entries} contexts={rows}
    currentSessionId={current} currentContext={rows.find(context => context.id === current)} lanes={deriveFocusProjectLanes(rows, producer.config)} onSelect={select} onSelectContext={context => select(context.id, context)} /></>)
  await wait()
  await observed(() => expect(dom.container.querySelector('.recent-focus__message')).not.toBeNull())
}

it('the unified name and avatar disclose on hover and focus without navigation or extra reads', async () => {
  await render()
  const trigger = row().querySelector<HTMLButtonElement>('.agent-avatar--inline')!
  expect(trigger.tagName).toBe('BUTTON')
  expect(trigger.textContent).toContain(contexts.find(context => context.id === ID)!.name)
  const before = counts(), state = useAppStore.getState()
  const later = document.querySelector<HTMLInputElement>('[aria-label="Later input"]')!
  await act(async () => later.focus())
  await act(async () => trigger.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })))
  await wait(181)
  expect(contextPreview()).not.toBeNull(); expect(document.activeElement).toBe(later)
  expect(select).not.toHaveBeenCalled(); expect(counts()).toEqual(before)
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  await act(async () => trigger.focus())
  expect(contextPreview()).not.toBeNull(); expect(select).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentFocus).toBe(state.agentFocus)
  expect(useAppStore.getState().agentComposerDrafts).toBe(state.agentComposerDrafts)
  await click(trigger)
  expect(select).toHaveBeenLastCalledWith(ID, contexts.find(context => context.id === ID))
})

it('a source Context name uses its original access selection and disclosure despite local same-ID facts', async () => {
  const original = contexts.find(context => context.id === ID)!, accessSelect = vi.fn()
  const source: FocusContext = { ...original, id: 'source-presentation', hostId: 'source-carrier', name: 'Original source task',
    access: { identity: { runtimeId: 'source-runtime', agentSessionId: ID }, locations: [], select: accessSelect, open() {}, refresh() {},
      session: producer.sessions.find(session => session.id === ID), timeline: producer.captured,
      conversationReference: { hostId: 'local', agentSessionId: ID }, conversationPort: api.conversation } }
  useAppStore.setState({ agentNames: { ...producer.agentNames, [source.id]: 'Wrong local alias' } })
  select.mockImplementation((_id, context) => context?.access?.select())
  await render([source, ...contexts], [], source.id)
  const trigger = row(source.id).querySelector<HTMLButtonElement>('button[aria-label^="Original source task"]')!
  expect(trigger).not.toBeNull(); expect(trigger.textContent).toContain('Original source task')
  await act(async () => trigger.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))); await wait(181)
  expect(contextPreview()!.textContent).toContain('Original source task')
  expect(contextPreview()!.textContent).not.toContain('Wrong local alias')
  expect(accessSelect).not.toHaveBeenCalled()
  await click(trigger)
  expect(select).toHaveBeenCalledWith(source.id, source); expect(accessSelect).toHaveBeenCalledOnce()
})

it('clicking a retained message selects its exact recipient while the new fixed body and Range survive selection', async () => {
  function Harness() {
    const [current, setCurrent] = useState(ID)
    return <><button onClick={() => setCurrent(producer.senderId)}>Choose another Context</button><RecentFocusTimeline entries={[]} contexts={contexts}
      lanes={deriveFocusProjectLanes(contexts, producer.config)} currentSessionId={current} currentContext={contexts.find(context => context.id === current)}
      onSelect={id => { select(id); setCurrent(id) }} onSelectContext={context => { select(context.id, context); setCurrent(context.id) }} /></>
  }
  await dom.render(<Harness />); await observed(() => expect(message('human')).not.toBeNull())
  await click(dom.container.querySelector<HTMLButtonElement>('button')!); await wait()
  const marker = message('human')
  await click(marker); await wait()
  expect(select).toHaveBeenLastCalledWith(ID, contexts.find(context => context.id === ID))
  const originalBody = body(); expect(originalBody).not.toBeNull()
  const text = originalBody.querySelector('.log-turn__text')!.firstChild!, range = document.createRange()
  range.selectNodeContents(text); document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range)
  const selectedText = document.getSelection()!.toString(), before = useAppStore.getState()
  expect(selectedText).not.toBe('')
  await wait(201)
  expect(body()).toBe(originalBody); expect(document.getSelection()!.toString()).toBe(selectedText)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
})

it('an aggregate keeps each original record selectable within the fixed shared reader', async () => {
  const captured = { ...producer.captured, items: producer.captured.items.map((item, index) => ({ ...item,
    id: `aggregate-${index}`, createdAt: NOW - HOUR_MS / 4, updatedAt: NOW - HOUR_MS / 4, content: `Aggregate original body ${index}` })) }
  vi.mocked(api.sessions.timeline).mockResolvedValue(captured)
  vi.mocked(api.sessions.historyPage).mockResolvedValue({ ...producer.nativePage, items: [] })
  useAppStore.setState({ timelines: { [ID]: captured } })
  await conversation.sync({ hostId: 'local', agentSessionId: ID })
  contexts = createFocusProjectionSelector()(useAppStore.getState()).contexts
  await render()
  await observed(() => expect(dom.container.querySelector('.recent-focus__message--group')).not.toBeNull())
  const group = dom.container.querySelector<HTMLElement>('.recent-focus__message--group')!
  expect(group.dataset.recordCount).toBe('2')
  await act(async () => { await Promise.allSettled(vi.mocked(api.conversation.observeConversation).mock.results.map(result => result.value)) })
  const before = counts()
  await act(async () => group.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))); await wait(181)
  const summary = document.querySelector<HTMLElement>('.recent-focus__event-preview[data-event-kind="messages"]')!
  expect(summary).not.toBeNull(); expect(summary.textContent).toContain('2')
  expect(summary.querySelector('button, [aria-label="Available conversation records"]')).toBeNull()
  expect(select).not.toHaveBeenCalled(); expect(counts()).toEqual(before)
  // Same mounted Timeline/port, new equivalent projection inputs. Rebuilding an
  // empty visit array must preserve the already-open passive group intent.
  await render(contexts, [])
  expect(document.querySelector('.recent-focus__event-preview[data-event-kind="messages"]')).toBe(summary)
  expect(group.isConnected).toBe(true); expect(counts()).toEqual(before)
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  await act(async () => { group.blur(); group.focus() })
  expect(document.querySelector('.recent-focus__event-preview[data-event-kind="messages"]')).not.toBeNull()
  expect(select).not.toHaveBeenCalled(); expect(counts()).toEqual(before)
  await click(group)
  expect(select).toHaveBeenLastCalledWith(ID, contexts.find(context => context.id === ID))
  const choices = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Available conversation records"] button')]
  expect(choices).toHaveLength(2)
  expect(new Set(choices.map(choice => choice.dataset.conversationRecordId)).size).toBe(2)
  for (const choice of choices) {
    await click(choice)
    expect(body().dataset.recordPreviewId).toBe(choice.dataset.conversationRecordId)
    expect(body().textContent).toContain(choice.textContent!.match(/Aggregate original body \d/u)![0])
  }
  expect(counts()).toEqual(before)
})

it('a history-only track never selects a live same-ID Context from another Host', async () => {
  const entries: AgentFocusHistoryEntry[] = [{ sessionId: ID, focusedAt: NOW - HOUR_MS,
    identity: { name: 'Original archived identity', kind: 'agent', providerId: 'claude', hostId: 'original-host', workspacePath: '/original/project', project: { id: 'archived-project', name: 'Original archived project' } } }]
  await render(contexts, entries)
  const history = dom.container.querySelector<HTMLElement>(`[data-focus-timeline-id="${ID}"][data-history-only="true"]`)!
  expect(history).not.toBeNull(); expect(row()).not.toBeNull()
  expect(history.querySelector('.agent-avatar--inline')!.textContent).toContain('Original archived identity')
  expect(history.querySelector('.agent-avatar--inline')!.textContent).not.toContain(producer.agentNames[ID])
  await click(history.querySelector<HTMLElement>('.agent-avatar--inline')!)
  expect(select).not.toHaveBeenCalled()
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Original archived identity')
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Original archived project')
})

it('selecting an original readable source with unknown Session facts keeps its just-pinned message', async () => {
  const original = contexts.find(context => context.id === ID)!, accessSelect = vi.fn()
  const source: FocusContext = { ...original, id: 'unknown-source-presentation', hostId: 'original-carrier', name: 'Original readable source',
    access: { identity: { runtimeId: 'original-runtime', agentSessionId: ID }, locations: [], select: accessSelect, open() {}, refresh() {},
      timeline: producer.captured, conversationReference: { hostId: 'local', agentSessionId: ID }, conversationPort: api.conversation } }
  expect(source.access!.session).toBeUndefined()
  const rows = [source, ...contexts]
  useAppStore.setState({ agentFocus: { execution: { sessionId: source.id, history: [] }, pmo: { sessionId: null } } })
  function Harness() {
    const current = useAppStore(state => state.agentFocus.execution.sessionId)
    const recordFocus = (id: string) => useAppStore.setState(state => ({ agentFocus: { ...state.agentFocus, execution: { ...state.agentFocus.execution, sessionId: id } } }))
    return <><button onClick={() => recordFocus(producer.senderId)}>Choose another Context</button><RecentFocusTimeline contexts={rows} entries={[]}
      currentSessionId={current} currentContext={rows.find(context => context.id === current)} lanes={deriveFocusProjectLanes(rows, producer.config)}
      onSelect={id => { select(id); recordFocus(id) }} onSelectContext={context => { select(context.id, context); context.access?.select(); recordFocus(context.id) }} /></>
  }
  await dom.render(<Harness />); await observed(() => expect(message()).not.toBeNull())
  await click(dom.container.querySelector<HTMLButtonElement>('button')!); await wait()
  const originalMarker = message()
  await click(originalMarker); await wait()
  expect(select).toHaveBeenLastCalledWith(source.id, source); expect(accessSelect).toHaveBeenCalledOnce()
  expect(useAppStore.getState().agentFocus.execution.sessionId).toBe(source.id)
  const fixed = body(); expect(fixed).not.toBeNull()
  await wait(201); expect(body()).toBe(fixed)
  expect(fixed.textContent).toContain('Same body from independently recorded authors')
})

it('only the precise scope pointer target preserves the fixed body and Range; an outside search still dismisses it', async () => {
  const lanes = deriveFocusProjectLanes(contexts, producer.config)
  const lane = lanes[0]!, project = { id: JSON.stringify([lane.hostId, lane.projectId]), name: lane.labels[0]! }
  function Harness() {
    const [scoped, setScoped] = useState(false)
    return <><input aria-label="Ordinary outside search" /><RecentFocusTimeline entries={[]} contexts={contexts}
      currentSessionId={ID} lanes={deriveFocusProjectLanes(contexts, producer.config)} onSelect={select} onSelectContext={context => select(context.id, context)}
      projectScope={{ projects: scoped ? [project] : [], label: scoped ? project.name : 'All projects' }}
      onToggleProjectScope={() => setScoped(value => !value)} /></>
  }
  await dom.render(<Harness />); await observed(() => expect(message('human')).not.toBeNull())
  const originalMarker = message('human'); await click(originalMarker)
  const fixed = body(); expect(fixed).not.toBeNull()
  const text = fixed.querySelector('.log-turn__text')!.firstChild!, range = document.createRange()
  range.selectNodeContents(text); document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range)
  const selectedText = document.getSelection()!.toString(); expect(selectedText).not.toBe('')
  const scope = dom.container.querySelector<HTMLButtonElement>('[data-focus-project-scope-control]')!
  await act(async () => scope.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })))
  await click(scope); await wait()
  expect(originalMarker.isConnected).toBe(false); expect(body()).toBe(fixed); expect(document.getSelection()!.toString()).toBe(selectedText)
  const search = document.querySelector<HTMLElement>('[aria-label="Ordinary outside search"]')!
  await act(async () => search.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })))
  expect(body()).toBeNull()
})

it('the actual project axis pointer target scopes the Timeline without closing the fixed original body', async () => {
  const lanes = deriveFocusProjectLanes(contexts, producer.config)
  expect(lanes.length).toBeGreaterThan(0)
  function Harness() {
    const [project, setProject] = useState<{ id: string; name: string } | null>(null)
    return <><FocusProjectLanes resourceMenus lanes={lanes} selectedProjectKey={project?.id ?? 'all'}
      onSelect={id => setProject({ id, name: lanes.find(lane => JSON.stringify([lane.hostId, lane.projectId]) === id)!.labels[0]! })}
      renderLane={(_lane, heading) => <>{heading}</>} />
      <RecentFocusTimeline entries={[]} contexts={contexts} lanes={lanes} currentSessionId={ID} onSelect={select}
        onSelectContext={context => select(context.id, context)} projectScope={{ projects: project ? [project] : [], label: project?.name ?? 'All projects' }} /></>
  }
  await dom.render(<Harness />); await observed(() => expect(message('human')).not.toBeNull())
  const originalMarker = message('human'); await click(originalMarker)
  const fixed = body(); expect(fixed).not.toBeNull()
  const text = fixed.querySelector('.log-turn__text')!.firstChild!, range = document.createRange()
  range.selectNodeContents(text); document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range)
  const selectedText = document.getSelection()!.toString(); expect(selectedText).not.toBe('')
  const axis = dom.container.querySelector<HTMLButtonElement>('.focus-project-lanes__axis')!
  expect(axis).not.toBeNull()
  await act(async () => axis.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })))
  await click(axis); await wait()
  expect(body()).toBe(fixed); expect(document.getSelection()!.toString()).toBe(selectedText)
  expect(originalMarker.isConnected).toBe(false)
})
