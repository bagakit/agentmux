// @vitest-environment happy-dom
const { fixtureEpoch: _newTailFixtureEpoch } = await vi.hoisted(async () => await import("../../../test/fixture-values.mjs"))
import { act, memo, Profiler } from 'react'
import { assertGroupInvariant, createWorkspaceLayout } from '@agentmux/layout'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../src/renderer/src/lib/api'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { addWorkbenchRegion, createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { agentContextForSession } from '../src/renderer/src/lib/focus-context'
import { AgentContextContent } from '../src/renderer/src/components/AgentContextContent'
import { ExecutorIdentityContext } from '../src/renderer/src/components/AgentAvatar'
import { agentRegionExecution, useAppStore } from '../src/renderer/src/store'
import * as store from '../src/renderer/src/store'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { initializeSpatialControlFixture } from './helpers/spatial-control-owner-fixture'

const commits = vi.hoisted(() => ({} as Record<string, number>))
vi.mock('../src/renderer/src/components/FocusContextRow', async original => {
  const actual = await original<typeof import('../src/renderer/src/components/FocusContextRow')>()
  return { FocusContextRow: memo((props: Parameters<typeof actual.FocusContextRow>[0]) => <Profiler id={props.context.id}
    onRender={id => { commits[id] = (commits[id] ?? 0) + 1 }}><actual.FocusContextRow {...props} /></Profiler>) }
})
// Keep the actual Focus projection, card, Store, Core graph and shared identity owners.
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
vi.mock('../src/renderer/src/lib/use-focus-hierarchy', () => ({ useFocusHierarchy: () => ({ facts: { topics: {}, worktrees: [] }, errors: [] }) }))
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'

const dom = composerDOM(), workspace = composerConfig.workspaces[0]!
const agent = { ...composerSession('focus-subject'), executorId: 'configured',
  status: { state: 'done' as const, source: 'native-hook' as const, observedAt: _newTailFixtureEpoch(0, 0, 1) } }
const neighbor = composerSession('focus-neighbor', 'claude')
const base = createWorkbenchTab('focus-subject-tab', { kind: 'agent', phase: 'attached', regionId: 'neighbor-region', workspaceId: workspace.id, sessionId: neighbor.id })
const split = addWorkbenchRegion(base, 'neighbor-region', 'right', { kind: 'agent', phase: 'attached', regionId: 'subject-region', workspaceId: workspace.id, sessionId: agent.id })
const tab = { ...split, layout: { ...split.layout, activeRegionId: 'neighbor-region' } }
const reference = { displayWorkspaceId: workspace.id, groupId: 'focus-subject-group', tabId: tab.id, regionId: 'subject-region' }
const originalReply = 'Focus、SDK、RPC、CLI 共用 Core 搜索，保留原记录与准确来源。'
const timeline = { agentSessionId: agent.id, revision: 1, items: [{ id: 'subject-reply', agentSessionId: agent.id,
  kind: 'assistant_message' as const, status: 'complete' as const, source: 'native-hook' as const,
  title: 'Reply', content: originalReply, createdAt: _newTailFixtureEpoch(0, 0, 1), updatedAt: _newTailFixtureEpoch(0, 0, 1) }] }
const card = () => dom.container.querySelector<HTMLButtonElement>(`.focus-context[data-session-id="${agent.id}"]`)!
const marks = (parent: ParentNode = card()) => [...parent.querySelectorAll<HTMLElement>('.workbench-topology__tab-glyph__cell[data-subject-region="true"]')].map(node => node.dataset.regionId)
const fullPreview = () => document.querySelector<HTMLElement>('.focus-context-hover')
const topologyPreview = () => document.querySelector<HTMLElement>('.workbench-topology__inspector--portal')

async function refreshCoreGraph(hostId?: string) {
  const graph = desktopSpatialGraph(useAppStore.getState(), [])
  if (hostId !== undefined) for (const region of graph.regions) if (region.agentSessionId === agent.id) {
    region.execution = hostId ? { hostId, cwd: agent.workspacePath } : null
  }
  vi.spyOn(api.spatial, 'read').mockResolvedValue({ schemaVersion: 1, revision: 1, graph })
  await initializeSpatialControlFixture()
}
async function mount() { await dom.render(<ExecutorIdentityContext.Provider value={{ config: useAppStore.getState().config }}><GlobalFocusSurface /></ExecutorIdentityContext.Provider>) }
async function pointer(node: Element, type: 'pointerover' | 'pointerout', relatedTarget: Element | null = null) {
  await act(async () => node.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: 'mouse', buttons: 0, relatedTarget })))
}

beforeEach(async () => {
  localStorage.clear(); Object.keys(commits).forEach(key => delete commits[key])
  useAppStore.setState({ config: { ...composerConfig, executors: { ...composerConfig.executors,
    configured: { ...composerConfig.executors.codex!, label: 'Configured Executor', avatar: { badge: 'shield' } } } },
    sessions: [agent, neighbor], tabs: { [tab.id]: tab }, layouts: { [workspace.id]: createWorkspaceLayout(reference.groupId, [tab.id]) },
    agentNames: { [agent.id]: 'FOCUS', [neighbor.id]: 'Neighbor' }, timelines: { [agent.id]: timeline },
    agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } },
    scratchTopicSnapshots: {}, spaceZoneBindings: {}, spatialRequests: {}, mainSurface: 'agents' })
  vi.spyOn(api.sessions, 'historySources').mockResolvedValue([])
  await refreshCoreGraph()
})

describe('mounted Focus consumes original workbench identity', () => {
  it('keeps fixed state, exact subject geometry and the full-width original result in separate rows', async () => {
    expect(agentRegionExecution({ ...reference, agentSessionId: agent.id })?.hostId).toBe('local')
    await mount()
    expect(card()).not.toBeNull(); expect(marks()).toEqual(['subject-region'])
    expect(card().querySelector('.focus-context__identity .focus-context__position')).not.toBeNull()
    expect(card().querySelector('.focus-context__identity .focus-context__state [data-focus-state-icon="results"]')).not.toBeNull()
    expect(card().querySelector('.focus-context__detail .focus-context__recap')?.textContent).toBe(originalReply)
    expect(card().querySelector('.focus-context__copy > .focus-context__detail')).not.toBeNull()
    expect(card().querySelector('.focus-context__recap > svg')).toBeNull()
    expect(card().querySelector('.focus-context__open')).toBeNull()
    expect(card().querySelector('button, [tabindex], [aria-pressed]')).toBeNull()
    expect(card().getAttribute('aria-label')).toContain('Last assistant message (timeline)')
    expect(card().querySelector('[data-region-id="subject-region"] [data-executor-id="configured"]')).not.toBeNull()
    expect(card().querySelector('[data-region-id="subject-region"] [data-avatar-badge="shield"]')).not.toBeNull()
  })

  it('uses the same exact highlighted map in the original keyboard reading preview', async () => {
    await mount(); await act(async () => card().focus())
    expect(fullPreview()).not.toBeNull(); expect(topologyPreview()).toBeNull()
    const regions = fullPreview()!.querySelectorAll<HTMLElement>('.workbench-topology__inspector-regions__region[data-subject-region="true"]')
    expect(regions).toHaveLength(1); expect(regions[0]!.dataset.regionId).toBe('subject-region')
    expect(regions[0]!.textContent).toContain('Current Agent')
    expect(fullPreview()!.textContent).toContain(originalReply)
    expect(fullPreview()!.querySelector('.focus-context-hover__recap small')?.textContent).toContain('Latest reply')
    expect(fullPreview()!.querySelector('.focus-context-hover__workbench')?.textContent).toContain('1 confirmed position')
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })))
    expect(fullPreview()).toBeNull()
  })

  it('keeps Region hover exclusive from the original body preview and re-enters body reading', async () => {
    const history = vi.spyOn(api.sessions, 'historyPage'), launch = vi.spyOn(api.sessions, 'launchAgent')
    await mount(); history.mockClear(); launch.mockClear()
    const identity = card().querySelector<HTMLElement>('.focus-context__position')!
    expect(identity).not.toBeNull()
    await pointer(identity, 'pointerover')
    await act(async () => identity.querySelector('.workbench-topology')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    await new Promise(resolve => setTimeout(resolve, 220))
    expect(topologyPreview()).not.toBeNull(); expect(fullPreview()).toBeNull(); expect(history).not.toHaveBeenCalled()
    const regions = topologyPreview()!.querySelectorAll<HTMLElement>('[data-subject-region="true"]')
    expect(regions).toHaveLength(1); expect(regions[0]!.dataset.regionId).toBe('subject-region')
    const body = card().querySelector('.focus-context__detail')!
    await act(async () => identity.querySelector('.workbench-topology')!.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: body })))
    await pointer(identity, 'pointerout', body)
    await new Promise(resolve => setTimeout(resolve, 220))
    expect(topologyPreview()).toBeNull(); expect(fullPreview()).not.toBeNull(); expect(launch).not.toHaveBeenCalled()
    await pointer(body, 'pointerout', identity)
    await pointer(identity, 'pointerover', body)
    await act(async () => body.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: identity.querySelector('.workbench-topology')! })))
    await act(async () => identity.querySelector('.workbench-topology')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: body })))
    expect(topologyPreview()).not.toBeNull(); expect(fullPreview()).toBeNull()
    await act(async () => card().focus())
    expect(fullPreview()).not.toBeNull(); expect(topologyPreview()).toBeNull()
  })

  it.each(['Escape', 'context menu'])('dismisses the shared Region inspector for %s without taking over the card', async dismissal => {
    await mount()
    const identity = card().querySelector('.workbench-topology')!
    expect(identity).not.toBeNull()
    await act(async () => identity.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    expect(topologyPreview()).not.toBeNull()
    await act(async () => {
      if (dismissal === 'Escape') document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }))
      else card().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 100, clientY: 40 }))
    })
    if (dismissal === 'context menu') expect(document.querySelector('.focus-context-menu')).not.toBeNull()
    expect(topologyPreview()).toBeNull(); expect(fullPreview()).toBeNull()
    expect(useAppStore.getState().agentFocus.execution.sessionId).toBeNull()
  })

  it.each(['other-host', ''])('keeps the Executor and original navigation when execution Host is %s', async host => {
    await refreshCoreGraph(host); await mount()
    expect(card()).not.toBeNull(); expect(card().querySelector('.focus-context__position')).toBeNull()
    expect(card().querySelector('.focus-context__identity .agent-avatar')).not.toBeNull()
    expect(card().querySelector('.focus-context__detail')!.textContent).toBe(originalReply)
    const control = useAppStore.getState().sessions.find(session => session.id === agent.id)!.control
    await act(async () => card().click())
    expect(useAppStore.getState().agentFocus.execution.sessionId).toBe(agent.id)
    expect(useAppStore.getState().sessions.find(session => session.id === agent.id)!.control).toBe(control)
  })

  it('uses the original Executor for a single Region and keeps the exact original navigation', async () => {
    const single = createWorkbenchTab(tab.id, { kind: 'agent', phase: 'attached', regionId: reference.regionId, workspaceId: workspace.id, sessionId: agent.id })
    useAppStore.setState({ tabs: { [single.id]: single } }); await refreshCoreGraph(); await mount()
    expect(card().querySelector('.focus-context__position')).toBeNull()
    expect(card().querySelector('.focus-context__identity [data-executor-id="configured"]')).not.toBeNull()
    expect(card().querySelector('.focus-context__identity [data-avatar-badge="shield"]')).not.toBeNull()
    await act(async () => card().click())
    expect(useAppStore.getState().agentFocus.execution.reference).toEqual(reference)
    expect(useAppStore.getState().tabs[single.id]).toBe(single)
  })

  it('keeps the retained Executor appearance through the shared split identity', async () => {
    const config = useAppStore.getState().config!
    const { avatar: _avatar, ...configured } = config.executors.configured!
    useAppStore.setState({ config: { ...config, executors: { ...config.executors, configured },
      appearance: { ...config.appearance, agentAvatars: { configured: { badge: 'shield' } } } } })
    await mount()
    expect(card().querySelector('[data-region-id="subject-region"] [data-avatar-badge="shield"]')).not.toBeNull()
  })

  it('keeps readonly identity input on the original card navigation path', async () => {
    await mount()
    const chip = card().querySelector<HTMLElement>('.workbench-topology__tab-chip')!
    expect(chip).not.toBeNull()
    const keys: string[] = []
    card().addEventListener('keydown', event => keys.push(event.key))
    await act(async () => { for (const key of ['Enter', ' ']) chip.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key })) })
    expect(keys).toEqual(['Enter', ' '])
    await act(async () => chip.click())
    expect(useAppStore.getState().agentFocus.execution.reference).toEqual(reference)
  })

  it('retains all exact positions and every same-Tab Agent Region rather than choosing an active or first Region', async () => {
    const multiple = addWorkbenchRegion(tab, reference.regionId, 'down', { kind: 'agent', phase: 'attached', regionId: 'subject-copy', workspaceId: workspace.id, sessionId: agent.id })
    const another = createWorkbenchTab('second-subject-tab', { kind: 'agent', phase: 'attached', regionId: 'other-subject', workspaceId: workspace.id, sessionId: agent.id })
    useAppStore.setState({ tabs: { [multiple.id]: multiple, [another.id]: another }, layouts: { [workspace.id]: createWorkspaceLayout(reference.groupId, [multiple.id, another.id]) } })
    await refreshCoreGraph(); await mount()
    expect(marks()).toEqual(['subject-region', 'subject-copy'])
    expect(card().querySelectorAll('.workbench-topology__tab-chip')).toHaveLength(2)
    expect(card().querySelector('.focus-context__position')?.getAttribute('aria-label')).toBe('3 confirmed positions')
    await act(async () => card().focus())
    expect(fullPreview()!.querySelectorAll('[data-subject-region="true"]')).toHaveLength(3)
    expect(fullPreview()!.querySelector('.focus-context-hover__workbench')?.textContent).toContain('3 confirmed positions')
  })

  it('retains separate Group occurrences of one original Tab in both readonly and keyboard previews', async () => {
    const layout = createWorkspaceLayout(reference.groupId, [tab.id]), other = { ...layout.groups[0]!, id: 'second-exact-group' }
    const duplicated = { ...layout, root: { type: 'split' as const, direction: 'horizontal' as const, ratio: .5,
      first: layout.root, second: { type: 'leaf' as const, groupId: other.id } }, groups: [other, ...layout.groups] }
    assertGroupInvariant(duplicated)
    useAppStore.setState({ layouts: { [workspace.id]: duplicated } })
    await refreshCoreGraph(); await mount()
    expect(card().querySelector('.focus-context__position')?.getAttribute('aria-label')).toBe('2 confirmed positions')
    const chips = [...card().querySelectorAll<HTMLElement>('.workbench-topology__tab-chip')]
    expect(chips).toHaveLength(2); expect(marks()).toEqual(['subject-region', 'subject-region'])
    expect(chips.map(chip => chip.getAttribute('aria-label'))).toEqual([expect.stringContaining('Project · Group 2'), expect.stringContaining('Project · Group 1')])
    await act(async () => chips[1]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    expect(topologyPreview()!.textContent).toContain('Project · Group 1')
    await act(async () => card().focus())
    const maps = [...fullPreview()!.querySelectorAll<HTMLElement>('[data-focus-occurrence-key]')]
    expect(maps).toHaveLength(2)
    expect(maps.map(map => map.dataset.focusOccurrenceKey)).toEqual([other.id, reference.groupId].map(group => JSON.stringify([workspace.id, group, tab.id])))
    expect(maps.map(map => map.querySelector('.focus-context-hover__position-label')?.textContent)).toEqual(['Project · Group 2', 'Project · Group 1'])
    for (const map of maps) expect(map.querySelectorAll('[data-subject-region="true"]')).toHaveLength(1)
    expect(useAppStore.getState().layouts[workspace.id]).toBe(duplicated)
  })

  it('keeps detached Tabs and moved or rebound Regions out of optional position decoration', async () => {
    useAppStore.setState({ layouts: {} }); await refreshCoreGraph(); await mount()
    expect(card().querySelector('.focus-context__position')).toBeNull()
    const original = useAppStore.getState().tabs
    await act(async () => useAppStore.setState({ tabs: { [tab.id]: { ...tab, regions: { ...tab.regions,
      'subject-region': { ...tab.regions['subject-region']!, sessionId: neighbor.id } as typeof tab.regions[string] } } },
      layouts: { [workspace.id]: createWorkspaceLayout(reference.groupId, [tab.id]) } }))
    expect(card().querySelector('.focus-context__position')).toBeNull()
    expect(useAppStore.getState().tabs).not.toBe(original)
    expect(card().querySelector('.focus-context__detail')!.textContent).toBe(originalReply)
  })

  it('keeps original Run identity and untouched card props stable during unrelated Session updates', async () => {
    const other = composerSession('unrelated-agent')
    useAppStore.setState(state => ({ sessions: [...state.sessions, other] }))
    await mount(); const count = commits[agent.id], control = useAppStore.getState().sessions.find(session => session.id === agent.id)!.control
    await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === other.id
      ? { ...session, status: { ...session.status, detail: 'Unrelated service detail' } } : session) })))
    expect(commits[agent.id]).toBe(count); expect(marks()).toEqual(['subject-region'])
    expect(useAppStore.getState().sessions.find(session => session.id === agent.id)!.control).toBe(control)
    await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === other.id
      ? { ...session, latestOutputBytes: session.latestOutputBytes + 100 } : session) })))
    expect(commits[agent.id]).toBe(count)
  })

  it('does not repeat identity work for unrelated Browser page and navigation updates', async () => {
    const browser = createWorkbenchTab('unrelated-browser-tab', { kind: 'browser', workspaceId: workspace.id, regionId: 'unrelated-browser-region',
      id: 'existing-browser', browserId: 'existing-browser', navigationId: 'original-navigation', profileId: 'original-profile',
      url: 'https://example.test/', title: 'Original page', loading: false, canGoBack: false, canGoForward: false,
      viewport: 'responsive', error: null, driving: false, appLinkPrompt: null })
    useAppStore.setState({ tabs: { [tab.id]: tab, [browser.id]: browser }, layouts: { [workspace.id]: createWorkspaceLayout(reference.groupId, [tab.id, browser.id]) } })
    await refreshCoreGraph(); await mount()
    const executions = vi.spyOn(store, 'agentRegionExecution'), count = commits[agent.id]
    await act(async () => useAppStore.setState(state => ({ tabs: { ...state.tabs, [browser.id]: { ...browser, regions: { ...browser.regions,
      'unrelated-browser-region': { ...browser.regions['unrelated-browser-region']!, title: 'Later page', navigationId: 'later-navigation' } as typeof browser.regions[string] } } } })))
    expect(executions).not.toHaveBeenCalled(); expect(commits[agent.id]).toBe(count); expect(marks()).toEqual(['subject-region'])
  })

  it('keeps SurfaceToolDock on its original row content and does not move its Executor into the header', async () => {
    const context = agentContextForSession(agent, timeline, 'FOCUS', workspace, null)
    await dom.render(<button className="workspace-agent-row focus-context"><AgentContextContent context={context} /></button>)
    expect(dom.container.querySelector('button > .focus-context__avatar')).not.toBeNull()
    expect(dom.container.querySelector('.focus-context__identity .focus-context__avatar')).toBeNull()
    expect(dom.container.querySelector('.focus-context__recap > svg')).not.toBeNull()
  })
})
