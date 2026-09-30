// @vitest-environment happy-dom
import { act, createElement, useEffect } from 'react'
import { readFileSync } from 'node:fs'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout, splitWorkbenchRegion } from '@agentmux/layout'
import type { SessionSnapshot } from '../src/shared/contracts'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { App } from '../src/renderer/src/App'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { PMO_FLOATING_TAB_SLOT_PREFIX } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { collectTerminalColdParkCandidates } from '../src/renderer/src/lib/terminal-cold-parking-coordinator'
import { collectSurfaceMemoryCandidates } from '../src/renderer/src/lib/surface-memory-budget-candidates'
import { PmoTeamsTopicFloatingPanel } from '../src/renderer/src/components/PmoTeamsTopicFloatingPanel'
// Load the installed browser primary so original real Panel registration precedes layout effects.
vi.mock('react-resizable-panels', async () => {
  const { createRequire } = await import('node:module')
  return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js')
})
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'

const renderer = vi.hoisted(() => ({ mounted: new Map<string, number>(), unmounted: new Map<string, number>() }))
vi.mock('../src/renderer/src/components/SessionPane', () => ({
  SessionPane: ({ sessionId }: { sessionId: string }) => {
    useEffect(() => {
      renderer.mounted.set(sessionId, (renderer.mounted.get(sessionId) ?? 0) + 1)
      return () => { renderer.unmounted.set(sessionId, (renderer.unmounted.get(sessionId) ?? 0) + 1) }
    }, [])
    return createElement('div', { 'data-rendered-terminal': sessionId }, sessionId)
  }
}))

vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: ({ session }: { session: SessionSnapshot }) => createElement('div', { 'data-warm-terminal': session.id }) }))

const initial = useAppStore.getState()
const containers: HTMLElement[] = []
const roots: Root[] = []
afterEach(async () => {
  await act(async () => roots.splice(0).forEach(root => root.unmount()))
  containers.splice(0).forEach(container => container.remove())
  renderer.mounted.clear(); renderer.unmounted.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  useAppStore.setState(initial, true)
})

function session(id: string): SessionSnapshot {
  return { id, kind: 'terminal', providerId: null, hostId: 'local', workspacePath: '/topics', label: 'Terminal',
    processState: 'running', createdAt: 1, updatedAt: 1, latestOutputBytes: 0,
    status: { state: 'running', source: 'run-process', observedAt: 1 },
    control: { kind: 'terminal', hostId: 'local', runId: id, run: { runId: id } } }
}

function seed() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const ordinary = createWorkbenchTab('ordinary-tab', { regionId: 'ordinary-region', kind: 'terminal', phase: 'attached',
    workspaceId: SCRATCH_WORKSPACE_ID, sessionId: 'ordinary-run' })
  const mote = createWorkbenchTab('mote-tab', { regionId: 'mote-region', kind: 'terminal', phase: 'attached',
    workspaceId: SCRATCH_WORKSPACE_ID, sessionId: 'mote-run' })
  useAppStore.setState({ config: { ...initial.config!, version: 9,
    hosts: [{ id: 'local', kind: 'local', label: 'Fixture' }], executors: {}, appearance: { terminalTheme: 'graphite' },
    workspaces: [{ id: SCRATCH_WORKSPACE_ID, hostId: 'local', name: 'Topics', path: '/topics', kind: 'folder' }] },
    tabs: { [ordinary.id]: { ...ordinary, topicId: 'launcher:ordinary' }, [mote.id]: { ...mote, topicId: PMO_TEAMS_TOPIC_ID } },
    layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('group', [ordinary.id, mote.id]) },
    sessions: [session('ordinary-run'), session('mote-run')],
    activeWorkspaceId: SCRATCH_WORKSPACE_ID, mainSurface: 'workbench', prewarmTerminal: vi.fn(), detectExecutors: vi.fn(async () => {}) })
  useAppStore.getState().activateTab(SCRATCH_WORKSPACE_ID, 'group', ordinary.id)
  const container = document.createElement('div'); document.body.append(container); containers.push(container)
  const root = createRoot(container); roots.push(root)
  return { ordinary, mote, root, container }
}

it('does not mount a second ordinary Topic terminal when the resident Mote projection is present', async () => {
  const h = seed()
  await act(async () => h.root.render(createElement('div', {},
    createElement(WorkspaceWorkbench, { workspaceId: SCRATCH_WORKSPACE_ID }),
    createElement(PmoTeamsTopicFloatingPanel, { floating: { open: false, preview: false, size: { width: 720, height: 520 } }, setFloating: vi.fn() })
  )))
  expect(Object.values(useAppStore.getState().tabs).flatMap(tab => Object.values(tab.regions)).filter(region => region.kind === 'terminal')).toHaveLength(2)
  expect(useAppStore.getState().sessions).toHaveLength(2)
  // Both Runtime and layout are correct; this was two component trees for one Region.
  expect(h.container.querySelectorAll('[data-rendered-terminal="ordinary-run"]')).toHaveLength(1)
  expect(renderer.mounted.get('ordinary-run')).toBe(1)
})


it('moves the same Mote terminal DOM between main, floating and Focus slots without remounting', async () => {
  const h = seed()
  function render(target?: string, focus = false) {
    return act(async () => h.root.render(createElement('div', {},
      createElement('div', { id: 'focus-view' }),
      createElement(WorkspaceWorkbench, { workspaceId: SCRATCH_WORKSPACE_ID,
        viewTargets: focus ? { [h.mote.id]: { hostId: 'focus-view', active: true, visible: true, surface: 'focus' } }
          : target ? { [h.mote.id]: { hostId: target, active: true, visible: true } } : {} }),
      createElement(WorkspaceWorkbench, { workspaceId: SCRATCH_WORKSPACE_ID, topicId: PMO_TEAMS_TOPIC_ID,
        topicIsolation: 'bound-only', viewOwnership: 'projection', viewHostPrefix: PMO_FLOATING_TAB_SLOT_PREFIX, projectionTabId: h.mote.id,
        visible: Boolean(target) })
    )))
  }
  await render()
  const node = h.container.querySelector('[data-rendered-terminal="mote-run"]')!
  expect(node).not.toBeNull()
  const originalSessions = useAppStore.getState().sessions
  await render(`${PMO_FLOATING_TAB_SLOT_PREFIX}:${h.mote.id}`)
  expect(document.getElementById(`${PMO_FLOATING_TAB_SLOT_PREFIX}:${h.mote.id}`)?.contains(node)).toBe(true)
  await render(`${PMO_FLOATING_TAB_SLOT_PREFIX}:${h.mote.id}`, true)
  expect(document.getElementById('focus-view')?.contains(node)).toBe(true)
  await render()
  expect(document.getElementById(`workbench-tab-slot:${h.mote.id}`)?.contains(node)).toBe(true)
  expect(h.container.querySelectorAll('[data-rendered-terminal="mote-run"]')).toHaveLength(1)
  expect(h.container.querySelectorAll('[data-rendered-terminal="ordinary-run"]')).toHaveLength(1)
  expect(renderer.mounted.get('mote-run')).toBe(1)
  expect(renderer.unmounted.has('mote-run')).toBe(false)
  expect(useAppStore.getState().sessions).toBe(originalSessions)
})

it('opens a Topic once across concurrent metadata reads and leaves its original Terminal on later opens', async () => {
  seed()
  useAppStore.setState({ tabs: {}, layouts: {}, sessions: [] })
  const topic = await api.scratch.ensureTopic(SCRATCH_WORKSPACE_ID, 'launcher:rapid')
  const launch = vi.spyOn(api.sessions, 'launchTerminal').mockResolvedValue(session('created-once'))
  await Promise.all([useAppStore.getState().openScratchTopic(topic.id), useAppStore.getState().openScratchTopic(topic.id)])
  expect(launch).toHaveBeenCalledTimes(1)
  expect(Object.values(useAppStore.getState().tabs)).toHaveLength(1)
  const tab = Object.values(useAppStore.getState().tabs)[0]!
  expect(Object.values(tab.regions)).toEqual([expect.objectContaining({ kind: 'terminal', phase: 'attached', sessionId: 'created-once' })])
  expect(useAppStore.getState().sessions.map(one => one.id)).toEqual(['created-once'])
  const originalLayout = tab.layout
  await useAppStore.getState().openScratchTopic(topic.id)
  expect(useAppStore.getState().tabs[tab.id]?.layout).toBe(originalLayout)
  expect(launch).toHaveBeenCalledTimes(1)
})

it('creates one usable Terminal for an ordinary Topic while Mote creation keeps its agent launcher', async () => {
  seed()
  useAppStore.setState({ tabs: {}, layouts: {}, sessions: [] })
  const launch = vi.spyOn(api.sessions, 'launchTerminal').mockResolvedValue(session('new-topic-terminal'))
  const ordinary = await useAppStore.getState().createScratchTopic()
  const mote = await useAppStore.getState().createScratchTopic('mote')
  const tabs = Object.values(useAppStore.getState().tabs)
  expect(tabs).toHaveLength(2)
  expect(Object.values(tabs.find(one => one.topicId === ordinary.id)!.regions)).toEqual([
    expect.objectContaining({ kind: 'terminal', phase: 'attached', sessionId: 'new-topic-terminal' })
  ])
  expect(Object.values(tabs.find(one => one.topicId === mote.id)!.regions)).toEqual([expect.objectContaining({ kind: 'launcher' })])
  expect(launch).toHaveBeenCalledTimes(1)
})

it('closes a current terminal Tab through its visible close entry and stops only that Terminal', async () => {
  const h = seed()
  const stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue(undefined)
  await act(async () => h.root.render(createElement(WorkspaceWorkbench, { workspaceId: SCRATCH_WORKSPACE_ID })))
  const style = document.createElement('style')
  style.textContent = readFileSync('apps/desktop/src/renderer/src/styles/workbench.css', 'utf8')
  document.head.append(style); containers.push(style)
  const button = h.container.querySelector<HTMLElement>('[data-workbench-tab-id="ordinary-tab"] .workbench-tab__close')!
  expect(button).not.toBeNull()
  expect(Number(getComputedStyle(button).opacity)).toBeGreaterThan(0)
  expect(button.getAttribute('title')).toBe('Close Terminal')
  expect(button.getAttribute('aria-label')).toBe('Close Terminal')
  await act(async () => { button.click(); await vi.waitFor(() => expect(useAppStore.getState().tabs[h.ordinary.id]).toBeUndefined()) })
  expect(stop).toHaveBeenCalledExactlyOnceWith(session('ordinary-run').control)
  expect(useAppStore.getState().tabs[h.mote.id]?.regions['mote-region']).toMatchObject({ sessionId: 'mote-run', phase: 'attached' })
})

it('closes only the chosen split projection and preserves another healthy Terminal and draft', async () => {
  const h = seed()
  const split = { ...h.ordinary, topicId: 'launcher:ordinary', layout: splitWorkbenchRegion(h.ordinary.layout, 'ordinary-region', 'right', 'second-region'),
    regions: { ...h.ordinary.regions, 'second-region': { regionId: 'second-region', kind: 'terminal' as const,
      phase: 'attached' as const, workspaceId: SCRATCH_WORKSPACE_ID, sessionId: 'second-run' } } }
  useAppStore.setState({ tabs: { ...useAppStore.getState().tabs, [split.id]: split }, sessions: [...useAppStore.getState().sessions, session('second-run')],
    agentComposerDrafts: { 'mote-run': 'An untouched unsent draft' } })
  const stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue(undefined)
  await act(async () => h.root.render(createElement(WorkspaceWorkbench, { workspaceId: SCRATCH_WORKSPACE_ID })))
  const style = document.createElement('style')
  style.textContent = readFileSync('apps/desktop/src/renderer/src/styles/workbench.css', 'utf8')
  document.head.append(style); containers.push(style)
  const close = h.container.querySelector<HTMLButtonElement>('[data-workbench-region-id="ordinary-region"] .workbench-region__close')!
  expect(close).not.toBeNull()
  expect(Number(getComputedStyle(close).opacity)).toBeGreaterThan(0)
  expect(close.getAttribute('aria-label')).toBe('Close split')
  await act(async () => { close.click() })
  expect(Object.keys(useAppStore.getState().tabs[split.id]!.regions)).toEqual(['second-region'])
  expect(useAppStore.getState().tabs[split.id]!.regions['second-region']).toMatchObject({ sessionId: 'second-run', phase: 'attached' })
  expect(useAppStore.getState().agentComposerDrafts['mote-run']).toBe('An untouched unsent draft')
  expect(useAppStore.getState().sessions.map(one => one.id)).toEqual(['ordinary-run', 'mote-run', 'second-run'])
  expect(stop).not.toHaveBeenCalled()
})


it('protects only the projected visible Tab from resource parking while its base workspace is hidden', () => {
  const h = seed()
  const input = { tabs: useAppStore.getState().tabs, layouts: useAppStore.getState().layouts,
    sessions: useAppStore.getState().sessions, activeWorkspaceId: null, workbenchVisible: false,
    projectedVisibleTabIds: new Set([h.mote.id]) }
  expect(collectTerminalColdParkCandidates(input).map(one => ({ id: one.id, visible: one.visible, context: one.navigationContextActive }))).toEqual([
    { id: 'ordinary-region', visible: false, context: false }, { id: 'mote-region', visible: true, context: true }
  ])
  const file = { ...h.mote, regions: { 'mote-region': { regionId: 'mote-region', kind: 'file' as const, workspaceId: SCRATCH_WORKSPACE_ID, path: 'SOUL.md' } } }
  expect(collectSurfaceMemoryCandidates({ ...input, tabs: { [h.mote.id]: file }, documents: {}, dirtyDocuments: {}, savingDocuments: {} }))
    .toEqual([expect.objectContaining({ id: 'mote-region', visible: true, navigationContextActive: true })])
})


it('claims the in-flight reusable shell without the actual launcher prewarming another Terminal', async () => {
  const h = seed()
  useAppStore.setState({ tabs: {}, sessions: [], layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('group') },
    warmTerminal: null, prewarmTerminal: initial.prewarmTerminal })
  let finish!: (one: SessionSnapshot) => void
  const launch = vi.spyOn(api.sessions, 'launchTerminal').mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const allocated = session('original-prewarmed-run')
  // One external fixture producer owns both allocation and its subsequent readback.
  // Store claim/promote and Launcher mounting remain the actual product callers.
  const refresh = vi.spyOn(api.sessions, 'refresh').mockImplementation(async control => {
    expect(control).toEqual(allocated.control)
    return allocated
  })
  await act(async () => h.root.render(createElement(WorkspaceWorkbench, { workspaceId: SCRATCH_WORKSPACE_ID })))
  expect(launch).toHaveBeenCalledTimes(1)
  const originalWarm = useAppStore.getState().warmTerminal
  expect(originalWarm).not.toBeNull()
  const topic = await api.scratch.ensureTopic(SCRATCH_WORKSPACE_ID, 'launcher:claim-warm')
  let opening!: Promise<void>
  await act(async () => { opening = useAppStore.getState().openScratchTopic(topic.id); await Promise.resolve(); await Promise.resolve() })
  const created = Object.values(useAppStore.getState().tabs)
  expect(created).toHaveLength(1)
  expect(Object.values(created[0]!.regions)).toEqual([expect.objectContaining({ kind: 'terminal', phase: 'launching' })])
  expect(launch).toHaveBeenCalledTimes(1)
  await act(async () => { finish(allocated); await opening })
  expect(Object.values(useAppStore.getState().tabs[created[0]!.id]!.regions)).toEqual([
    expect.objectContaining({ kind: 'terminal', phase: 'attached', sessionId: 'original-prewarmed-run' })
  ])
  expect(useAppStore.getState().sessions.map(one => one.id)).toEqual(['original-prewarmed-run'])
  expect(launch).toHaveBeenCalledTimes(1)
  expect(useAppStore.getState().warmTerminal).toBeNull()
  expect(refresh).toHaveBeenCalledExactlyOnceWith(allocated.control)
})


it('background Mote preparation preserves the original Topic selection for existing and new hidden Views', async () => {
  const h = seed()
  await api.scratch.ensureMote(SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID)
  const layout = useAppStore.getState().layouts[SCRATCH_WORKSPACE_ID]!
  const original = useAppStore.getState().tabs[h.ordinary.id]
  const launch = vi.spyOn(api.sessions, 'launchTerminal')
  await useAppStore.getState().openScratchTopic(PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, { reveal: false })
  expect(useAppStore.getState().layouts[SCRATCH_WORKSPACE_ID]).toBe(layout)
  useAppStore.setState({ tabs: { [h.ordinary.id]: original! }, layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('group', [h.ordinary.id]) } })
  const before = useAppStore.getState().layouts[SCRATCH_WORKSPACE_ID]!
  await useAppStore.getState().openScratchTopic(PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, { reveal: false })
  const after = useAppStore.getState().layouts[SCRATCH_WORKSPACE_ID]!
  expect(after.groups[0]!.activeTabId).toBe(h.ordinary.id)
  expect(after.activeGroupId).toBe(before.activeGroupId)
  expect(after.groups[0]!.recentTabIds).toEqual(before.groups[0]!.recentTabIds)
  expect(Object.values(useAppStore.getState().tabs).filter(tab => tab.topicId === PMO_TEAMS_TOPIC_ID)).toHaveLength(1)
  expect(useAppStore.getState().tabs[h.ordinary.id]).toBe(original)
  expect(launch).not.toHaveBeenCalled()
})


it('keeps the actual App window registry through welcome and Board navigation with no active workspace', async () => {
  const h = seed()
  useAppStore.setState({ initialize: vi.fn(async () => () => {}), loading: false, projectRailOpen: false, toolsOpen: false })
  await act(async () => h.root.render(createElement(App)))
  const terminal = h.container.querySelector('[data-rendered-terminal="ordinary-run"]')!
  expect(terminal).not.toBeNull()
  await act(async () => useAppStore.setState({ activeWorkspaceId: null, mainSurface: 'board' }))
  expect(h.container.querySelector('[data-rendered-terminal="ordinary-run"]')).toBe(terminal)
  await act(async () => useAppStore.setState({ mainSurface: 'workbench' }))
  expect(h.container.querySelector('.welcome')).not.toBeNull()
  expect(h.container.querySelector('[data-rendered-terminal="ordinary-run"]')).toBe(terminal)
  await act(async () => useAppStore.setState({ activeWorkspaceId: SCRATCH_WORKSPACE_ID }))
  expect(h.container.querySelector('[data-rendered-terminal="ordinary-run"]')).toBe(terminal)
  expect(renderer.mounted.get('ordinary-run')).toBe(1)
  expect(renderer.unmounted.has('ordinary-run')).toBe(false)
  expect(useAppStore.getState().sessions.map(one => one.id)).toEqual(['ordinary-run', 'mote-run'])
})
