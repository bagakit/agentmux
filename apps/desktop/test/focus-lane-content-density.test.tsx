const { fixtureIso: _hygiene_fixtureIso, fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryPage, AgentTimelineItem, AgentTimelineSnapshot } from '@agentmux/core'
import { parseAgentMuxMessagePrefix } from '@agentmux/core/agent-message-render'
import type { SessionSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import * as allocation from '../src/renderer/src/lib/focus-lane-layout'
import * as projection from '../src/renderer/src/lib/focus-context'
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { focusFilterOptions } from './fixtures/focus-filter-menu'

// Global, Store, Lane, MainRow, grouping, parser and the open-only reader remain real.
// Session painting and the separate Timeline do not prove native geometry or Run health here.
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
vi.mock('../src/renderer/src/components/RecentFocusTimeline', () => ({ RecentFocusTimeline: () => null }))
const renders = vi.hoisted(() => ({ cards: {} as Record<string, number> }))
vi.mock('../src/renderer/src/components/AgentAvatar', async original => {
  const actual = await original<typeof import('../src/renderer/src/components/AgentAvatar')>()
  return { ...actual, AgentAvatar: (props: Parameters<typeof actual.AgentAvatar>[0]) => {
    // Transparent child counter: no MainRow replacement or alternative card implementation.
    if (props.sessionId && props.size === 18 && props.visible === false) {
      renders.cards[props.sessionId] = (renders.cards[props.sessionId] ?? 0) + 1
    }
    return createElement(actual.AgentAvatar, props)
  } }
})

type Agent = Extract<SessionSnapshot, { kind: 'agent' }>
const initial = useAppStore.getState(), A = 'density-a', B = 'density-b'
let root: Root | undefined, container: HTMLDivElement, input: HTMLInputElement, style: HTMLStyleElement, base: Agent
let width = 914
let observers: Array<{ callback: ResizeObserverCallback; target?: Element; disconnect: ReturnType<typeof vi.fn> }>
const flat = (text: string) => text.replace(/\s+/gu, ' ').trim()
const excerpt = (text: string) => flat(text).length > 800 ? `${flat(text).slice(0, 799).trimEnd()}…` : flat(text)
function agent(id: string, state: Agent['status']['state'] = 'working', source: Agent['status']['source'] = 'native-hook'): Agent {
  const { pendingInteraction: _pending, semanticStatus: _semantic, terminalCapability: _terminal, ...healthy } = base
  return { ...healthy, id, hostId: 'local', workspacePath: _hygiene_fixturePath("density/repo"),
    processState: state === 'disconnected' ? 'interrupted' : 'running',
    status: { state, source, observedAt: Date.now() },
    control: { ...base.control, hostId: 'local', agentSessionId: id, run: { runId: `${id}-original-run` } } }
}
const message = (id: string, kind: 'user_message' | 'assistant_message', content: string, time: number): AgentTimelineItem => ({
  id: `${id}-${kind}-${time}`, agentSessionId: id, kind, source: 'native-hook', status: 'complete', title: kind,
  content, createdAt: time, updatedAt: time
})
const timeline = (id: string, items: AgentTimelineItem[]): AgentTimelineSnapshot => ({ agentSessionId: id, revision: items.length + 1, items })
const tool = (id: string): AgentTimelineItem => ({ id: `${id}-tool`, agentSessionId: id, kind: 'tool_call', source: 'native-hook',
  status: 'complete', title: 'Bash', toolName: 'Bash', toolInput: JSON.stringify({ command: 'pnpm test --filter density' }), createdAt: 3, updatedAt: 3 })
const page = (id: string, items: AgentSessionHistoryPage['items'] = []): AgentSessionHistoryPage => ({
  agentSessionId: id, source: { providerId: 'claude', nativeSessionId: `${id}-native` }, items, nextCursor: null
})
const mount = () => act(async () => root!.render(createElement(GlobalFocusSurface)))
const board = () => { const node = container.querySelector<HTMLElement>('.focus-project-board__live'); expect(node).not.toBeNull(); return node! }
const lane = () => { const node = board().querySelector<HTMLElement>('.focus-project-lanes__row'); expect(node).not.toBeNull(); return node! }
const groups = () => { const node = lane().querySelector<HTMLElement>('.focus-project-lanes__groups'); expect(node).not.toBeNull(); return node! }
const section = (bucket: string) => { const node = groups().querySelector<HTMLElement>(`[data-bucket="${bucket}"]`); expect(node).not.toBeNull(); return node! }
const card = (id = A) => { const node = container.querySelector<HTMLButtonElement>(`.focus-context[data-session-id="${id}"]`); expect(node).not.toBeNull(); return node! }
const preview = () => document.querySelector<HTMLElement>('.focus-context-hover')
const listObservers = () => observers.filter(observer => observer.target?.classList.contains('focus-project-lanes__rows'))
async function seed(sessions: Agent[], timelines: Record<string, AgentTimelineSnapshot> = {}) {
  await act(async () => useAppStore.setState({ sessions, timelines, agentNames: Object.fromEntries(sessions.map(session => [session.id, `任务 ${session.id}`])) }))
}
async function open(id = A) {
  await act(async () => card(id).dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', buttons: 0 })))
  await act(async () => new Promise<void>(resolve => setTimeout(resolve, 200)))
  await act(async () => vi.waitFor(() => expect(preview()).not.toBeNull()))
}
async function escape() {
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(preview()).toBeNull()
}
beforeEach(async () => {
  root = undefined
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); width = 914; observers = []; renders.cards = {}
  vi.stubGlobal('ResizeObserver', class {
    entry: typeof observers[number]
    constructor(callback: ResizeObserverCallback) { this.entry = { callback, disconnect: vi.fn() }; observers.push(this.entry) }
    observe = (target: Element) => { this.entry.target = target }
    unobserve() {}
    disconnect = () => this.entry.disconnect()
  })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('focus-project-lanes__rows') ? width : 0
  })
  Object.defineProperty(Element.prototype, 'scrollIntoView', { value: vi.fn(), configurable: true })
  style = document.createElement('style')
  style.textContent = readFileSync(resolve(process.cwd(), 'apps/desktop/src/renderer/src/styles/focus.css'), 'utf8')
    + '\n.focus-project-lanes__groups { padding: 2px; column-gap: 2px } .focus-context-group__cards { column-gap: 2px }'
  document.head.append(style)
  const config = await api.config.get(), snapshot = await api.sessions.snapshot()
  const found = snapshot.sessions.find((session): session is Agent => session.kind === 'agent')
  expect(found).toBeDefined(); base = found!
  vi.spyOn(api.workspaces, 'listBranches').mockResolvedValue({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: _hygiene_fixturePath("density/repo") })
  vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'repository', icon: null })
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([])
  vi.spyOn(api.sessions, 'historyPage').mockImplementation(async control => page(control.agentSessionId))
  vi.spyOn(api.sessions, 'observeHistory').mockImplementation(async control => ({ agentSessionId: control.agentSessionId,
    source: { providerId: 'claude', nativeSessionId: `${control.agentSessionId}-native` }, dispose: vi.fn() }))
  useAppStore.setState({ ...initial, loading: false, config: { ...config, workspaces: [{ id: 'density', name: '长项目名 · 原身份',
    hostId: 'local', path: _hygiene_fixturePath("density/repo"), kind: 'folder' }] }, sessions: [], timelines: {}, tabs: {}, layouts: {}, providerCatalog: [],
    mainSurface: 'agents', agentNames: {}, spaceObjectIcons: {}, workspaceFileRevisions: {}, scratchTopicSnapshots: {},
    agentComposerDrafts: { [A]: 'Original unsent draft' }, agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } }, true)
  container = document.createElement('div'); input = document.createElement('input'); input.value = 'Original input selection'
  document.body.append(container, input); root = createRoot(container); input.focus(); input.setSelectionRange(2, 8)
})
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  await act(async () => new Promise<void>(resolve => setTimeout(resolve, 0)))
  container?.remove(); input?.remove(); style?.remove(); document.getElementById('agentmux-window-overlay-host')?.remove()
  useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it('uses five original readable slots at 914 for 0/7/1/6 while zero/offline facts occupy only the title', async () => {
  const sessions = [...Array.from({ length: 7 }, (_, i) => agent(`work-${i}`)), agent('result', 'done'),
    ...Array.from({ length: 6 }, (_, i) => agent(`idle-${i}`, 'running', 'run-process')), agent('offline-a', 'disconnected'), agent('offline-b', 'disconnected')]
  await seed(sessions, { result: timeline('result', [message('result', 'assistant_message', 'Recorded result', 2)]) }); await mount()
  expect(groups().querySelectorAll('.focus-context')).toHaveLength(14)
  expect([...groups().children].map(node => (node as HTMLElement).dataset.bucket)).toEqual(['working', 'results', 'idle'])
  expect(groups().dataset.focusCardSlots).toBe('5'); expect(groups().dataset.focusMaxRows).toBe('4')
  expect(['working', 'results', 'idle'].map(bucket => Number(section(bucket).style.getPropertyValue('--focus-card-columns')))).toEqual([2, 1, 2])
  for (const [bucket, count] of [['working', 7], ['results', 1], ['idle', 6]] as const) {
    const group = section(bucket), columns = Number(group.style.getPropertyValue('--focus-card-columns'))
    const cardWidth = (parseFloat(group.style.getPropertyValue('--focus-group-width')) - (columns - 1) * 2) / columns
    expect(cardWidth).toBeGreaterThanOrEqual(180); expect(cardWidth).toBeLessThanOrEqual(320)
    expect(group.querySelector('.focus-context-group__count')?.textContent).toBe(String(count))
    expect([...group.querySelectorAll<HTMLElement>('.focus-context')].map(node => node.dataset.sessionId)).toEqual(sessions.filter(session => bucket === 'working' ? session.id.startsWith('work-') : bucket === 'results' ? session.id === 'result' : session.id.startsWith('idle-')).map(session => session.id))
  }
  const rail = lane().querySelector<HTMLElement>('.focus-project-lanes__status-rail')!
  expect(rail).not.toBeNull(); expect([...rail.children].map(node => (node as HTMLElement).dataset.bucket)).toEqual(['attention', 'disconnected'])
  const zero = rail.querySelector<HTMLElement>('[data-bucket="attention"]')!
  expect(zero.title).toBe('Attention · 0'); expect(zero.getAttribute('aria-label')).toBe('Attention · 0')
  expect(zero.querySelector('svg')).not.toBeNull(); expect(zero.querySelector('button, .focus-context-group__count')).toBeNull()
  expect(rail.querySelector('.focus-disconnected-entry')?.getAttribute('aria-label')).toBe('View disconnected contexts · 2')
  expect(rail.querySelectorAll('.focus-context')).toHaveLength(0); expect(groups().querySelector('[data-bucket="disconnected"]')).toBeNull()
  const before = useAppStore.getState(), options = await focusFilterOptions(container, 'state')
  expect(options.map(option => option.text)).toEqual(['All states', 'Attention · 0', 'Working · 7', 'Results · 1', 'Activity unknown · 6', 'Disconnected · 2'])
  expect(useAppStore.getState().sessions.map(session => session.control)).toEqual(before.sessions.map(session => session.control))
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts); expect(listObservers()).toHaveLength(1)
  for (const budget of [912, 971, 972]) {
    width = budget; await act(async () => listObservers()[0]!.callback([], {} as ResizeObserver))
    expect(groups().dataset.focusCardSlots).toBe('5'); expect(groups().dataset.focusMaxRows).toBe('4')
    expect(['working', 'results', 'idle'].map(bucket => Number(section(bucket).style.getPropertyValue('--focus-card-columns')))).toEqual([2, 1, 2])
    expect(groups().querySelectorAll('.focus-context')).toHaveLength(14)
  }
})

it('keeps a single card bounded and returns from the exact disconnected title entry without empty body tracks', async () => {
  width = 2000; await seed([agent(A), agent('offline', 'disconnected')]); await mount()
  expect([...groups().children].map(node => (node as HTMLElement).dataset.bucket)).toEqual(['working'])
  expect(section('working').style.getPropertyValue('--focus-group-width')).toBe('320px')
  const original = card(), before = useAppStore.getState()
  width = 320; await act(async () => listObservers()[0]!.callback([], {} as ResizeObserver))
  expect(Number(section('working').style.getPropertyValue('--focus-card-columns'))).toBe(1)
  expect(parseFloat(section('working').style.getPropertyValue('--focus-group-width'))).toBeLessThanOrEqual(320)
  expect(card()).toBe(original); expect(lane().querySelector('.focus-project-lanes__axis')?.getAttribute('title')).toContain('长项目名')
  const entry = lane().querySelector<HTMLButtonElement>('.focus-disconnected-entry')!
  expect(entry).not.toBeNull(); expect(entry.disabled).toBe(false)
  await act(async () => { entry.focus(); entry.click() })
  const directory = container.querySelector<HTMLElement>('[aria-label="Disconnected projects"]')!
  expect(directory).not.toBeNull(); expect(directory.querySelectorAll('.focus-context')).toHaveLength(1)
  expect(directory.querySelector('.focus-context')?.getAttribute('data-session-id')).toBe('offline')
  await act(async () => directory.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })))
  expect(document.activeElement).toBe(entry); expect(card()).toBe(original)
  expect(useAppStore.getState().sessions).toBe(before.sessions); expect(useAppStore.getState().agentFocus).toBe(before.agentFocus)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
})

it('shows a complete wrapper body as the ordinary recap while raw aria/hover and unrecognized source bytes remain intact', async () => {
  const body = '已核 src/scroll-anchor.ts，保留原草稿与正文选区。'.repeat(20)
  const wrapped = ("[Message from Agent " + ('declared-'.repeat(25)) + ("]\n<bagakit-msg type=\"result\" name=\"Declared only\" time=\"" + _hygiene_fixtureIso(24112800000, "zone-second", 480) + "\">") + (body) + "</bagakit-msg>")
  expect(wrapped.length).toBeGreaterThan(800); expect(parseAgentMuxMessagePrefix(wrapped)?.body).toBe(body)
  await seed([agent(A)], { [A]: timeline(A, [message(A, 'assistant_message', wrapped, 2), tool(A)]) }); await mount()
  const original = useAppStore.getState().timelines[A]!
  expect(card().querySelector('.focus-context__recap > span')?.textContent).toBe(body)
  expect(card().querySelector('.focus-context__activity')).toBeNull()
  expect(card().getAttribute('aria-label')).toContain(excerpt(wrapped)); expect(card().getAttribute('aria-label')).toContain('Bash pnpm test --filter density')
  expect(card().querySelector('.focus-context__recap')?.getAttribute('title')).toBe('Last assistant message (timeline)')
  // HappyDOM does not compute this vendor property. The real CSS and real matching
  // Row seam are bound here; compiled captures own physical two-line readability.
  expect(style.textContent).toMatch(/\.focus-context__recap > span\s*\{[^}]*-webkit-line-clamp:\s*2\s*;/u)
  expect(api.sessions.historyPage).not.toHaveBeenCalled(); await open()
  expect(preview()?.querySelector('.focus-context-hover__recap p')?.textContent).toBe(excerpt(wrapped))
  expect(preview()?.textContent).toContain('Bash pnpm test --filter density'); expect(document.activeElement).toBe(input)
  expect(useAppStore.getState().timelines[A]).toBe(original); expect(original.items[0]!.content).toBe(wrapped); await escape()
  const unrecognized = [
    ("[Message from Agent declared]\n<bagakit-msg type=\"result\" name=\"Unknown\" time=\"" + _hygiene_fixtureIso(24141600000, "second") + "\"><unknown>原未知结构</unknown></bagakit-msg>"),
    ("[Message from Agent declared]\n<bagakit-msg type=\"result\" name=\"Incomplete\" time=\"" + _hygiene_fixtureIso(24141600000, "second") + "\">原未闭合结构"),
    ("```text\n[Message from Agent declared]\n<bagakit-msg type=\"result\" name=\"Code\" time=\"" + _hygiene_fixtureIso(24141600000, "second") + "\">原代码引用</bagakit-msg>\n```")
  ]
  for (const raw of unrecognized) {
    expect(parseAgentMuxMessagePrefix(raw)).toBeNull()
    await act(async () => useAppStore.setState({ timelines: { [A]: timeline(A, [message(A, 'assistant_message', raw, 2)]) } }))
    expect(card().querySelector('.focus-context__recap > span')?.textContent).toBe(excerpt(raw))
    expect(card().getAttribute('aria-label')).toContain(excerpt(raw)); expect(useAppStore.getState().timelines[A]!.items[0]!.content).toBe(raw)
  }
})

it('distinguishes idle completion without a result, unknown activity and a recorded result without changing state or selection identity', async () => {
  const sessions = [agent('idle-done', 'done'), agent('unknown', 'running', 'run-process'), agent('result', 'done')]
  await seed(sessions, { unknown: timeline('unknown', [message('unknown', 'assistant_message', 'Held reply, activity remains unknown', 2)]),
    result: timeline('result', [message('result', 'assistant_message', 'Recorded result', 2)]) }); await mount()
  expect(card('idle-done').dataset).toMatchObject({ state: 'done', bucket: 'idle', activity: 'idle' })
  expect(card('unknown').dataset).toMatchObject({ state: 'running', bucket: 'idle', activity: 'unknown' })
  expect(card('result').dataset).toMatchObject({ state: 'done', bucket: 'results', activity: 'idle' })
  expect(card('idle-done').querySelector('[data-focus-state-icon="idle"]')).not.toBeNull()
  expect(card('unknown').querySelector('[data-focus-state-icon="unknown"]')).not.toBeNull()
  expect(card('result').querySelector('[data-focus-state-icon="results"]')).not.toBeNull()
  expect(card('idle-done').querySelector('.status__dot')).toBeNull(); expect(card('unknown').querySelector('.status__dot')).toBeNull()
  expect(card('idle-done').textContent).toContain('No result observed'); expect(card('unknown').textContent).toContain('Held reply, activity remains unknown')
  expect(card('idle-done').matches(".focus-context[data-bucket='idle']")).toBe(true)
  expect(style.textContent).toMatch(/\.focus-context\[data-bucket='idle'\] \.focus-context__state\s*\{\s*color:\s*var\(--text-3\)\s*;/u)
  const controls = sessions.map(session => session.control), draft = useAppStore.getState().agentComposerDrafts
  await act(async () => card('unknown').click())
  expect(useAppStore.getState().agentFocus.execution.sessionId).toBe('unknown'); expect(card('unknown').getAttribute('aria-pressed')).toBe('true')
  expect(card('result').dataset.bucket).toBe('results'); expect(useAppStore.getState().sessions.map(session => session.control)).toEqual(controls)
  expect(useAppStore.getState().agentComposerDrafts).toBe(draft)
})

it('keeps pending, failure, connection and unconfirmed Mote service facts directly readable over retained recaps', async () => {
  const permission: Agent = { ...agent('permission'), pendingInteraction: { kind: 'permission', id: 'permission-request', agentSessionId: 'permission',
    title: 'Allow editing src/density.ts?', options: [{ id: 'once', label: 'Allow once', kind: 'allow-once' }],
    evidence: { source: 'native-hook', observedAt: 2, run: { runId: 'permission-original-run' } } } }
  const question: Agent = { ...agent('question'), pendingInteraction: { kind: 'question', id: 'question-request', agentSessionId: 'question',
    questions: [{ id: 'choice', prompt: 'Ship stable or canary?', options: [{ id: 'stable', label: 'Stable' }] }],
    evidence: { source: 'native-hook', observedAt: 2, run: { runId: 'question-original-run' } } } }
  const failure = { ...agent('failure', 'error'), status: { state: 'error' as const, source: 'native-hook' as const, observedAt: 2, detail: 'Attachment failed; original Run retained' } }
  const connection = { ...agent('connection', 'disconnected'), processState: 'running' as const,
    status: { state: 'disconnected' as const, source: 'native-hook' as const, observedAt: 2, detail: 'Connection lost; current execution unconfirmed' } }
  const mote = { ...agent('unconfirmed', 'running', 'run-process'), workspacePath: _hygiene_fixturePath("unconfirmed-mote/topic--launcher--unconfirmed") }
  const sessions = [permission, question, failure, connection, mote]
  await seed(sessions, Object.fromEntries(sessions.map(session => [session.id, timeline(session.id, [message(session.id, 'assistant_message', 'Old recap remains held', 2)])])))
  await act(async () => useAppStore.setState(state => ({ config: { ...state.config!, workspaces: [...state.config!.workspaces,
    { id: '__scratch__', name: 'Topics', hostId: 'local', kind: 'folder', path: _hygiene_fixturePath("unconfirmed-mote") }] } })))
  await mount(); expect(board().querySelectorAll('.focus-context')).toHaveLength(5)
  for (const [id, detail] of [['permission', 'Allow editing src/density.ts?'], ['question', 'Ship stable or canary?'],
    ['failure', 'Attachment failed; original Run retained'], ['connection', 'Connection lost; current execution unconfirmed']] as const) {
    expect(card(id).querySelector('.focus-context__detail')?.textContent).toBe(detail)
    expect(card(id).querySelector('.focus-context__recap')).toBeNull(); expect(card(id).getAttribute('aria-label')).toContain('Old recap remains held')
  }
  expect(card('permission').dataset.bucket).toBe('attention'); expect(card('question').dataset.bucket).toBe('attention')
  expect(card('failure').dataset.bucket).toBe('attention'); expect(card('connection').closest('[data-bucket="idle"]')).not.toBeNull()
  expect(card('unconfirmed').querySelector('.focus-context__recap')?.textContent).toBe('Old recap remains held')
  expect(card('unconfirmed').querySelector('.focus-context__activity')?.textContent).toContain('Mote identity is not confirmed')
  expect(card('unconfirmed').getAttribute('aria-label')).toContain('Mote identity is not confirmed')
  expect(sessions.every(session => !card(session.id).disabled)).toBe(true)
  expect(useAppStore.getState().sessions.map(session => session.control)).toEqual(sessions.map(session => session.control))
})

it('keeps irrelevant churn dormant, preserves the latest three hover inputs and rejects a reflow click on another SID', async () => {
  const captured = Array.from({ length: 4 }, (_, i) => ({ ...message(A, 'user_message', `Request ${i}`, i + 1), source: 'user' as const, authorHuman: true }))
  await seed([agent(A), agent(B)], { [A]: timeline(A, [...captured, message(A, 'assistant_message', 'Original response', 10)]) })
  vi.mocked(api.sessions.historyPage).mockResolvedValue(page(A, [{ id: 'native', kind: 'user-message', startedAt: 2.5, contentParts: [{ kind: 'text', text: 'Native input' }] }]))
  await mount(); expect(api.workspaces.listBranches).toHaveBeenCalled(); expect(api.workspaces.appearance).toHaveBeenCalled()
  expect(renders.cards[A]).toBeGreaterThan(0); expect(renders.cards[B]).toBeGreaterThan(0)
  const allocate = vi.spyOn(allocation, 'allocateFocusLaneColumns'), partition = vi.spyOn(projection, 'groupFocusContexts')
  const timelineRead = vi.spyOn(api.sessions, 'timeline'), catalog = vi.spyOn(api.sessions, 'historySources')
  const branchReads = vi.mocked(api.workspaces.listBranches).mock.calls.length, iconReads = vi.mocked(api.workspaces.appearance).mock.calls.length
  const original = card(), sibling = card(B), before = useAppStore.getState(); await open()
  await act(async () => vi.waitFor(() => expect(preview()!.querySelectorAll('[data-hover-input-id]')).toHaveLength(3)))
  expect([...preview()!.querySelectorAll<HTMLElement>('[data-hover-input-id]')].map(node => node.dataset.hoverInputId)).toEqual([
    `native:claude:${A}-native:native`, `captured:${A}-user_message-3`, `captured:${A}-user_message-4`
  ])
  expect(preview()!.textContent).toContain('Original response'); expect(api.sessions.historyPage).toHaveBeenCalledExactlyOnceWith(before.sessions[0]!.control, { limit: 30 })
  const reply = preview()!.querySelector('.focus-context-hover__recap p')!, range = document.createRange(); range.selectNodeContents(reply)
  window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range)
  const counts = { ...renders.cards }, reads = vi.mocked(api.sessions.historyPage).mock.calls.length
  for (let i = 0; i < 20; i++) await act(async () => useAppStore.setState(state => ({
    sessions: state.sessions.map(session => ({ ...session, latestOutputBytes: session.latestOutputBytes + 1, status: { ...session.status, observedAt: session.status.observedAt + 1 } })),
    agentNames: { ...state.agentNames, 'not-a-context': `Unrelated ${i}` }
  })))
  expect(allocate).not.toHaveBeenCalled(); expect(partition).not.toHaveBeenCalled(); expect(renders.cards).toEqual(counts)
  expect(api.workspaces.listBranches).toHaveBeenCalledTimes(branchReads); expect(api.workspaces.appearance).toHaveBeenCalledTimes(iconReads)
  expect(timelineRead).not.toHaveBeenCalled(); expect(catalog).not.toHaveBeenCalled(); expect(api.sessions.historyPage).toHaveBeenCalledTimes(reads)
  expect(card()).toBe(original); expect(card(B)).toBe(sibling); expect(preview()!.querySelector('.focus-context-hover__recap p')).toBe(reply)
  expect(window.getSelection()!.toString()).toBe('Original response'); expect(document.activeElement).toBe(input)
  expect([input.selectionStart, input.selectionEnd]).toEqual([2, 8]); expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  await escape(); await act(async () => original.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })))
  width = 320; await act(async () => listObservers()[0]!.callback([], {} as ResizeObserver))
  expect(allocate).toHaveBeenCalled(); expect(partition).toHaveBeenCalled()
  await act(async () => sibling.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })))
  expect(useAppStore.getState().agentFocus.execution.sessionId).toBeNull()
  await act(async () => { sibling.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })); sibling.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })) })
  expect(useAppStore.getState().agentFocus.execution.sessionId).toBe(B)
  const activeObserver = listObservers().find(observer => observer.disconnect.mock.calls.length === 0)!
  expect(activeObserver).toBeDefined(); await act(async () => root!.render(<GlobalFocusSurface visible={false} />))
  expect(activeObserver.disconnect).toHaveBeenCalledOnce(); expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
})
