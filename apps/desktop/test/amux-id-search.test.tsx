import { chooseFocusFilter } from './fixtures/focus-filter-menu'
// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SessionSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { QuickSwitcher } from '../src/renderer/src/components/QuickSwitcher'

// Search, row projection, ranking and Store focus navigation are real. The observation leaf
// does not attach a Terminal; QuickSwitcher selectSession is observed at its existing Store verb.
vi.mock('../src/renderer/src/components/SessionPane', () => ({
  SessionPane: ({ sessionId }: { sessionId: string }) => createElement('div', { 'data-observing': sessionId })
}))
const initial = useAppStore.getState()
const A = 'amux_AbC17-alpha', B = 'amux_AbC17-beta', C = 'amux_AbC17-gamma', PMO = 'amux_AbC17-pmo'
const RUN = 'run-only-Linked82', TERMINAL = 'shell-RunOnly74'
let root: Root, container: HTMLDivElement

function agent(id: string, label: string, state: 'waiting' | 'working', observedAt: number, path = '/repo'): SessionSnapshot {
  return { id, label, kind: 'agent', hostId: 'local', workspacePath: path, providerId: 'codex', executorId: 'codex',
    createdAt: 1, updatedAt: observedAt, agentSessionUpdatedAt: observedAt, processState: 'running', latestOutputBytes: 0,
    status: { state, source: 'native-hook', observedAt },
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'respond', providerResume: true, replyCorrelation: 'none' },
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: id === A ? RUN : `run-${id}` } } }
}
const shell: SessionSnapshot = { id: TERMINAL, label: 'Command shell', kind: 'terminal', providerId: null,
  hostId: 'local', workspacePath: '/repo', createdAt: 1, updatedAt: 1, processState: 'running', latestOutputBytes: 0,
  status: { state: 'running', source: 'run-process', observedAt: 1 },
  control: { kind: 'terminal', hostId: 'local', runId: TERMINAL, run: { runId: TERMINAL } } }

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const config = await api.config.get()
  vi.spyOn(api.workspaces, 'listBranches').mockResolvedValue({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: '/repo' })
  vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'directory', icon: null })
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([])
  useAppStore.setState({ config: { ...config, workspaces: [
    { id: 'repo', name: 'Product', hostId: 'local', path: '/repo', kind: 'folder' },
    { id: 'other', name: 'Other project', hostId: 'local', path: '/other', kind: 'folder' },
    { id: '__scratch__', name: 'Topics', hostId: 'local', path: '/topics', kind: 'folder' }
  ] }, sessions: [agent(B, 'Implement parser', 'working', 20), agent(A, 'Review parser', 'waiting', 10),
    agent(C, 'Other agent', 'working', 30, '/other'), agent(PMO, 'Mote coordinator', 'working', 40, '/topics/topic--launcher--leader'), shell],
  timelines: {}, tabs: {}, layouts: {}, providerCatalog: [], agentNames: {}, workspaceFileRevisions: {},
  mainSurface: 'agents', agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove(); document.getElementById('agentmux-window-overlay-host')?.remove()
  useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
async function query(label: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
  expect(input).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input!.dispatchEvent(new Event('input', { bubbles: true }))
  })
  return input!
}
function focusIds() { return [...container.querySelectorAll<HTMLElement>('.focus-context')].map(row => row.dataset.sessionId) }
function options() { return [...document.querySelectorAll<HTMLButtonElement>('.quick-switch [role="option"]')] }
function titles() { return options().map(row => row.querySelector('.quick-switch__row-title')!.textContent) }
async function key(input: HTMLInputElement, value: string) {
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true })))
}

it('finds the original Focus Agent by trimmed full ID, unique prefix and middle fragment, then uses the existing focus route', async () => {
  const focus = vi.fn(initial.focusExecutionSession), select = vi.fn(async () => {})
  useAppStore.setState({ focusExecutionSession: focus, selectSession: select })
  await act(async () => root.render(createElement(GlobalFocusSurface)))
  expect(new Set(focusIds())).toEqual(new Set([A, B, C]))
  for (const value of [A, `  ${A}  `, 'amux_AbC17-al', 'C17-alp']) {
    await query('Search contexts', value)
    expect(focusIds()).toEqual([A])
    expect(useAppStore.getState().agentFocus.execution.sessionId).toBeNull()
  }
  const row = container.querySelector<HTMLButtonElement>('.focus-context')!
  await act(async () => row.click())
  expect(focus).toHaveBeenCalledExactlyOnceWith(A)
  expect(useAppStore.getState().agentFocus.execution.sessionId).toBe(A)
  expect(useAppStore.getState().mainSurface).toBe('agents')
  expect(select).not.toHaveBeenCalled()
})

it('keeps all matching Focus Agents, project/state filters, PMO visibility and existing text searches', async () => {
  await act(async () => root.render(createElement(GlobalFocusSurface)))
  await query('Search contexts', 'AbC17')
  expect(new Set(focusIds())).toEqual(new Set([A, B, C]))
  expect(useAppStore.getState().agentFocus.execution.sessionId).toBeNull()
  await chooseFocusFilter(container, 'project', 'repo')
  expect(focusIds()).toEqual([A, B])
  await chooseFocusFilter(container, 'state', 'working')
  expect(focusIds()).toEqual([B])
  await query('Search contexts', '  IMPLEMENT PARSER  ')
  expect(focusIds()).toEqual([B])
  await query('Search contexts', PMO)
  expect(focusIds()).toEqual([])
  await chooseFocusFilter(container, 'state', 'all')
  await query('Search contexts', '')
  expect(new Set(focusIds())).toEqual(new Set([A, B]))
})

it('does not add Focus ID matches for changed case, noncontiguous characters, Run or Terminal identities', async () => {
  await act(async () => root.render(createElement(GlobalFocusSurface)))
  await query('Search contexts', A)
  expect(focusIds()).toEqual([A])
  // SessionSnapshot has no Provider-native identity field. This native-shaped query is outside
  // both canonical IDs and visible text; no invented field is added to the product fixture.
  for (const value of ['abc17', 'AC7', RUN, TERMINAL, 'provider-native-KLm55']) {
    await query('Search contexts', value)
    expect(focusIds()).toEqual([])
    expect(container.textContent).toContain('No matching contexts')
  }
})

it('queries real QuickSwitcher input by ID, lists ambiguous results in attention order, and lets Arrow/Enter select the original Agent', async () => {
  const select = vi.fn(async () => {}), close = vi.fn()
  useAppStore.setState({ selectSession: select })
  await act(async () => root.render(createElement(QuickSwitcher, { open: true, onClose: close })))
  expect(options()).toHaveLength(5)
  for (const value of [A, `  ${A}  `, 'amux_AbC17-al', 'C17-alp']) {
    await query('Search sessions and tabs', value)
    expect(titles()).toEqual(['Review parser'])
    expect(select).not.toHaveBeenCalled()
  }
  const input = await query('Search sessions and tabs', 'AbC17')
  expect(titles()).toEqual(['Review parser', 'Implement parser', 'Other agent', 'Mote coordinator'])
  expect(select).not.toHaveBeenCalled()
  await key(input, 'ArrowDown'); await key(input, 'Enter')
  expect(select).toHaveBeenCalledExactlyOnceWith(B)
  expect(close).toHaveBeenCalledOnce()
})

it('preserves QuickSwitcher text quality including negative scores and excludes non-Agent/foreign ID matches', async () => {
  await act(async () => root.render(createElement(QuickSwitcher, { open: true, onClose: vi.fn() })))
  await query('Search sessions and tabs', 'Review parser')
  expect(titles()).toEqual(['Review parser'])
  for (const value of ['abc17', 'AC7', RUN, TERMINAL, 'provider-native-KLm55']) {
    await query('Search sessions and tabs', value)
    expect(titles()).toEqual([])
    expect(document.querySelector('.quick-switch__empty')).not.toBeNull()
  }
  await act(async () => useAppStore.setState({ sessions: [
    agent('amux_Zweak', 'aaaaaaaaaaaaZ', 'working', 1), agent('amux_Zonly', 'Quiet task', 'working', 2)
  ] }))
  await query('Search sessions and tabs', 'Z')
  // ID-only receives neutral 0; the preexisting weak text score remains negative rather than
  // being raised to 0 merely because that same Agent ID also matches.
  expect(titles()).toEqual(['Quiet task', 'aaaaaaaaaaaaZ'])
})
