import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SessionSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'

// Keep the actual Store, classification, lane, count entry and retained directory.
// PTY painting and the separate timeline are outside this presentation refinement.
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
vi.mock('../src/renderer/src/components/RecentFocusTimeline', () => ({ RecentFocusTimeline: () => null }))

const initial = useAppStore.getState()
let root: Root, container: HTMLDivElement, base: Extract<SessionSnapshot, { kind: 'agent' }>
const agent = (id: string, offline = false) => ({ ...base, id, workspacePath: _hygiene_fixturePath("repo"),
  processState: offline ? 'interrupted' as const : 'running' as const,
  status: { ...base.status, state: offline ? 'disconnected' as const : 'working' as const },
  control: { ...base.control, agentSessionId: id, run: { runId: 'original-' + id } } })

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.defineProperty(Element.prototype, 'scrollIntoView', { value: vi.fn(), configurable: true })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  const config = await api.config.get(), snapshot = await api.sessions.snapshot()
  const found = snapshot.sessions.find((session): session is typeof base => session.kind === 'agent')
  expect(found).toBeDefined(); base = found!
  vi.spyOn(api.workspaces, 'listBranches').mockResolvedValue({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: _hygiene_fixturePath("repo") })
  vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'repository', icon: null })
  useAppStore.setState({ config: { ...config, workspaces: [{ id: 'repo', name: 'Product', hostId: 'local', path: _hygiene_fixturePath("repo"), kind: 'folder' }] },
    mainSurface: 'agents', sessions: [agent('working')], timelines: {}, tabs: {}, providerCatalog: [], agentNames: {},
    spaceObjectIcons: {}, workspaceFileRevisions: {}, scratchTopicSnapshots: {},
    agentComposerDrafts: { working: 'Original unsent draft' }, agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } })
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const mount = () => act(async () => root.render(createElement(GlobalFocusSurface)))
const groups = () => container.querySelector<HTMLElement>('.focus-project-board__live > .focus-project-lanes .focus-project-lanes__groups')!
const section = (state: string) => groups().querySelector<HTMLElement>(`[data-bucket="${state}"]`)!

it('zero states are icon-only while positive badges retain exact counts, stable order and the original card', async () => {
  await mount()
  expect(groups(), container.innerHTML).not.toBeNull()
  expect([...groups().children].map(node => (node as HTMLElement).dataset.bucket)).toEqual(['attention', 'working', 'results', 'idle', 'disconnected'])
  for (const state of ['attention', 'results', 'idle', 'disconnected']) {
    const group = section(state), header = group.querySelector<HTMLElement>('header')!
    expect(group.dataset.empty).toBe('true'); expect(header.querySelector('svg')).not.toBeNull()
    expect(header.querySelector('.focus-context-group__count')).toBeNull()
    expect(header.title).toContain('0'); expect(header.getAttribute('aria-label')).toContain('0')
    expect(group.querySelectorAll('button')).toHaveLength(state === 'disconnected' ? 1 : 0)
  }
  const working = section('working'), header = working.querySelector<HTMLElement>('header')!
  expect(header.querySelector('.focus-context-group__count')?.textContent).toBe('1')
  expect(header.title).toBe('Working · 1')
  const original = working.querySelector('[data-session-id="working"]')
  expect(original).not.toBeNull()
  await act(async () => useAppStore.setState({ sessions: [agent('working'), ...Array.from({ length: 100 }, (_, i) => agent('work-' + i))] }))
  expect(header.querySelector('.focus-context-group__count')?.textContent).toBe('99+')
  expect(header.title).toBe('Working · 101'); expect(header.getAttribute('aria-label')).toBe('Working · 101')
  expect(working.querySelector('[data-session-id="working"]')).toBe(original)
  expect(working.querySelectorAll('.focus-context')).toHaveLength(101)
  expect(useAppStore.getState().agentComposerDrafts.working).toBe('Original unsent draft')
})

it('disconnected badges stay bounded without losing exact hover facts, directory navigation or Return', async () => {
  await act(async () => useAppStore.setState({ sessions: [agent('working'), ...Array.from({ length: 105 }, (_, i) => agent('offline-' + i, true))] }))
  await mount()
  const state = useAppStore.getState(), group = section('disconnected'), entry = group.querySelector<HTMLButtonElement>('.focus-disconnected-entry')!
  expect(entry).not.toBeNull(); expect(entry.disabled).toBe(false)
  expect(entry.querySelector('.focus-context-group__count')?.textContent).toBe('99+')
  expect(entry.title).toBe('Disconnected · 105'); expect(entry.getAttribute('aria-label')).toBe('View disconnected contexts · 105')
  expect(group.querySelectorAll('.focus-context')).toHaveLength(0)
  await act(async () => entry.focus())
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('Disconnected · 105')
  await act(async () => entry.click())
  const directory = container.querySelector<HTMLElement>('[aria-label="Disconnected projects"]')!
  expect(directory).not.toBeNull(); expect(directory.querySelectorAll('.focus-context')).toHaveLength(105)
  expect(group.querySelectorAll('.focus-context')).toHaveLength(0)
  await act(async () => directory.querySelector<HTMLButtonElement>('.focus-disconnected-projects__return')!.click())
  expect(document.activeElement).toBe(entry)
  expect(useAppStore.getState().sessions).toBe(state.sessions)
  expect(useAppStore.getState().agentFocus).toBe(state.agentFocus)
  expect(useAppStore.getState().agentComposerDrafts).toBe(state.agentComposerDrafts)
})
