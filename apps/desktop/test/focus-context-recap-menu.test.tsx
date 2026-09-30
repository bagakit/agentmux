// @vitest-environment happy-dom
import { act, createElement, memo, Profiler } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentTimelineItem, AgentTimelineSnapshot } from '@agentmux/core'
import type { SessionSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createFocusProjectionSelector } from '../src/renderer/src/lib/focus-context'
import { formatSessionAddress } from '../src/renderer/src/lib/agent-address'
import { chooseFocusFilter } from './fixtures/focus-filter-menu'

const commits = vi.hoisted(() => ({ rows: {} as Record<string, number> }))
vi.mock('../src/renderer/src/components/FocusContextRow', async original => {
  const actual = await original<typeof import('../src/renderer/src/components/FocusContextRow')>()
  return { FocusContextRow: memo((props: Parameters<typeof actual.FocusContextRow>[0]) => createElement(Profiler, { id: props.context.id, onRender: id => { commits.rows[id] = (commits.rows[id] ?? 0) + 1 } }, createElement(actual.FocusContextRow, props))) }
})
// Original Global/Store/projection/Row/menu/copy loaded; unrelated PTY/avatar paint and hierarchy I/O isolated.
vi.mock('../src/renderer/src/components/AgentAvatar', () => ({ AgentAvatar: () => createElement('span', { 'data-isolated-avatar-paint': true }) }))
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
vi.mock('../src/renderer/src/lib/use-focus-hierarchy', () => ({ useFocusHierarchy: () => ({ facts: { topics: {}, worktrees: [] }, errors: [] }) }))
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'

const initial = useAppStore.getState(), firstId = 'recap-exact-a', secondId = 'recap-exact-b'
const requestText = '核对滚动锚点与窄窗口正文', responseText = '已修复锚点，正在核对窄窗口的正文和关闭按钮。'
let root: Root, container: HTMLDivElement, agent: Extract<SessionSnapshot, { kind: 'agent' }>
const message = (kind: 'user_message' | 'assistant_message', content: string, time: number): AgentTimelineItem => ({ id: `${kind}-${time}`, agentSessionId: firstId, kind, status: 'complete', source: 'native-hook', title: kind, content, createdAt: time, updatedAt: time })
const tool: AgentTimelineItem = { id: 'tool-3', agentSessionId: firstId, kind: 'tool_call', status: 'complete', source: 'native-hook', title: 'Bash', toolName: 'Bash', toolInput: JSON.stringify({ command: 'pnpm test --filter scroll-anchor' }), createdAt: 3, updatedAt: 3 }
const items = [message('user_message', requestText, 1), message('assistant_message', responseText, 2), tool]
const timeline = (recorded: AgentTimelineItem[] = items): AgentTimelineSnapshot => ({ agentSessionId: firstId, revision: recorded.length, items: recorded })
const row = (id = firstId) => { const node = container.querySelector<HTMLButtonElement>(`.focus-context[data-session-id="${id}"]`); expect(node).not.toBeNull(); return node! }
const recapLine = () => { const node = row().querySelector<HTMLElement>('.focus-context__recap'); expect(node).not.toBeNull(); return node! }
const menu = () => { const node = document.querySelector<HTMLElement>('.focus-context-menu[role="menu"]'); expect(node).not.toBeNull(); return node! }
const action = (label: string) => { const node = [...menu().querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.trim() === label); expect(node).toBeDefined(); return node! }
async function mount() { await act(async () => root.render(createElement(GlobalFocusSurface))) }
async function update(patch: Partial<typeof agent>) { await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === firstId ? { ...session, ...patch } as SessionSnapshot : session) }))) }
async function open(id = secondId, keyboard = false) {
  await act(async () => {
    if (keyboard) { row(id).focus(); row(id).dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })) }
    else row(id).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 12 }))
  })
  await act(async () => vi.waitFor(() => expect(document.querySelector('.focus-context-menu [role="menuitem"]')).not.toBeNull()))
  expect(menu().dataset.agentSessionId).toBe(id)
}
async function choose(label: string) {
  await act(async () => action(label).click())
  // The real Radix close completes after selection; reopen only after its original menu leaves.
  await act(async () => vi.waitFor(() => expect(document.querySelector('.focus-context-menu')).toBeNull()))
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); commits.rows = {}
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  const config = await api.config.get(), snapshot = await api.sessions.snapshot(), base = snapshot.sessions.find(session => session.kind === 'agent')
  expect(base).toBeDefined()
  agent = { ...base!, id: firstId, hostId: 'local', workspacePath: '/recap/repo', status: { state: 'working', source: base!.status.source, observedAt: 1 }, control: { ...base!.control, agentSessionId: firstId } } as typeof agent
  useAppStore.setState({ config: { ...config, workspaces: [{ id: 'recap-repo', name: 'Recap Project', kind: 'folder', hostId: 'local', path: '/recap/repo' }] }, sessions: [agent, { ...agent, id: secondId, control: { ...agent.control, agentSessionId: secondId } }], timelines: { [firstId]: timeline() }, agentNames: { [firstId]: '同名 Agent', [secondId]: '同名 Agent' }, scratchTopicSnapshots: {}, tabs: {}, layouts: {}, providerCatalog: [], mainSurface: 'agents', agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } }, agentComposerDrafts: { [secondId]: '原草稿仍可继续' } })
})
afterEach(async () => {
  await act(async () => root.unmount())
  // Radix FocusScope deliberately schedules its unmount restoration at timeout 0.
  // Drain that original cleanup before starting a different mounted fixture.
  await act(async () => new Promise<void>(resolve => setTimeout(resolve, 0)))
  document.body.replaceChildren(); useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it('shows the existing labelled recap together with a newer concrete tool without reading history', async () => {
  const native = vi.spyOn(api.sessions, 'historyPage'), reread = vi.spyOn(api.sessions, 'timeline')
  await mount(); expect(container.querySelectorAll('.focus-context')).toHaveLength(2)
  expect(recapLine().textContent).toBe(responseText)
  expect(recapLine().getAttribute('title')).toBe('Last assistant message (timeline)')
  expect(row().querySelector('.focus-context__activity')!.textContent).toBe('Bash pnpm test --filter scroll-anchor')
  expect(row().dataset.bucket).toBe('working'); expect(native.mock.calls).toEqual([]); expect(reread.mock.calls).toEqual([])
})
it('falls back to the recorded request while empty facts keep the existing honest work detail', async () => {
  await act(async () => useAppStore.setState({ timelines: { [firstId]: timeline([message('user_message', requestText, 1), tool]) } }))
  await mount(); expect(recapLine().textContent).toBe(requestText)
  expect(row().getAttribute('aria-label')).toContain('Last prompt (timeline)')
  expect(row(secondId).querySelector('.focus-context__recap')).toBeNull()
  expect(row(secondId).querySelector('.focus-context__detail')!.textContent).toBe('No activity details observed')
})
it('labels an old reply as an excerpt without making the next request a current result', async () => {
  await update({ status: { ...agent.status, state: 'done' } })
  await act(async () => useAppStore.setState({ timelines: { [firstId]: timeline([message('assistant_message', responseText, 2), message('user_message', '继续检查加载', 4)]) } }))
  await mount(); expect(row().dataset.bucket).toBe('idle'); expect(row().getAttribute('aria-label')).toContain('Last assistant message (timeline)')
  expect(row().querySelector('.focus-context__activity')).not.toBeNull()
  expect(row().querySelector('.focus-context__activity')!.textContent).toBe('Prompt · 继续检查加载')
  expect(row().getAttribute('aria-label')).toContain('Prompt · 继续检查加载')
})
it('keeps a legitimate retained result excerpt when the process is no longer running', async () => {
  await update({ processState: 'exited', status: { ...agent.status, state: 'done' } })
  await act(async () => useAppStore.setState({ timelines: { [firstId]: timeline(items.slice(0, 2)) } }))
  await mount(); expect(row().dataset.bucket).toBe('results')
  expect(recapLine().textContent).toBe(responseText)
  expect(row().querySelector('.focus-context__activity')).toBeNull()
  expect(row().getAttribute('aria-label')).toContain('Last assistant message (timeline)')
})
it('retains the unconfirmed directory service explanation beside a previously observed reply', async () => {
  await act(async () => useAppStore.setState(state => ({
    config: { ...state.config!, workspaces: [{ id: '__scratch__', name: 'Topics', hostId: 'local', kind: 'folder', path: '/unconfirmed-mote' }] },
    sessions: [{ ...agent, workspacePath: '/unconfirmed-mote/topic--launcher--unconfirmed', status: { ...agent.status, state: 'running' } }],
    scratchTopicSnapshots: {}, timelines: { [firstId]: timeline([message('assistant_message', responseText, 2)]) }
  })))
  await mount(); expect(recapLine().textContent).toBe(responseText)
  const service = row().querySelector('.focus-context__activity'); expect(service).not.toBeNull()
  expect(service!.textContent).toContain('Mote identity is not confirmed')
  expect(row().getAttribute('aria-label')).toContain('Mote identity is not confirmed')
})
it.each([
  ['permission', { pendingInteraction: { id: 'p', kind: 'permission', title: 'Allow editing src/scroll.ts?', operation: 'edit' } }, 'Allow editing src/scroll.ts?'],
  ['question', { pendingInteraction: { id: 'q', kind: 'question', questions: [{ id: 'choice', title: 'Release', prompt: 'Ship stable or canary?', options: [] }] } }, 'Ship stable or canary?'],
  ['failure', { status: { state: 'error', source: 'native-hook', observedAt: 2, detail: 'History reader unavailable; original Run retained' } }, 'History reader unavailable; original Run retained'],
  ['connection', { status: { state: 'disconnected', source: 'native-hook', observedAt: 2, detail: 'Connection lost; current execution unconfirmed' } }, 'Connection lost; current execution unconfirmed']
] as const)('keeps the actual %s directly readable above an old recap', async (_kind, patch, expected) => {
  await update(patch as unknown as Partial<typeof agent>); await mount()
  expect(row().querySelector('.focus-context__recap')).toBeNull()
  expect(row().querySelector('.focus-context__detail')!.textContent).toBe(expected)
  expect(row().getAttribute('title')).toContain(responseText)
})
it('copies the exact second same-name Session with no guessed Region or lifecycle action', async () => {
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined), source = useAppStore.getState()
  await mount(); await open()
  expect([...menu().querySelectorAll('[role="menuitem"]')].map(node => node.textContent?.trim())).toEqual(['Message this Agent', 'Copy Session Address'])
  await choose('Copy Session Address'); expect(copy).toHaveBeenCalledExactlyOnceWith(formatSessionAddress(secondId))
  expect(copy.mock.calls[0]![0]).not.toContain('region:'); expect(useAppStore.getState().agentFocus).toBe(source.agentFocus)
  expect(useAppStore.getState().sessions).toBe(source.sessions); expect(useAppStore.getState().agentComposerDrafts).toBe(source.agentComposerDrafts)
})
it('opens with Shift+F10, uses the same messaging address and returns Escape to the exact trigger', async () => {
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await mount(); await open(secondId, true); await choose('Message this Agent')
  expect(copy).toHaveBeenCalledExactlyOnceWith(formatSessionAddress(secondId))
  await act(async () => vi.waitFor(() => expect(document.activeElement).toBe(row(secondId))))
  await open(secondId, true); await act(async () => menu().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  await act(async () => vi.waitFor(() => expect(document.querySelector('.focus-context-menu')).toBeNull()))
  await act(async () => vi.waitFor(() => expect(document.activeElement).toBe(row(secondId))))
})
it('reports a clipboard failure through the original shared error owner without losing the draft', async () => {
  vi.spyOn(api.ui, 'writeClipboardText').mockRejectedValue(new Error('Clipboard denied: private probe'))
  const before = useAppStore.getState(); await mount(); await open(); await choose('Copy Session Address')
  expect(useAppStore.getState().error).toContain('Clipboard denied: private probe')
  expect(useAppStore.getState().sessions).toBe(before.sessions); expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
})
it('does not take focus back from a later explicit input', async () => {
  await mount(); await open(secondId, true)
  const input = document.createElement('input'); input.setAttribute('aria-label', 'Later user input'); container.append(input)
  await act(async () => input.focus()); await act(async () => vi.waitFor(() => expect(document.querySelector('.focus-context-menu')).toBeNull()))
  await act(async () => vi.waitFor(() => expect(document.activeElement).toBe(input)))
})
it('searches recap-only text through the original AND filters without extra reads', async () => {
  await mount(); const native = vi.spyOn(api.sessions, 'historyPage'), reread = vi.spyOn(api.sessions, 'timeline')
  const search = container.querySelector<HTMLInputElement>('[aria-label="Search contexts"]'); expect(search).not.toBeNull()
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search!, '关闭按钮'); search!.dispatchEvent(new Event('input', { bubbles: true })) })
  expect([...container.querySelectorAll<HTMLElement>('.focus-context')].map(node => node.dataset.sessionId)).toEqual([firstId])
  await chooseFocusFilter(container, 'state', 'results'); expect(container.querySelectorAll('.focus-context')).toHaveLength(0)
  await chooseFocusFilter(container, 'state', 'working'); expect([...container.querySelectorAll<HTMLElement>('.focus-context')].map(node => node.dataset.sessionId)).toEqual([firstId])
  expect(native.mock.calls).toEqual([]); expect(reread.mock.calls).toEqual([])
})
it('keeps retained Row nodes and controls through 200 irrelevant byte and observation updates', async () => {
  await mount(); const before = { ...commits.rows }, nodes = [row(), row(secondId)], controls = useAppStore.getState().sessions.map(session => session.control)
  expect(Object.keys(before).sort()).toEqual([firstId, secondId])
  const native = vi.spyOn(api.sessions, 'historyPage'), reread = vi.spyOn(api.sessions, 'timeline'), appearances = vi.spyOn(api.workspaces, 'appearance')
  for (let index = 0; index < 200; index += 1) await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => ({ ...session, latestOutputBytes: session.latestOutputBytes + 1, status: { ...session.status, observedAt: index + 10 } })) })))
  expect(commits.rows).toEqual(before); expect([row(), row(secondId)]).toEqual(nodes); expect(useAppStore.getState().sessions.map(session => session.control)).toEqual(controls)
  expect(native.mock.calls).toEqual([]); expect(reread.mock.calls).toEqual([]); expect(appearances.mock.calls).toEqual([])
})
it('only derives related nonempty bounded conversations at both qualified input sizes', () => {
  for (const [sessionsCount, projectsCount] of [[14, 54], [112, 432]] as const) {
    const reads: Record<string, number> = {}, select = createFocusProjectionSelector(), config = useAppStore.getState().config!
    const sessions = Array.from({ length: sessionsCount }, (_, index) => ({ ...agent, id: `cost-${index}` }))
    const timelines = Object.fromEntries(sessions.map(session => [session.id, new Proxy({ ...timeline(), agentSessionId: session.id }, { get(target, key, receiver) { if (key === 'items') reads[session.id] = (reads[session.id] ?? 0) + 1; return Reflect.get(target, key, receiver) } })]))
    const input = { sessions, timelines, agentNames: {}, scratchTopicSnapshots: {}, config: { ...config, workspaces: Array.from({ length: projectsCount }, (_, index) => ({ id: `project-${index}`, name: `Project ${index}`, hostId: 'local', path: index === 0 ? agent.workspacePath : `/unrelated-${index}`, kind: 'folder' as const })) } }
    const before = select(input); expect(before.contexts).toHaveLength(sessionsCount); expect(before.contexts[0]!.recap?.text).toBe(responseText)
    Object.keys(reads).forEach(key => delete reads[key]); expect(select({ ...input })).toBe(before); expect(reads).toEqual({})
    const after = select({ ...input, agentNames: { 'cost-0': 'Only this name changes' } })
    expect(after.contexts[0]!.name).toBe('Only this name changes'); expect(after.contexts.slice(1)).toEqual(before.contexts.slice(1)); expect(after.laneContexts).toBe(before.laneContexts)
    expect(Object.keys(reads)).toEqual(['cost-0']); expect(reads['cost-0']).toBeGreaterThan(0)
  }
})
