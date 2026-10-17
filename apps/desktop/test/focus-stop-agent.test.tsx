// @vitest-environment happy-dom
import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { act, useMemo } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { agentContextForSession, createFocusProjectionSelector } from '../src/renderer/src/lib/focus-context'
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
    <FocusToolbar selectedId={target.id} selected={selected} tab={tab} reference={{ displayWorkspaceId: 'workspace', groupId: 'stop-group', tabId: tab.id, regionId: 'stop-region' }} onReview={() => {}} onCloseWorkspace={collapse}>Filters</FocusToolbar></>
}
const card = () => container.querySelector<HTMLButtonElement>(`button[data-session-id="${target.id}"]`)!
const confirm = () => document.querySelector<HTMLButtonElement>('[role="dialog"] [data-confirm-label="Stop Agent"]')!
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
async function open(entry: 'card' | 'toolbar' | 'title' = 'card', action: 'Stop Agent' | 'Restart Session…' = 'Stop Agent') {
  const origin = entry === 'card' ? card() : container.querySelector<HTMLButtonElement>(entry === 'title' ? '.focus-toolbar__identity' : '[aria-label="Focus context actions"]')!
  expect(origin).toBeTruthy()
  await act(async () => {
    origin.focus()
    if (entry === 'toolbar') origin.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }))
    else origin.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 40 }))
  })
  await settle()
  const stop = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === action)
  expect(stop).toBeTruthy()
  await act(async () => stop!.click()); await settle()
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(action === 'Stop Agent' ? 'Stop Agent?' : 'Restart Session?')
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
  await act(async () => useAppStore.setState({ sessions: [first, { ...target, processState: 'running', status: { state: 'disconnected', source: 'native-hook', observedAt: _tailFixtureEpoch(0, 0, 2), detail: 'Connection observation unavailable; current Run is unconfirmed' } }] }))
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


it.each(['card', 'toolbar', 'title'] as const)('offers explicit Restart from the original %s menu without executing before confirmation', async entry => {
  const restart = vi.spyOn(api.sessions, 'restart')
  const before = useAppStore.getState()
  await open(entry, 'Restart Session…')
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Running work will be interrupted')
  expect(restart).not.toHaveBeenCalled(); expect(api.sessions.stop).not.toHaveBeenCalled()
  await act(async () => document.querySelector<HTMLButtonElement>('.confirmation-dialog__cancel')!.click()); await settle()
  retained(before)
})

function ExactTargetScene({ session, withControl = true }: { session: typeof target; withControl?: boolean }) {
  const { control, ...presentation } = agentContextForSession(session, undefined, 'Same Agent', composerConfig.workspaces[0], null)
  const context = { ...presentation, ...(withControl && control ? { control } : {}) }
  return <><FocusContextRow context={context} selected={false} onSelect={select} />
    <FocusToolbar selectedId={session.id} selected={context} tab={tab} reference={{ displayWorkspaceId: 'workspace', groupId: 'stop-group', tabId: tab.id, regionId: 'stop-region' }} onReview={() => {}} onCloseWorkspace={collapse}>Filters</FocusToolbar></>
}
async function exactTarget(session: typeof target, neighbors: typeof target[] = [first], withControl = true) {
  await act(async () => {
    useAppStore.setState({ sessions: [...neighbors, session] })
    root.render(<ExactTargetScene session={session} withControl={withControl} />)
  })
}
it.each(['card', 'toolbar', 'title'] as const)('the original %s target keeps a same-SID remote Host, even with a local match first', async entry => {
  const remote = { ...target, hostId: 'remote', control: { ...target.control, hostId: 'remote', run: { runId: 'remote-original-run' } } }
  await exactTarget(remote, [target])
  const before = useAppStore.getState()
  await open(entry); await act(async () => confirm().click()); await settle()
  expect(api.sessions.stop).toHaveBeenCalledExactlyOnceWith(remote.control)
  expect(useAppStore.getState().sessions).toBe(before.sessions); retained(before)
})
it.each(['card', 'toolbar', 'title'] as const)('the original %s target uses its canonical control while retaining a presentation alias', async entry => {
  const alias = { ...target, control: { ...target.control, agentSessionId: 'canonical-original-agent' } }
  const unrelated = composerSession(alias.control.agentSessionId)
  await exactTarget(alias, [unrelated])
  const before = useAppStore.getState()
  await open(entry); await act(async () => confirm().click()); await settle()
  expect(api.sessions.stop).toHaveBeenCalledExactlyOnceWith(alias.control); retained(before)
})
it('copies the canonical Agent link from the original alias card', async () => {
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  const alias = { ...target, control: { ...target.control, agentSessionId: 'canonical-original-agent' } }
  await exactTarget(alias)
  await act(async () => card().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))); await settle()
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === 'Copy Agent Link')
  expect(item).toBeDefined()
  await act(async () => item!.click()); await settle()
  expect(copy).toHaveBeenCalledExactlyOnceWith('amux://agent/canonical-original-agent')
})
it.each(['missing-control', 'stale-run'] as const)('refuses only the card operation with %s and keeps the healthy original workface', async reason => {
  await exactTarget(target, [first], reason !== 'missing-control')
  if (reason === 'stale-run') await act(async () => useAppStore.setState({ sessions: [first,
    { ...target, control: { ...target.control, run: { runId: 'changed-before-menu' } } }] }))
  const before = useAppStore.getState()
  await act(async () => card().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))); await settle()
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === 'Stop Agent')
  expect(item).toBeDefined(); await act(async () => item!.click()); await settle()
  expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(api.sessions.stop).not.toHaveBeenCalled()
  expect(useAppStore.getState().errorNoticeContext?.summary).toContain('original work surface is kept')
  expect(useAppStore.getState().sessions).toBe(before.sessions); retained(before)
})
it('passes an exact original control to Core when the Run becomes unobserved during confirmation', async () => {
  const remote = { ...target, hostId: 'remote', control: { ...target.control, hostId: 'remote' } }
  vi.mocked(api.sessions.stop).mockRejectedValueOnce(new Error('Original Core stop receipt is unknown'))
  await exactTarget(remote, [target]); await open()
  await act(async () => useAppStore.setState({ sessions: [target, { ...remote, runUnobserved: true }] }))
  const before = useAppStore.getState()
  await act(async () => confirm().click()); await settle()
  expect(api.sessions.stop).toHaveBeenCalledExactlyOnceWith(remote.control); retained(before)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(useAppStore.getState().errorNoticeContext?.subject).toEqual(remote.control)
  expect(useAppStore.getState().errorNoticeContext?.summary).toContain('unconfirmed')
})

it('keeps Copy available for an unobserved canonical identity and reports without writing the clipboard', async () => {
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await exactTarget(target, [first], false)
  const before = useAppStore.getState()
  await act(async () => card().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))); await settle()
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === 'Copy Agent Link')
  expect(item).toBeDefined(); await act(async () => item!.click()); await settle()
  expect(copy).not.toHaveBeenCalled()
  expect(useAppStore.getState().error).toContain('canonical Agent identity is not confirmed')
  expect(useAppStore.getState().errorNoticeContext?.summary).toContain('Refresh this Agent’s identity')
  expect(useAppStore.getState().sessions).toBe(before.sessions); retained(before)
})

it('admits the original card with an unobserved Run and retains the Core failure service window', async () => {
  const original = { ...target, runUnobserved: true as const }
  await exactTarget(original)
  vi.mocked(api.sessions.stop).mockRejectedValueOnce(new Error('Core could not confirm the original stop result'))
  const before = useAppStore.getState(); await open(); await act(async () => confirm().click()); await settle()
  expect(api.sessions.stop).toHaveBeenCalledExactlyOnceWith(original.control)
  expect(useAppStore.getState().sessions).toBe(before.sessions); retained(before)
  expect(useAppStore.getState().error).toContain('Core could not confirm')
  expect(useAppStore.getState().errorNoticeContext?.subject).toEqual(original.control)
  expect(useAppStore.getState().errorNoticeContext?.summary).toContain('Review its status, then retry Stop Agent')
})
