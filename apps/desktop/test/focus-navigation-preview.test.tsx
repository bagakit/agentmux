// @vitest-environment happy-dom
import { act, createElement, Profiler } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { PMO_TEAMS_TOPIC_ID, scratchTopicDirectoryName } from '../src/shared/scratch-topics'
vi.mock('../src/renderer/src/components/PmoTeamsTopicEntry', () => ({ PmoTeamsTopicEntry: () => createElement('button', null, 'PMO') }))
import { SurfaceSwitch } from '../src/renderer/src/components/TopRowChrome'
const baseline = useAppStore.getState()
let root: Root, container: HTMLDivElement
const commits = vi.fn()
const preview = () => document.querySelector<HTMLElement>('#surface-navigation-tooltip-focus')
const focus = () => container.querySelector<HTMLButtonElement>('.surface-navigation__focus')!
const hover = () => act(async () => focus().dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
const leave = () => act(async () => focus().dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })))
const items = (id: string, kind: string, content: string) => ({ items: [{ id: `${id}-item`, kind, status: 'complete', title: content, content, createdAt: 1000, updatedAt: 1000 }] }) as never
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  const config = await api.config.get(), { sessions } = await api.sessions.snapshot(), base = sessions[0]!
  useAppStore.setState({ config, mainSurface: 'workbench', agentNames: { working: 'Build the parser', attention: 'Review the change', result: 'Ready for review', idle: 'My current context' },
    sessions: ['working', 'attention', 'result', 'idle', 'offline'].map((id, index) => ({ ...base, id, status: { ...base.status, state: ['working', 'waiting', 'done', 'running', 'disconnected'][index] as typeof base.status.state } })),
    timelines: { working: items('working', 'user_message', 'Compile the parser'), result: items('result', 'assistant_message', 'Parser tests pass') },
    agentFocus: { execution: { sessionId: 'idle', history: [] }, pmo: { sessionId: null } } })
  commits.mockClear()
  await act(async () => root.render(createElement(Profiler, { id: 'navigation', onRender: commits }, createElement(SurfaceSwitch, { onOpenSettings: vi.fn() }))))
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); document.getElementById('agentmux-window-overlay-host')?.remove(); useAppStore.setState(baseline, true); vi.restoreAllMocks(); vi.unstubAllGlobals() })
it('opens a bounded live snapshot on hover, retaining the current context and prioritizing attention and work', async () => {
  expect(preview()).toBeNull(); await hover(); expect(preview()?.getAttribute('role')).toBe('tooltip')
  expect(preview()?.querySelector('[data-preview-count="working"]')?.textContent).toBe('1Working')
  expect(preview()?.querySelector('[data-preview-count="attention"]')?.textContent).toBe('1Attention')
  expect(preview()?.querySelector('[data-preview-count="results"]')?.textContent).toBe('1Results')
  expect(preview()?.querySelector('[data-preview-count="idle"]')?.textContent).toBe('1Idle')
  expect([...preview()!.querySelectorAll('[data-preview-session]')].map(row => row.getAttribute('data-preview-session'))).toEqual(['idle', 'attention', 'working'])
  expect(preview()?.textContent).toContain('ViewingMy current context'); expect(preview()?.textContent).toContain('1 disconnected')
  expect(preview()?.textContent).toContain('Compile the parser'); expect(preview()?.textContent).toContain(useAppStore.getState().config!.workspaces[0]!.name)
  expect(useAppStore.getState().mainSurface).toBe('workbench'); expect(useAppStore.getState().agentFocus.execution.sessionId).toBe('idle')
  expect(focus().hasAttribute('title')).toBe(false)
  expect(preview()?.querySelector('button, input, [tabindex]')).toBeNull()
  await act(async () => useAppStore.setState(state => ({ agentNames: { ...state.agentNames, working: 'Parser ready' }, sessions: state.sessions.map(s => s.id === 'attention' ? { ...s, status: { ...s.status, state: 'done' } } : s), timelines: { ...state.timelines, working: items('working', 'assistant_message', 'Compiled successfully') } })))
  expect(preview()?.textContent).toContain('Parser ready'); expect(preview()?.textContent).toContain('Compiled successfully')
  expect(preview()?.querySelector('[data-preview-count="attention"]')?.textContent).toBe('0Attention')
})
it('ignores unrelated bytes and detaches detailed preview when closed', async () => {
  await hover(); const before = commits.mock.calls.length; expect(before).toBeGreaterThan(0)
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(s => ({ ...s, latestOutputBytes: s.latestOutputBytes + 128 })) })))
  expect(commits.mock.calls.length).toBe(before)
  await leave(); expect(preview()).toBeNull(); const closed = commits.mock.calls.length
  await act(async () => useAppStore.setState(state => ({ timelines: { ...state.timelines, working: items('working', 'assistant_message', 'Changed while closed') } })))
  expect(commits.mock.calls.length).toBe(closed)
  await hover(); expect(preview()?.textContent).toContain('Changed while closed')
})
it('keeps selected disconnected contexts count-only without changing the original focus', async () => {
  await act(async () => useAppStore.setState(state => ({
    agentNames: { ...state.agentNames, offline: 'Saved offline task' },
    timelines: { ...state.timelines, offline: items('offline', 'assistant_message', 'Offline activity detail') },
    agentFocus: { ...state.agentFocus, execution: { ...state.agentFocus.execution, sessionId: 'offline' } }
  })))
  await hover()
  expect([...preview()!.querySelectorAll('[data-preview-session]')].map(row => row.getAttribute('data-preview-session'))).toEqual(['attention', 'working', 'result'])
  expect(preview()?.textContent).toContain('5 contexts')
  expect(preview()?.textContent).toContain('1 disconnected')
  expect(preview()?.textContent).not.toContain('Saved offline task')
  expect(preview()?.textContent).not.toContain('Offline activity detail')
  expect(preview()?.querySelector('.focus-navigation-preview__viewing')).toBeNull()
  expect(useAppStore.getState().agentFocus.execution.sessionId).toBe('offline')
  expect(useAppStore.getState().sessions.find(session => session.id === 'offline')?.status.state).toBe('disconnected')
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.filter(session => session.id === 'offline') })))
  expect([...preview()!.querySelectorAll('[data-preview-session]')]).toEqual([])
  expect(preview()?.textContent).toContain('No active contexts')
  expect(preview()?.textContent).toContain('1 context')
  expect(preview()?.textContent).toContain('1 disconnected')
  expect(preview()?.textContent).not.toContain('Offline activity detail')
  expect(useAppStore.getState().agentFocus.execution.sessionId).toBe('offline')
  await act(async () => focus().click())
  expect(useAppStore.getState().mainSurface).toBe('agents')
  expect(useAppStore.getState().agentFocus.execution.sessionId).toBe('offline')
})
it('excludes PMO from both the badge and preview, and does not keep an old result after a new prompt', async () => {
  await act(async () => useAppStore.setState(state => ({
    config: { ...state.config!, workspaces: [...state.config!.workspaces, { ...state.config!.workspaces[0]!, id: '__scratch__', name: 'Scratch', path: '/fixture/scratch' }] },
    sessions: [...state.sessions, { ...state.sessions[0]!, id: 'pmo', workspacePath: `/fixture/scratch/${scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID)}` }],
    agentNames: { ...state.agentNames, pmo: 'PMO coordinator' }
  })))
  await hover()
  expect(preview()?.textContent).toContain('5 contexts')
  expect(preview()?.textContent).not.toContain('PMO coordinator')
  expect(focus().querySelector('[data-focus-count="working"]')?.textContent).toBe('1')
  expect(preview()?.querySelector('[data-preview-count="working"]')?.textContent).toBe('1Working')
  await act(async () => useAppStore.setState(state => ({ timelines: { ...state.timelines, result: items('result', 'user_message', 'Start another task') } })))
  expect(preview()?.querySelector('[data-preview-count="results"]')?.textContent).toBe('0Results')
  expect(preview()?.querySelector('[data-preview-count="idle"]')?.textContent).toBe('2Idle')
})
it('supports keyboard reading, Escape and blur without navigation, and preserves click navigation and empty truth', async () => {
  await act(async () => focus().focus()); expect(preview()).toBeTruthy()
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))); expect(preview()).toBeNull()
  await hover(); await act(async () => window.dispatchEvent(new Event('blur'))); expect(preview()).toBeNull()
  await act(async () => useAppStore.setState({ sessions: [], timelines: {} })); await hover()
  expect(preview()?.textContent).toContain('No execution contexts yet'); expect(preview()?.textContent).toContain('0 contexts')
  await act(async () => focus().click()); expect(useAppStore.getState().mainSurface).toBe('agents')
})
