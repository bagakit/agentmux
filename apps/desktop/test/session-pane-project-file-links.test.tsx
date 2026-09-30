// @vitest-environment happy-dom
import { act, Profiler, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AppConfig, SessionSnapshot, WorkspaceRecord } from '../src/shared/contracts'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { directoryIdentity, workspaceZoneId } from '../src/shared/space-addresses'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { App } from '../src/renderer/src/App'
import { api } from '../src/renderer/src/lib/api'
import * as projectOwner from '../src/renderer/src/lib/goal-project-context'
import type { DemandRecord } from '../src/renderer/src/lib/global-demand-board'
import { createWorkbenchTab, fileTabId, documentKey } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { workbenchProjectionSlotId } from '../src/renderer/src/lib/workbench-projection'
import { installNativePopover } from './fixtures/mote-workface'

// The complete Pane → Activity → Conversation → Markdown chain, Store and File reducer stay real.
// Unrelated terminal/composer leaves and remote I/O are bounded test doubles. Local reads use Main.
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div data-terminal /> }))
vi.mock('../src/renderer/src/components/AgentSessionComposer', () => ({ AgentSessionComposer: () => <div data-composer /> }))
vi.mock('../src/renderer/src/components/AgentRegionHeader', () => ({ AgentRegionHeader: () => <header>PMO</header> }))
vi.mock('../src/renderer/src/components/SessionHistoryView', () => ({ SessionHistoryView: () => null }))
vi.mock('../src/renderer/src/components/SessionResultReview', () => ({ SessionResultReview: () => null }))
vi.mock('../src/renderer/src/components/AgentLifecycleFeedback', () => ({ AgentLifecycleFeedback: () => null }))
vi.mock('react-resizable-panels', async () => {
  const { createRequire } = await import('node:module')
  return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js')
})
const fileLifetime = vi.hoisted(() => ({ mounts: 0, unmounts: 0, renders: 0 }))
vi.mock('../src/renderer/src/components/EditorPane', () => ({ EditorPane: ({ surface }: { surface: { workspaceId: string; path: string } }) => {
  fileLifetime.renders++
  const document = useAppStore(state => state.documents[documentKey(surface.workspaceId, surface.path)])
  useEffect(() => { fileLifetime.mounts++; return () => { fileLifetime.unmounts++ } }, [])
  return <pre data-project-file-editor>{document?.content}</pre>
} }))


const initial = useAppStore.getState()
const origin = { workspaceId: SCRATCH_WORKSPACE_ID, tabGroupId: 'pmo-group', tabId: 'pmo-tab', regionId: 'pmo-region', sessionId: 'pmo' }
let tinyRoot: string, project: WorkspaceRecord, scratch: WorkspaceRecord, config: AppConfig
let root: Root, container: HTMLDivElement, files: WorkspaceFiles
let commits = 0, restorePopover: (() => void) | undefined
function agent(id = 'pmo', workspacePath = scratch.path): Extract<SessionSnapshot, { kind: 'agent' }> {
  return { id, kind: 'agent', providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath,
    label: id, createdAt: 1, updatedAt: 1, agentSessionUpdatedAt: 1, processState: 'running',
    status: { state: 'running', source: 'run-process', observedAt: 1 }, latestOutputBytes: 0,
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `original-run-${id}` } } }
}
function goal(id = 'goal', projectId = directoryIdentity(project.hostId, project.path)): DemandRecord {
  return { id, title: 'Project investigation', description: '', status: 'backlog', priority: 'normal', projectId,
    projectName: project.name, sessionIds: [], createdAt: 1, updatedAt: 1, source: 'session' }
}
function seed(content: string, mapped = true) {
  const tab = createWorkbenchTab(origin.tabId, { kind: 'agent', phase: 'attached', regionId: origin.regionId,
    workspaceId: scratch.id, sessionId: 'pmo' })
  useAppStore.setState({ ...initial, config, localHome: homedir(), sessions: [agent()], viewModes: { pmo: 'activity' },
    pendingAgentLaunches: {}, recoveryCandidates: [], runtimeOwnershipWarnings: [],
    timelines: { pmo: { agentSessionId: 'pmo', revision: 1, items: [{ id: 'body', agentSessionId: 'pmo',
      kind: 'assistant_message', title: 'Project findings', content, source: 'native-hook', status: 'complete', createdAt: 100, updatedAt: 100 }] } },
    tabs: { [tab.id]: tab }, layouts: { [scratch.id]: createWorkspaceLayout(origin.tabGroupId, [tab.id]),
      [project.id]: createWorkspaceLayout('project-group') }, activeWorkspaceId: scratch.id, mainSurface: 'workbench',
    demands: { goal: goal(), unrelated: goal('unrelated') }, demandPmoTabIds: mapped ? { goal: tab.id } : {},
    documents: {}, documentIssues: {}, documentRevealTargets: {}, agentNames: {}, agentComposerDrafts: { pmo: 'KEEP DRAFT' },
    retainedSpatialFocus: null, workbenchNavigationInputPolicy: null, error: null })
}
async function flush() { await act(async () => { for (let n = 0; n < 12; n++) await Promise.resolve() }) }
async function mount() {
  await act(async () => root.render(<Profiler id="original-pane" onRender={() => { commits++ }}>
    <SessionPane sessionId="pmo" surfaceKind="agent" visible interactiveResize={false} linkOrigin={origin} />
  </Profiler>))
  await flush()
}
function buttons() { return [...container.querySelectorAll<HTMLButtonElement>('button.md-link--file')] }
async function click(button: HTMLButtonElement) {
  await act(async () => { button.click(); await vi.waitFor(() => expect(Object.keys(useAppStore.getState().documents).length).toBeGreaterThan(0), { timeout: 2000, interval: 20 }) })
  await flush()
}
function retained() {
  const state = useAppStore.getState()
  expect(state.sessions).toEqual([agent()])
  expect(state.tabs[origin.tabId]?.regions[origin.regionId]).toMatchObject({ sessionId: 'pmo', workspaceId: scratch.id })
  expect(state.agentComposerDrafts.pmo).toBe('KEEP DRAFT')
  expect(container.querySelector('[data-composer]')).not.toBeNull()
}
function placed(workspace = project) {
  const state = useAppStore.getState(), id = fileTabId(workspace.id, 'src/a.ts')
  expect(state.tabs[id]?.regions[state.tabs[id]!.layout.activeRegionId]).toMatchObject({ kind: 'file', workspaceId: workspace.id, path: 'src/a.ts' })
  expect(state.layouts[scratch.id]?.groups.find(group => group.id === origin.tabGroupId)?.tabOrder).toEqual([origin.tabId, id])
  if (workspace.id === project.id) {
    const space = directoryIdentity(workspace.hostId, workspace.path)
    expect(state.tabs[id]?.space).toEqual({ spaceId: space, zoneId: workspaceZoneId(space, workspace.id) })
    expect(state.layouts[project.id]?.groups[0]?.tabOrder).toEqual([])
  }
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  localStorage.clear()
  tinyRoot = await mkdtemp(join(homedir(), '.agentmux-project-link-proof-'))
  project = { id: 'project-resource', name: 'Project Alpha', hostId: 'local', path: join(tinyRoot, 'project'), kind: 'folder' }
  scratch = { id: SCRATCH_WORKSPACE_ID, name: 'Topics', hostId: 'local', path: join(tinyRoot, 'scratch'), kind: 'folder' }
  for (const workspace of [project, scratch]) {
    await mkdir(join(workspace.path, 'src'), { recursive: true })
    await writeFile(join(workspace.path, 'src/a.ts'), workspace.id === project.id ? 'REAL PROJECT CONTENT' : 'WRONG SCRATCH CONTENT')
  }
  config = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private local Host' }], workspaces: [project, scratch],
    executors: { codex: { providerId: 'codex', label: 'Codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true } },
    appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  files = new WorkspaceFiles(id => ({ id, kind: 'local' }) as never)
  vi.spyOn(api.sessions, 'historyPage').mockImplementation(async control => ({ agentSessionId: control.agentSessionId,
    source: { providerId: 'codex', nativeSessionId: 'proof' }, items: [], nextCursor: null }))
  vi.spyOn(api.files, 'observe').mockResolvedValue(undefined)
  vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined)
  vi.spyOn(api.files, 'read').mockImplementation(async (workspaceId, path) => {
    const workspace = useAppStore.getState().config!.workspaces.find(item => item.id === workspaceId)!
    return files.read(workspace, path)
  })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container); commits = 0
  fileLifetime.mounts = 0; fileLifetime.unmounts = 0; fileLifetime.renders = 0
})

describe('original App resource owner and ordinary display', () => {
  async function openInApp() {
    seed('Read src/a.ts:2:3.')
    useAppStore.setState(state => ({ initialize: async () => () => {}, loading: false,
      layouts: { [scratch.id]: state.layouts[scratch.id]! }, toolsOpen: false, projectRailOpen: false }))
    restorePopover = installNativePopover()
    await act(async () => { await import('../src/renderer/src/components/FileSurfaceView'); await import('../src/renderer/src/components/EditorPane') })
    await act(async () => root.render(<App />)); await flush()
    expect(buttons()).toHaveLength(1); await click(buttons()[0]!)
    await vi.waitFor(async () => { await flush(); expect(container.querySelector('[data-project-file-editor]')).not.toBeNull() })
    const id = fileTabId(project.id, 'src/a.ts'), tab = useAppStore.getState().tabs[id]!
    const slotId = workbenchProjectionSlotId('workbench-tab-slot', { displayWorkspaceId: scratch.id, groupId: origin.tabGroupId, tabId: id })
    const slot = document.getElementById(slotId)!
    expect(slot).not.toBeNull(); expect(slot.querySelector('[data-project-file-editor]')?.textContent).toBe('REAL PROJECT CONTENT')
    expect(slot.textContent).not.toContain('still restoring')
    expect(container.querySelectorAll(`[data-workbench-region-id="${tab.layout.activeRegionId}"]`)).toHaveLength(1)
    expect(fileLifetime.mounts).toBe(1); expect(fileLifetime.unmounts).toBe(0)
    expect(useAppStore.getState().layouts[project.id]).toBeUndefined()
    expect(vi.mocked(api.files.read).mock.calls).toEqual([[project.id, 'src/a.ts']]); retained()
    return slot.querySelector('[data-project-file-editor]')!
  }
  it('moves the single Project File body to its original display without requiring a resource layout', async () => {
    await openInApp()
    expect(useAppStore.getState().layouts[scratch.id]?.groups[0]?.tabOrder).toEqual([origin.tabId, fileTabId(project.id, 'src/a.ts')])
    expect(useAppStore.getState().documentRevealTargets[documentKey(project.id, 'src/a.ts')]).toMatchObject({ line: 2, column: 3 })
  })
  it('retains the same mounted resource body through a missing display layout and exact recovery', async () => {
    const editor = await openInApp(), layout = useAppStore.getState().layouts[scratch.id]!
    await act(async () => useAppStore.setState({ layouts: {} }))
    expect(container.querySelector('[data-project-file-editor]')).toBe(editor)
    expect(container.textContent).toContain('still restoring')
    await act(async () => useAppStore.setState({ layouts: { [scratch.id]: layout } }))
    expect(container.querySelector('[data-project-file-editor]')).toBe(editor)
    expect(fileLifetime.mounts).toBe(1); expect(fileLifetime.unmounts).toBe(0); retained()
  })
  it('does not repeat File paint, context work or read for unrelated Session output', async () => {
    const context = vi.spyOn(projectOwner, 'goalProjectContext'), editor = await openInApp()
    expect(context.mock.calls.length).toBeGreaterThan(0); expect(fileLifetime.renders).toBeGreaterThan(0)
    const before = { context: context.mock.calls.length, paint: fileLifetime.renders, read: vi.mocked(api.files.read).mock.calls.length }
    await act(async () => useAppStore.setState(state => ({ sessions: [...state.sessions, agent('unrelated', '/other')],
      timelines: { ...state.timelines, unrelated: { agentSessionId: 'unrelated', revision: 3, items: [] } } })))
    await flush()
    expect({ context: context.mock.calls.length, paint: fileLifetime.renders, read: vi.mocked(api.files.read).mock.calls.length }).toEqual(before)
    expect(container.querySelector('[data-project-file-editor]')).toBe(editor)
  })
  it('retains an owned parked resource Tab when its confirmed home membership disappears', async () => {
    await openInApp()
    const parked = createWorkbenchTab('parked-resource', { kind: 'file', regionId: 'parked-region', workspaceId: project.id, path: 'parked.ts' })
    await act(async () => useAppStore.setState(state => ({ tabs: { ...state.tabs, [parked.id]: parked },
      documents: { ...state.documents, [documentKey(project.id, 'parked.ts')]: { path: 'parked.ts', content: 'PARKED ORIGINAL', revision: 'parked' } },
      layouts: { ...state.layouts, [project.id]: createWorkspaceLayout('resource-home', [parked.id]) } })))
    await vi.waitFor(async () => { await flush(); expect(container.querySelector('[data-workbench-region-id="parked-region"] [data-project-file-editor]')).not.toBeNull() })
    const view = container.querySelector('[data-workbench-region-id="parked-region"] [data-project-file-editor]')!
    expect(view.textContent).toBe('PARKED ORIGINAL'); expect(fileLifetime.mounts).toBe(2)
    await act(async () => useAppStore.setState(state => ({ layouts: { ...state.layouts, [project.id]: createWorkspaceLayout('resource-home') } })))
    expect(container.querySelector('[data-workbench-region-id="parked-region"] [data-project-file-editor]')).toBe(view)
    expect(fileLifetime.mounts).toBe(2); expect(fileLifetime.unmounts).toBe(0)
    expect(useAppStore.getState().tabs[parked.id]).toBe(parked)
  })
  it('keeps the same display host during recovery even when its resource home is available', async () => {
    const editor = await openInApp(), state = useAppStore.getState(), id = fileTabId(project.id, 'src/a.ts')
    const displayLayout = state.layouts[scratch.id]!, resourceLayout = createWorkspaceLayout('resource-home', [id])
    await act(async () => useAppStore.setState({ layouts: { [scratch.id]: displayLayout, [project.id]: resourceLayout } }))
    const displaySlot = editor.closest('[data-workbench-tab-id]')!
    expect(displaySlot.getAttribute('data-workbench-group-id')).toBe(origin.tabGroupId)
    await act(async () => useAppStore.setState({ layouts: { [project.id]: resourceLayout } }))
    expect(displaySlot.contains(editor)).toBe(true)
    await act(async () => useAppStore.setState({ layouts: { [scratch.id]: displayLayout, [project.id]: resourceLayout } }))
    expect(displaySlot.contains(editor)).toBe(true); expect(fileLifetime.mounts).toBe(1); expect(fileLifetime.unmounts).toBe(0)
    await act(async () => useAppStore.setState({ layouts: { [scratch.id]: createWorkspaceLayout(origin.tabGroupId, [origin.tabId]), [project.id]: resourceLayout } }))
    expect(displaySlot.contains(editor)).toBe(false)
    expect(editor.closest('[data-workbench-group-id]')?.getAttribute('data-workbench-group-id')).toBe('resource-home')
    expect(useAppStore.getState().tabs[id]).toBe(state.tabs[id]); expect(fileLifetime.mounts).toBe(1); expect(fileLifetime.unmounts).toBe(0)
  })
  it('moves the single existing body to the explicitly selected duplicate occurrence', async () => {
    const editor = await openInApp(), state = useAppStore.getState(), id = fileTabId(project.id, 'src/a.ts'), layout = state.layouts[scratch.id]!
    const another = createWorkspaceLayout('explicit-other-group', [id]).groups[0]!
    await act(async () => useAppStore.setState({ layouts: { [scratch.id]: { ...layout, root: { type: 'split', direction: 'horizontal', ratio: .5,
      first: layout.root, second: { type: 'leaf', groupId: another.id } }, groups: [...layout.groups, another] } } }))
    expect(useAppStore.getState().layouts[scratch.id]!.groups.map(group => group.tabOrder.includes(id))).toEqual([true, true])
    const otherSlot = document.getElementById(workbenchProjectionSlotId('workbench-tab-slot', { displayWorkspaceId: scratch.id, groupId: another.id, tabId: id }))!
    expect(otherSlot.textContent).toContain('Select this exact Group')
    expect(editor.closest('[data-workbench-group-id]')?.getAttribute('data-workbench-group-id')).toBe(origin.tabGroupId)
    await act(async () => useAppStore.getState().focusTabGroup(scratch.id, another.id))
    expect(editor.closest('[data-workbench-group-id]')?.getAttribute('data-workbench-group-id')).toBe(another.id)
    expect(otherSlot.textContent).not.toContain('Select this exact Group'); expect(otherSlot.contains(editor)).toBe(true)
    expect(container.querySelectorAll(`[data-workbench-region-id="${state.tabs[id]!.layout.activeRegionId}"]`)).toHaveLength(1)
    expect(fileLifetime.mounts).toBe(1); expect(fileLifetime.unmounts).toBe(0)
    expect(vi.mocked(api.files.read).mock.calls).toEqual([[project.id, 'src/a.ts']])
  })
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove()
  restorePopover?.(); restorePopover = undefined
  await files.dispose(); await rm(tinyRoot, { recursive: true, force: true })
  useAppStore.setState(initial, true); vi.restoreAllMocks(); localStorage.clear()
})

describe('current mapped Goal project links through the original mounted Pane', () => {
  it('reads actual Main project bytes for home, inline-code and explicit relative links in the original display group', async () => {
    const home = `~/${relative(homedir(), project.path)}/src/a.ts:12:3`
    seed(`Read ${home}, \`src/a.ts\` and [source](./src/a.ts).`)
    const originalOpen = useAppStore.getState().openFile
    const open = vi.fn(originalOpen); useAppStore.setState({ openFile: open })
    await mount()
    expect(container.textContent).toContain('File links use current Goal project: Project Alpha')
    const actualButtons = buttons(); expect(actualButtons).toHaveLength(3)
    for (const button of actualButtons) await click(button)
    expect(open.mock.calls.map(call => [call[0], call[1], call[2], call[3], call[5]?.displayWorkspaceId])).toEqual([
      ['src/a.ts', 'pmo-group', { line: 12, column: 3 }, project.id, scratch.id],
      ['src/a.ts', 'pmo-group', undefined, project.id, scratch.id],
      ['src/a.ts', 'pmo-group', undefined, project.id, scratch.id]
    ])
    expect(vi.mocked(api.files.read).mock.calls).toEqual([[project.id, 'src/a.ts']])
    expect(useAppStore.getState().documents[documentKey(project.id, 'src/a.ts')]?.content).toBe('REAL PROJECT CONTENT')
    expect(useAppStore.getState().documentRevealTargets[documentKey(project.id, 'src/a.ts')]).toEqual({ line: 12, column: 3 })
    placed(); retained()
    expect(useAppStore.getState().demandPmoTabIds).toEqual({ goal: origin.tabId })
  })
  it('uses remote relative/absolute resources and keeps remote home literal despite matching local paths', async () => {
    project = { ...project, hostId: 'remote' }
    config = { ...config, workspaces: [project, scratch], hosts: [...config.hosts, { id: 'remote', kind: 'ssh', label: 'Remote', hostname: 'proof-host' }] }
    const literal = `~/${relative(homedir(), project.path)}/src/a.ts`
    seed(`Read src/a.ts and \`${project.path}/src/a.ts:8:2\`. Home stays ${literal}.`)
    vi.mocked(api.files.read).mockImplementation(async (workspaceId, path) => {
      expect(useAppStore.getState().config!.workspaces.find(item => item.id === workspaceId)?.hostId).toBe('remote')
      return { status: 'read', document: { path, content: 'REMOTE PROJECT CONTENT', revision: 'remote-1' } }
    })
    await mount(); expect(buttons()).toHaveLength(2)
    expect(container.textContent).toContain(literal)
    expect(container.querySelector('[data-file-reference-scope]')?.textContent).toContain('Home paths are unconfirmed')
    expect(container.querySelector('.service-window')).toBeNull()
    for (const button of buttons()) await click(button)
    expect(vi.mocked(api.files.read).mock.calls).toEqual([[project.id, 'src/a.ts']])
    expect(useAppStore.getState().documents[documentKey(project.id, 'src/a.ts')]?.content).toBe('REMOTE PROJECT CONTENT')
    placed(); retained()
  })
  it.each(['unknown', 'deleted', 'conflict'] as const)('keeps original prose and healthy Pane for %s project association', async mode => {
    seed('Read `src/a.ts` and [source](./src/a.ts).')
    if (mode === 'unknown') useAppStore.setState(state => ({ demands: { ...state.demands, goal: goal('goal', 'unregistered-project') } }))
    if (mode === 'deleted') useAppStore.setState({ demands: {} })
    if (mode === 'conflict') useAppStore.setState({ demandPmoTabIds: { goal: origin.tabId, unrelated: origin.tabId } })
    await mount(); expect(buttons()).toEqual([])
    expect(container.textContent).toContain('src/a.ts')
    expect(container.textContent).toContain('The PMO keeps running')
    expect(container.querySelector('[role="status"]')).not.toBeNull()
    expect(vi.mocked(api.files.read).mock.calls).toEqual([]); retained()
  })
  it('rejects a stale rendered click after reassociation without reading another project or Scratch', async () => {
    seed('Read src/a.ts.'); await mount(); const button = buttons()[0]!; expect(buttons()).toHaveLength(1)
    // Change the owner before React receives its next commit; the old callback must recheck its scope.
    await act(async () => { useAppStore.setState(state => ({ demands: { ...state.demands, goal: goal('goal', 'missing') } })); button.click() })
    await flush(); expect(vi.mocked(api.files.read).mock.calls).toEqual([])
    expect(container.textContent).toContain('unconfirmed'); retained()
  })
  it('keeps a click’s original resource and group during async Goal reassociation and focus movement', async () => {
    seed('Read src/a.ts.'); await mount()
    vi.mocked(api.files.observe).mockImplementation(async () => {
      useAppStore.setState(state => ({ demands: { ...state.demands, goal: goal('goal', 'new-project') }, activeWorkspaceId: project.id }))
    })
    await click(buttons()[0]!)
    expect(vi.mocked(api.files.read).mock.calls).toEqual([[project.id, 'src/a.ts']])
    expect(useAppStore.getState().activeWorkspaceId).toBe(project.id)
    expect(useAppStore.getState().layouts[project.id]?.groups[0]?.tabOrder).toEqual([])
    placed(); retained()
  })
  it('keeps home in both native reasoning reading branches through the common trace', async () => {
    const home = `~/${relative(homedir(), project.path)}/src/a.ts:9:4`
    seed('Read src/a.ts.')
    vi.mocked(api.sessions.historyPage).mockImplementation(async control => ({ agentSessionId: control.agentSessionId,
      source: { providerId: 'codex', nativeSessionId: 'reasoning-proof' }, items: [{ id: 'thinking', kind: 'assistant-message',
        contentParts: [{ kind: 'reasoning', text: `Inspect ${home}.` }] }], nextCursor: null }))
    await mount()
    expect(container.querySelectorAll('.conversation-native-reasoning__record')).toHaveLength(1)
    const trace = container.querySelector<HTMLDetailsElement>('.conversation-native-reasoning details')!
    await act(async () => { trace.open = true; trace.dispatchEvent(new Event('toggle')) })
    expect(buttons()).toHaveLength(2)
    const nativeButton = container.querySelector<HTMLButtonElement>('.conversation-native-reasoning button.md-link--file')!
    await click(nativeButton)
    expect(useAppStore.getState().documentRevealTargets[documentKey(project.id, 'src/a.ts')]).toEqual({ line: 9, column: 4 })
    await act(async () => container.querySelector<HTMLButtonElement>('.conversation-native-reasoning__turn-toggle')!.click())
    expect(container.querySelectorAll('.conversation-native-reasoning__turn .log-turn__trace-body button.md-link--file')).toHaveLength(1)
    expect(vi.mocked(api.files.read).mock.calls).toEqual([[project.id, 'src/a.ts']]); placed(); retained()
  })
  it('retains a previously mapped Pane when its mapping is removed', async () => {
    seed('Read src/a.ts.'); await mount(); expect(buttons()).toHaveLength(1)
    await act(async () => useAppStore.setState({ demandPmoTabIds: {} }))
    expect(buttons()).toEqual([]); expect(container.textContent).toContain('Goal association')
    expect(vi.mocked(api.files.read).mock.calls).toEqual([]); retained()
  })
  it('reports ordinary Session file misses with its own context', async () => {
    seed('Read src/a.ts.', false)
    vi.mocked(api.files.read).mockResolvedValue({ status: 'deleted' })
    await mount()
    await act(async () => { buttons()[0]!.click(); await vi.waitFor(() => expect(vi.mocked(api.files.read).mock.calls).toEqual([[scratch.id, 'src/a.ts']])) })
    await flush()
    expect(container.querySelector('.service-window')).not.toBeNull()
    expect(container.querySelector('.service-window')?.textContent).toContain('original Session keeps running')
    expect(container.querySelector('.service-window')?.textContent).toContain('Session’s original Workspace and Host')
    expect(container.querySelector('.service-window')?.textContent).not.toContain('Goal')
    retained()
  })
  it('retains ordinary non-Goal Session’s own host/path route', async () => {
    seed('Read src/a.ts.', false); await mount(); expect(buttons()).toHaveLength(1); await click(buttons()[0]!)
    expect(vi.mocked(api.files.read).mock.calls).toEqual([[scratch.id, 'src/a.ts']])
    expect(useAppStore.getState().documents[documentKey(scratch.id, 'src/a.ts')]?.content).toBe('WRONG SCRATCH CONTENT')
    placed(scratch); retained()
  })
  it('has positive context/render/read work, then no work amplification from unrelated Goal and Session updates', async () => {
    const context = vi.spyOn(projectOwner, 'goalProjectContext')
    seed('Read src/a.ts.'); await mount(); expect(buttons()).toHaveLength(1); await click(buttons()[0]!)
    expect(context.mock.calls.length).toBeGreaterThan(0); expect(commits).toBeGreaterThan(0)
    expect(vi.mocked(api.files.read).mock.calls).toEqual([[project.id, 'src/a.ts']])
    const baseline = { context: context.mock.calls.length, commits, reads: vi.mocked(api.files.read).mock.calls.length }
    await act(async () => useAppStore.setState(state => ({ demands: { ...state.demands, unrelated: { ...state.demands.unrelated!, title: 'Other Goal changed' } },
      sessions: [...state.sessions, agent('unrelated', '/other/project')], timelines: { ...state.timelines, unrelated: { agentSessionId: 'unrelated', revision: 2, items: [] } } })))
    await flush()
    expect({ context: context.mock.calls.length, commits, reads: vi.mocked(api.files.read).mock.calls.length }).toEqual(baseline)
    await act(async () => useAppStore.setState(state => ({ demands: { ...state.demands, goal: goal('goal', 'unknown-now') } })))
    expect(commits).toBeGreaterThan(baseline.commits)
    expect(context.mock.calls.length).toBeGreaterThan(baseline.context)
    expect(buttons()).toEqual([]); expect(container.textContent).toContain('unconfirmed')
  })
})
