// @vitest-environment happy-dom
import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { SessionSnapshot } from '../src/shared/contracts'
import { SurfaceToolDock } from '../src/renderer/src/components/SurfaceToolDock'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'

// These retained hidden siblings do not own any Agent list behavior.
vi.mock('../src/renderer/src/components/WorkspaceFilesTool', () => ({ WorkspaceFilesTool: () => null }))
vi.mock('../src/renderer/src/components/WorkspaceGitTool', () => ({ WorkspaceGitTool: () => null }))

const dom = composerDOM(), workspace = composerConfig.workspaces[0]!
const agentKey = (id: string) => JSON.stringify(['local', id])
const agents = (): Extract<SessionSnapshot, { kind: 'agent' }>[] => [
  { ...composerSession('gamma'), label: 'Gamma', createdAt: _tailFixtureEpoch(0, 0, 30), updatedAt: _tailFixtureEpoch(0, 0, 900),
    status: { state: 'waiting', source: 'native-hook', observedAt: _tailFixtureEpoch(0, 0, 900) },
    pendingInteraction: { id: 'permission-gamma', kind: 'permission', agentSessionId: 'gamma', title: 'Allow original edit?', options: [], evidence: { source: 'native-hook', observedAt: _tailFixtureEpoch(0, 0, 900) } } },
  { ...composerSession('alpha'), label: 'Alpha', createdAt: _tailFixtureEpoch(0, 0, 10), updatedAt: _tailFixtureEpoch(0, 0, 100),
    semanticStatus: { state: 'working', source: 'native-hook', observedAt: Date.now(), stateEnteredAt: Date.now() },
    status: { state: 'working', source: 'native-hook', observedAt: Date.now() } },
  { ...composerSession('beta'), label: 'Beta', createdAt: _tailFixtureEpoch(0, 0, 20), updatedAt: _tailFixtureEpoch(0, 0, 800),
    status: { state: 'done', source: 'native-hook', observedAt: _tailFixtureEpoch(0, 0, 800) } }
]
const tab = createWorkbenchTab('retained-alpha-tab', { kind: 'agent', phase: 'attached', workspaceId: workspace.id,
  sessionId: 'alpha', regionId: 'retained-alpha-region' })
const rows = () => [...dom.container.querySelectorAll<HTMLButtonElement>('.workspace-agent-list-item button.focus-context[data-session-id]')]
const ids = () => rows().map(row => row.dataset.sessionId)
function button(label: string, scope: ParentNode = dom.container) {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(node => node.getAttribute('aria-label') === label || node.textContent?.trim() === label)
  expect(found, `Real product button: ${label}`).toBeDefined()
  return found!
}
const click = async (label: string, scope?: ParentNode) => { await act(async () => button(label, scope).click()) }
async function select(id: string) {
  const checkbox = dom.container.querySelector<HTMLInputElement>(`.workspace-agent-list-item[data-agent-key='${agentKey(id)}'] input[type="checkbox"]`)
  expect(checkbox, `Original Agent checkbox: ${id}`).not.toBeNull()
  await act(async () => checkbox!.click())
}
async function filter(value: string) {
  const control = dom.container.querySelector<HTMLButtonElement>(`[aria-label="Filter Agents by state"] button[data-agent-filter="${value}"]`)
  expect(control).not.toBeNull()
  await act(async () => control!.click())
}
const selected = () => [...dom.container.querySelectorAll<HTMLInputElement>('.workspace-agent-list-item input[type="checkbox"]')]
  .filter(input => input.checked).map(input => input.closest<HTMLElement>('[data-agent-key]')!.dataset.agentKey)
const render = () => dom.render(<SurfaceToolDock workspace={workspace} />)

beforeEach(() => {
  useAppStore.setState({ config: composerConfig, loading: false, sessions: agents(), tabs: { [tab.id]: tab },
    layouts: { [workspace.id]: createWorkspaceLayout('retained-group', [tab.id]) },
    activeWorkspaceId: workspace.id, mainSurface: 'workbench', workspaceTool: 'agents',
    workspaceAgentOrder: {}, timelines: {}, scratchTopicSnapshots: {}, agentNames: {},
    agentComposerDrafts: { alpha: 'Keep the original unsent draft' }, error: null })
})

describe('Space Agent list management through the production Dock and shared Focus card', () => {
  it('uses creation order, appends new Agents and keeps nodes in place through activity and state changes', async () => {
    await render()
    expect(ids()).toEqual(['alpha', 'beta', 'gamma'])
    const original = rows()
    expect(original.map(row => row.dataset.state)).toEqual(['working', 'done', 'waiting'])
    expect(dom.container.querySelector('.workspace-agent-row__metadata')).toBeNull()
    expect(dom.container.querySelector('.workspace-agent-list-item time')).toBeNull()
    await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === 'alpha'
      ? { ...session, updatedAt: _tailFixtureEpoch(0, 0, 2000), latestOutputBytes: 9000, status: { state: 'done', source: 'native-hook', observedAt: _tailFixtureEpoch(0, 0, 2000) } }
      : session.id === 'beta' ? { ...session, status: { state: 'working', source: 'native-hook', observedAt: _tailFixtureEpoch(0, 0, 2001) } } : session) })))
    expect(ids()).toEqual(['alpha', 'beta', 'gamma'])
    expect(rows()).toEqual(original)
    await act(async () => useAppStore.setState(state => ({ sessions: [{ ...composerSession('delta'), label: 'Delta', createdAt: _tailFixtureEpoch(0, 0, 40) }, ...state.sessions] })))
    expect(ids()).toEqual(['alpha', 'beta', 'gamma', 'delta'])
    expect(useAppStore.getState().agentComposerDrafts.alpha).toBe('Keep the original unsent draft')
  })

  it('consumes the original Space order preference without changing the Session input order', async () => {
    const sessions = useAppStore.getState().sessions
    useAppStore.setState({ workspaceAgentOrder: { [workspace.id]: [agentKey('gamma'), agentKey('alpha')] } })
    await render()
    expect(ids()).toEqual(['gamma', 'alpha', 'beta'])
    expect(useAppStore.getState().sessions).toBe(sessions)
    expect(useAppStore.getState().tabs[tab.id]).toBe(tab)
  })

  it('opens through the original Dock selection and exposes the shared exact Agent context menu', async () => {
    const open = vi.spyOn(useAppStore.getState(), 'selectSession').mockImplementation(() => undefined)
    await render()
    await act(async () => rows()[0]!.click())
    expect(open).toHaveBeenCalledExactlyOnceWith('alpha', 'retained-group')
    await act(async () => rows()[2]!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })))
    const menu = document.querySelector('.focus-context-menu')
    expect(menu).not.toBeNull()
    expect(menu?.getAttribute('data-agent-session-id')).toBe('gamma')
    expect([...menu!.querySelectorAll('[role="menuitem"]')].map(item => item.textContent)).toEqual(['Rename Agent', 'Copy Agent Link', 'Stop Agent'])
  })

  it('filters by authoritative state and selects visible cards while retaining hidden selection until clear', async () => {
    await render(); await click('Select Agents'); await select('alpha')
    await filter('attention')
    expect(ids()).toEqual(['gamma'])
    await click('Select visible Agents')
    expect(selected()).toEqual([agentKey('gamma')])
    await filter('all')
    expect(selected()).toEqual([agentKey('alpha'), agentKey('gamma')])
    await click('Clear selection')
    expect(selected()).toEqual([])
    expect(button('Copy titles + Agent links').disabled).toBe(true)
    expect(button('Close Agents').disabled).toBe(true)
    await click('Done selecting')
    expect(dom.container.querySelector('.workspace-agent-list-item input[type="checkbox"]')).toBeNull()
  })

  it('copies selected titles and original stable Agent links in visible list order without lifecycle actions', async () => {
    const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
    const stop = vi.spyOn(api.sessions, 'stop')
    useAppStore.setState({ workspaceAgentOrder: { [workspace.id]: [agentKey('gamma'), agentKey('alpha'), agentKey('beta')] } })
    await render(); await click('Select Agents'); await select('alpha'); await select('gamma')
    await click('Copy titles + Agent links')
    expect(copy).toHaveBeenCalledTimes(1)
    const text = copy.mock.calls[0]![0]
    expect(text).toContain('Gamma'); expect(text).toContain('amux://agent/gamma')
    expect(text).toContain('Alpha'); expect(text).toContain('amux://agent/alpha')
    expect(text.indexOf('Gamma')).toBeLessThan(text.indexOf('Alpha'))
    expect(text).not.toContain('Beta'); expect(text).not.toContain('run-alpha')
    expect(stop).not.toHaveBeenCalled()
  })

  it('reviews exact Runs before original public stop and keeps Sessions, workfaces and drafts after receipts', async () => {
    const stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue(undefined)
    await render(); await click('Select Agents'); await select('alpha'); await select('gamma')
    const state = useAppStore.getState()
    await click('Close Agents')
    const dialog = document.querySelector('[role="alertdialog"], [role="dialog"]')!
    expect(dialog).not.toBeNull(); expect(dialog.textContent).toContain('Alpha'); expect(dialog.textContent).toContain('Gamma')
    expect(dialog.textContent).toContain('run-alpha'); expect(dialog.textContent).toContain('run-gamma')
    expect(stop).not.toHaveBeenCalled()
    await click('Close Agents', dialog)
    expect(stop.mock.calls).toEqual([[agents().find(session => session.id === 'alpha')!.control], [agents().find(session => session.id === 'gamma')!.control]])
    expect(useAppStore.getState().sessions).toBe(state.sessions)
    expect(useAppStore.getState().tabs).toBe(state.tabs)
    expect(useAppStore.getState().layouts).toBe(state.layouts)
    expect(useAppStore.getState().agentComposerDrafts).toBe(state.agentComposerDrafts)
    expect(ids()).toEqual(['alpha', 'beta', 'gamma'])
  })

  it.each(['run', 'host', 'session'] as const)('does not send a changed %s and preserves its selection and recovery explanation', async change => {
    const stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue(undefined)
    await render(); await click('Select Agents'); await select('alpha'); await click('Close Agents')
    await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === 'alpha' && session.kind === 'agent'
      ? { ...session, control: { ...session.control,
        ...(change === 'host' ? { hostId: 'changed-control-host' } : change === 'session' ? { agentSessionId: 'changed-canonical-session' } : { run: { runId: 'new-original-run' } }) } } : session) })))
    await click('Close Agents', document.querySelector('[role="alertdialog"], [role="dialog"]')!)
    expect(stop).not.toHaveBeenCalled()
    if (change === 'run') expect(selected()).toContain(agentKey('alpha'))
    else {
      expect(selected()).toEqual([])
      expect(dom.container.textContent).toContain('1 original selection unavailable')
    }
    expect(dom.container.querySelector('[aria-label="Agent close results"]')?.textContent).toContain('local · alpha · Run run-alpha')
    expect(dom.container.textContent).toMatch(/changed|review|unconfirmed/i)
    expect(useAppStore.getState().sessions.find(session => session.id === 'alpha')!.control).toEqual({ ...agents().find(session => session.id === 'alpha')!.control,
      ...(change === 'host' ? { hostId: 'changed-control-host' } : change === 'session' ? { agentSessionId: 'changed-canonical-session' } : { run: { runId: 'new-original-run' } }) })
    expect(useAppStore.getState().tabs[tab.id]).toBe(tab)
  })

  it('copies and closes an alias through its original canonical control while keeping its presentation identity', async () => {
    const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
    const stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue(undefined)
    const original = agents().find(session => session.id === 'alpha')!
    useAppStore.setState({ sessions: [{ ...original, id: 'presentation-alias' }] })
    await render(); await click('Select Agents'); await select('alpha'); await click('Copy titles + Agent links')
    expect(copy.mock.calls).toEqual([['Alpha\namux://agent/alpha']])
    expect(ids()).toEqual(['presentation-alias'])
    await click('Close Agents'); await click('Close Agents', document.querySelector('[role="alertdialog"], [role="dialog"]')!)
    expect(stop).toHaveBeenCalledExactlyOnceWith(original.control)
    expect(ids()).toEqual(['presentation-alias'])
  })
  it('keeps one stable card for multiple presentations of the same canonical Agent', async () => {
    const original = agents().find(session => session.id === 'alpha')!
    const alias = { ...original, id: 'another-presentation' }
    useAppStore.setState({ sessions: [alias, original] })
    await render()
    expect(ids()).toEqual(['alpha'])
    await act(async () => useAppStore.setState({ sessions: [original, alias] }))
    expect(ids()).toEqual(['alpha'])
    await click('Select Agents'); await click('Select visible Agents')
    expect(selected()).toEqual([agentKey('alpha')])
  })

  it('keeps each failed target selected and visible without automatically resending successful stops', async () => {
    const stop = vi.spyOn(api.sessions, 'stop').mockImplementation(async control => { if (control.kind === 'agent' && control.agentSessionId === 'gamma') throw new Error('Original gamma stop receipt unavailable') })
    await render(); await click('Select Agents'); await select('alpha'); await select('gamma'); await click('Close Agents')
    await click('Close Agents', document.querySelector('[role="alertdialog"], [role="dialog"]')!)
    expect(stop).toHaveBeenCalledTimes(2)
    expect(selected()).toEqual([agentKey('gamma')])
    expect(dom.container.textContent).toContain('Original gamma stop receipt unavailable')
    expect(ids()).toEqual(['alpha', 'beta', 'gamma'])
    await act(async () => useAppStore.setState(state => ({ sessions: [...state.sessions] })))
    expect(stop).toHaveBeenCalledTimes(2)
    expect(useAppStore.getState().agentComposerDrafts.alpha).toBe('Keep the original unsent draft')
  })
})
