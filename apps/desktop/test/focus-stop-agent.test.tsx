// @vitest-environment happy-dom
import { act, useMemo } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { createFocusProjectionSelector } from '../src/renderer/src/lib/focus-context'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
vi.mock('../src/renderer/src/components/AgentAvatar', () => ({ AgentAvatar: () => <span /> }))
import { FocusContextRow } from '../src/renderer/src/components/FocusContextRow'
import { FocusToolbar } from '../src/renderer/src/components/FocusToolbar'

const initial = useAppStore.getState(), first = composerSession('stop-first'), target = composerSession('stop-target')
const tab = createWorkbenchTab('stop-tab', { kind: 'agent', regionId: 'stop-region', phase: 'attached', workspaceId: 'workspace', sessionId: target.id })
let root: Root, container: HTMLDivElement, later: HTMLInputElement
const select = vi.fn(), collapse = vi.fn()
function Scene() {
  const project = useMemo(createFocusProjectionSelector, [])
  const { contexts } = useAppStore(project)
  const selected = contexts.find(item => item.id === target.id)
  return <>{contexts.map(context => <FocusContextRow key={context.id} context={context} selected={false} onSelect={select} />)}
    <FocusToolbar selectedId={target.id} selected={selected} tab={tab} onReview={() => {}} onCloseWorkspace={collapse}>Filters</FocusToolbar></>
}
const card = () => container.querySelector<HTMLButtonElement>(`button[data-session-id="${target.id}"]`)!
const confirm = () => document.querySelector<HTMLButtonElement>('[role="dialog"] [data-confirm-label="Stop Agent"]')!
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
async function open(entry: 'card' | 'toolbar' | 'title' = 'card') {
  const origin = entry === 'card' ? card() : container.querySelector<HTMLButtonElement>(entry === 'title' ? '.focus-toolbar__identity' : '[aria-label="Focus context actions"]')!
  expect(origin).toBeTruthy()
  await act(async () => {
    origin.focus()
    if (entry === 'toolbar') origin.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }))
    else origin.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 40 }))
  })
  await settle()
  const stop = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === 'Stop Agent')
  expect(stop).toBeTruthy()
  await act(async () => stop!.click()); await settle()
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Stop Agent?')
  expect(document.querySelector('.confirmation-dialog__subject')?.textContent).toBe('Same Agent')
  expect(api.sessions.stop).not.toHaveBeenCalled()
  return origin
}
function retained(before = initial) {
  const now = useAppStore.getState()
  for (const key of ['tabs', 'layouts', 'agentComposerDrafts', 'agentFocus', 'timelines'] as const) expect(now[key]).toBe(before[key])
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useAppStore.setState({ ...initial, config: composerConfig, sessions: [first, target], agentNames: { [first.id]: 'Same Agent', [target.id]: 'Same Agent' },
    timelines: {}, tabs: { [tab.id]: tab }, layouts: { workspace: createWorkspaceLayout('stop-group', [tab.id]) },
    activeWorkspaceId: 'workspace', mainSurface: 'agents', scratchTopicSnapshots: {},
    agentComposerDrafts: { [first.id]: 'Neighbor draft', [target.id]: 'Target unsent' }, error: null,
    agentFocus: { execution: { sessionId: target.id, history: [] }, pmo: { sessionId: null } } }, true)
  select.mockClear(); collapse.mockClear()
  vi.spyOn(api.sessions, 'stop').mockResolvedValue(undefined)
  container = document.createElement('div'); later = document.createElement('input'); document.body.append(container, later)
  root = createRoot(container); await act(async () => root.render(<Scene />))
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); later.remove()
  document.getElementById('agentmux-window-overlay-host')?.remove()
  useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it.each(['card', 'toolbar', 'title'] as const)('opens %s confirmation, cancels with exact focus return and keeps collapse separate', async entry => {
  const before = useAppStore.getState(), origin = await open(entry)
  const cancel = document.querySelector<HTMLButtonElement>('.confirmation-dialog__cancel')!
  expect(document.activeElement).toBe(cancel)
  await act(async () => cancel.click()); await settle()
  expect(document.activeElement).toBe(origin); expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(api.sessions.stop).not.toHaveBeenCalled(); retained(before)
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close Focus workspace"]')!.click())
  expect(collapse).toHaveBeenCalledOnce(); expect(api.sessions.stop).not.toHaveBeenCalled(); expect(select).not.toHaveBeenCalled()
})

it('sends one exact host/SID/Run from the card, holds pending and never invents stopped facts', async () => {
  let release!: () => void
  vi.mocked(api.sessions.stop).mockImplementation(() => new Promise(resolve => { release = resolve }))
  const before = useAppStore.getState()
  await open()
  await act(async () => { confirm().click(); confirm().click() })
  expect(api.sessions.stop).toHaveBeenCalledExactlyOnceWith(target.control)
  expect(confirm().disabled).toBe(true); expect(confirm().textContent).toBe('Working…'); retained(before)
  later.focus()
  await act(async () => release()); await settle()
  expect(document.activeElement).toBe(later); expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(useAppStore.getState().sessions).toBe(before.sessions); retained(before)
})

it('toolbar stops its selected semantic Agent rather than the active workspace or same-name neighbor', async () => {
  await open('toolbar')
  await act(async () => useAppStore.setState({ activeWorkspaceId: 'other', agentFocus: { execution: { sessionId: first.id, history: [] }, pmo: { sessionId: null } } }))
  await act(async () => confirm().click()); await settle()
  expect(api.sessions.stop).toHaveBeenCalledExactlyOnceWith(target.control)
  expect(useAppStore.getState().agentFocus.execution.sessionId).toBe(first.id)
})

it.each(['run', 'host'] as const)('rejects a changed %s only for this old confirmation and retains the current Agent', async field => {
  await open()
  const replacement = { ...target, control: { ...target.control, ...(field === 'run' ? { run: { runId: 'new-run' } } : { hostId: 'other-host' }) } }
  await act(async () => useAppStore.setState({ sessions: [first, replacement] }))
  const before = useAppStore.getState()
  await act(async () => confirm().click()); await settle()
  expect(api.sessions.stop).not.toHaveBeenCalled(); expect(useAppStore.getState().sessions).toBe(before.sessions); retained(before)
  expect(useAppStore.getState().error).toContain('Run changed')
  expect(useAppStore.getState().errorNoticeContext?.subject).toEqual(target.control)
})

it('a rejected or timed-out stop preserves state, reports its exact subject and permits explicit retry', async () => {
  vi.mocked(api.sessions.stop).mockRejectedValueOnce(new Error('Stop result is unknown: timeout'))
  const before = useAppStore.getState(); await open()
  await act(async () => confirm().click()); await settle()
  expect(useAppStore.getState().error).toContain('timeout'); expect(useAppStore.getState().errorNoticeContext?.summary).toContain('unconfirmed')
  expect(useAppStore.getState().errorNoticeContext?.subject).toEqual(target.control); retained(before)
  expect(api.sessions.stop).toHaveBeenCalledTimes(1)
  vi.mocked(api.sessions.stop).mockClear()
  await open(); await act(async () => confirm().click()); await settle()
  expect(api.sessions.stop).toHaveBeenCalledExactlyOnceWith(target.control); retained(before)
})

it('unknown observation still allows explicit Stop; disappearing identity never borrows another Agent', async () => {
  await act(async () => useAppStore.setState({ sessions: [first, { ...target, processState: 'running', status: { state: 'disconnected', source: 'native-hook', observedAt: 2, detail: 'Connection observation unavailable; current Run is unconfirmed' } }] }))
  await open(); await act(async () => confirm().click()); await settle()
  expect(api.sessions.stop).toHaveBeenCalledExactlyOnceWith(target.control)
  vi.mocked(api.sessions.stop).mockClear()
  await open(); await act(async () => useAppStore.setState({ sessions: [first] }))
  await settle()
  expect(api.sessions.stop).not.toHaveBeenCalled(); expect(useAppStore.getState().sessions).toEqual([first])
})

it('leaving a pending confirmation does not refocus or mutate a later work surface', async () => {
  let release!: () => void
  vi.mocked(api.sessions.stop).mockImplementation(() => new Promise(resolve => { release = resolve }))
  await open(); await act(async () => confirm().click())
  await act(async () => root.render(null)); later.focus()
  const before = useAppStore.getState()
  await act(async () => release()); await settle()
  expect(document.activeElement).toBe(later); retained(before)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
})
