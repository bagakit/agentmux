import { fixturePath as _hygiene_fixturePath, fixtureYear as _hygiene_fixtureYear } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SessionSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { chooseFocusFilter } from './fixtures/focus-filter-menu'

// Real Global/Store/fact projection, directory, Row, menu and hierarchy.
// The separate timeline reader and PTY paint are outside this directory oracle.
vi.mock('../src/renderer/src/components/RecentFocusTimeline', () => ({ RecentFocusTimeline: () => null }))
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
const initial = useAppStore.getState()
let root: Root, container: HTMLDivElement, base: Extract<SessionSnapshot, { kind: 'agent' }>
function session(id: string, state: SessionSnapshot['status']['state'] = 'disconnected', processState: SessionSnapshot['processState'] = 'interrupted', workspacePath = _hygiene_fixturePath("repo")) {
  return { ...base, id, workspacePath, processState, status: { ...base.status, state }, control: { ...base.control, agentSessionId: id, run: { ...base.control.run, runId: `retained-${id}` } } }
}
const directory = () => container.querySelector<HTMLElement>('.focus-disconnected-projects')!
const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text) ?? null
const rows = () => [...directory().querySelectorAll<HTMLButtonElement>('.focus-context')]
const row = (id: string) => container.querySelector<HTMLButtonElement>(`.focus-context[data-session-id="${id}"]`)!
const mount = () => act(async () => root.render(createElement(GlobalFocusSurface)))
async function search(value: string) {
  const input = container.querySelector<HTMLInputElement>('[aria-label="Search contexts"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function click(node: HTMLElement) { expect(node).not.toBeNull(); await act(async () => node.click()) }
async function reveal() {
  const trigger = container.querySelector<HTMLButtonElement>('[data-bucket="disconnected"] .focus-disconnected-entry')!
  expect(trigger).not.toBeNull(); await act(async () => { trigger.focus(); trigger.click() }); return trigger
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  HTMLElement.prototype.scrollIntoView = vi.fn()
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  const config = await api.config.get(), snapshot = await api.sessions.snapshot()
  const found = snapshot.sessions.find((item): item is typeof base => item.kind === 'agent'); expect(found).toBeDefined(); base = found!
  vi.spyOn(api.workspaces, 'listBranches').mockImplementation(async id => ({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: id === 'repo' ? _hygiene_fixturePath("repo") : _hygiene_fixturePath("earlier") }))
  vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'repository', icon: null })
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([])
  useAppStore.setState({ config: { ...config, workspaces: [{ id: 'repo', name: 'Product', hostId: 'local', path: _hygiene_fixturePath("repo"), kind: 'folder' }, { id: 'earlier', name: 'Earlier project', hostId: 'local', path: _hygiene_fixturePath("earlier"), kind: 'folder' }] }, mainSurface: 'agents',
    sessions: [session('retained-one'), session('retained-two', 'disconnected', 'interrupted', _hygiene_fixturePath("earlier"))], timelines: {}, tabs: {}, layouts: {}, providerCatalog: [], agentNames: { 'retained-one': 'Fix terminal reading', 'retained-two': 'Research directory design' }, scratchTopicSnapshots: {}, spaceObjectIcons: {}, workspaceFileRevisions: {},
    agentComposerDrafts: { 'retained-one': 'keep the original draft' }, agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } })
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('opens a full directory on the first all-offline render without returning to an empty board', async () => {
  await mount(); expect(directory()).not.toBeNull(); expect(directory().dataset.expanded).toBe('true')
  expect(rows().map(node => node.dataset.sessionId).sort()).toEqual(['retained-one', 'retained-two'])
  expect(rows().every(node => node.classList.contains('focus-context--directory'))).toBe(true)
  expect(button('Return to board')).toBeNull()
  expect(useAppStore.getState().agentFocus.execution.sessionId).toBeNull()
})
it('keeps mixed offline in its compact rail until explicitly entering the same full directory', async () => {
  await act(async () => useAppStore.setState(state => ({ sessions: [...state.sessions, session('live', 'working', 'running')], agentNames: { ...state.agentNames, live: 'Continue working' } })))
  await mount(); expect(directory().dataset.expanded).not.toBe('true'); expect(row('live')).not.toBeNull()
  expect(container.querySelector('[data-bucket="disconnected"] .focus-context')).toBeNull()
  await reveal(); expect(directory().dataset.expanded).toBe('true'); expect(rows()).toHaveLength(2)
  expect(container.querySelector<HTMLElement>('.focus-project-board__live')!.hidden).toBe(true)
  expect(button('Return to board')).not.toBeNull()
})
it('filters the directory by the original global query and exposes a useful zero-match action', async () => {
  await act(async () => useAppStore.setState(state => ({ sessions: [...state.sessions, session('same-project', 'disconnected', 'interrupted', _hygiene_fixturePath("earlier"))], agentNames: { ...state.agentNames, 'same-project': 'Check untouched work' } })))
  await mount(); await search('directory design'); expect(rows().map(node => node.dataset.sessionId)).toEqual(['retained-two'])
  await search('no-such-context'); expect(rows()).toHaveLength(0); expect(directory().textContent).toContain('No matching')
  await click(button('Clear filters')!); expect(rows()).toHaveLength(3)
})
it('honours project and state filtering while full offline ownership and totals remain unchanged', async () => {
  await mount(); await chooseFocusFilter(container, 'project', 'earlier'); expect(rows().map(node => node.dataset.sessionId)).toEqual(['retained-two'])
  await chooseFocusFilter(container, 'state', 'working'); expect(rows()).toHaveLength(0)
  await click(button('Clear filters')!); expect(rows()).toHaveLength(2)
  expect(useAppStore.getState().sessions).toHaveLength(2)
})
it('makes the original observed recap and its provenance readable with a truthful activity time', async () => {
  const time = Date.UTC(_hygiene_fixtureYear, 9, 5, 12, 15)
  await act(async () => useAppStore.setState({ timelines: { 'retained-one': { agentSessionId: 'retained-one', revision: 1, items: [{ id: 'reply', agentSessionId: 'retained-one', kind: 'assistant_message', status: 'complete', source: 'native-hook', createdAt: time, updatedAt: time, title: 'Response', content: 'Verified scroll continuity while keeping the same Session.' }] } } }))
  await mount(); const actual = row('retained-one'); expect(actual.textContent).toContain('Verified scroll continuity')
  expect(actual.querySelector('.focus-context__excerpt-source')?.textContent).toContain('Last assistant message · timeline')
  expect(actual.querySelector('time')?.getAttribute('dateTime')).toBe(new Date(time).toISOString())
  expect(row('retained-two').querySelector('time')).toBeNull()
})
it('does not classify a running Agent with a lost observation connection as offline', async () => {
  await act(async () => useAppStore.setState({ sessions: [session('healthy', 'disconnected', 'running')] })); await mount()
  expect(container.querySelector('.focus-disconnected-projects')).toBeNull()
  expect(row('healthy').closest('[data-bucket="idle"]')).not.toBeNull(); expect(row('healthy').classList.contains('focus-context--directory')).toBe(false)
})
it('keeps concrete interrupted permission and actual error in Attention', async () => {
  await act(async () => useAppStore.setState({ sessions: [{ ...session('request'), pendingInteraction: { id: 'permission', kind: 'permission', title: 'Allow editing scroll.ts?', operation: 'edit' } as never }, session('failed', 'error', 'exited')] })); await mount()
  expect(container.querySelector('.focus-disconnected-projects')).toBeNull()
  expect(row('request').closest('[data-bucket="attention"]')).not.toBeNull(); expect(row('failed').closest('[data-bucket="attention"]')).not.toBeNull()
})
it('preserves the original board node and returns keyboard focus to the exact lane entry', async () => {
  await act(async () => useAppStore.setState(state => ({ sessions: [...state.sessions, session('live', 'working', 'running')] })))
  await mount(); const original = row('live'), trigger = await reveal()
  await act(async () => row('retained-one').focus())
  await act(async () => directory().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(row('live')).toBe(original); expect(container.querySelector<HTMLElement>('.focus-project-board__live')!.hidden).toBe(false)
  expect(document.activeElement).toBe(trigger)
})
it('does not steal a later deliberate focus when closing the offline directory', async () => {
  await act(async () => useAppStore.setState(state => ({ sessions: [...state.sessions, session('live', 'working', 'running')] })))
  await mount(); await reveal(); const input = document.createElement('input'); document.body.append(input)
  try { await act(async () => input.focus()); await click(button('Return to board')!); expect(document.activeElement).toBe(input) } finally { input.remove() }
})
it('uses the original navigation without replacing Session, controls, tabs or unsent drafts', async () => {
  const start = useAppStore.getState(), launches = vi.spyOn(api.sessions, 'launchAgent'), resumes = vi.spyOn(api.sessions, 'resume'), stops = vi.spyOn(api.sessions, 'stop')
  await mount(); await click(row('retained-one'))
  const current = useAppStore.getState(); expect(current.agentFocus.execution.sessionId).toBe('retained-one')
  expect(current.sessions).toBe(start.sessions); expect(current.tabs).toBe(start.tabs); expect(current.agentComposerDrafts).toBe(start.agentComposerDrafts)
  expect(current.sessions.map(item => item.control)).toEqual(start.sessions.map(item => item.control)); expect(launches).not.toHaveBeenCalled(); expect(resumes).not.toHaveBeenCalled(); expect(stops).not.toHaveBeenCalled()
})
it('does not add history or hierarchy reads when unrelated output bytes change', async () => {
  const history = vi.spyOn(api.sessions, 'historyPage'), timeline = vi.spyOn(api.sessions, 'timeline')
  await mount(); const original = row('retained-one'), branches = vi.mocked(api.workspaces.listBranches).mock.calls.length, icons = vi.mocked(api.workspaces.appearance).mock.calls.length
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(item => ({ ...item, latestOutputBytes: item.latestOutputBytes + 20, status: { ...item.status, observedAt: 500 } })) })))
  expect(row('retained-one')).toBe(original); expect(history).not.toHaveBeenCalled(); expect(timeline).not.toHaveBeenCalled(); expect(api.workspaces.listBranches).toHaveBeenCalledTimes(branches); expect(api.workspaces.appearance).toHaveBeenCalledTimes(icons)
})
