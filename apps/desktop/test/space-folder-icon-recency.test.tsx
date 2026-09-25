// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createWorkspaceLayout } from '@agentmux/layout'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
// The actual App route and ProjectRail stay mounted. Native workbench surfaces are outside this color projection.
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
vi.mock('../src/renderer/src/components/WorkspaceWorkbench', () => ({ WorkspaceWorkbench: () => null }))
import { App } from '../src/renderer/src/App'
import type { AppConfig, RuntimeEvent, SessionSnapshot, WorkspaceRecord } from '../src/shared/contracts'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import * as recency from '../src/renderer/src/lib/space-folder-icon-recency'
import { folderSpaceIconTarget } from '../src/renderer/src/lib/space-object-appearance'
import { workspaceProjectId } from '../src/renderer/src/lib/workspace-projects'
import { addWorkbenchRegion, createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { WorkspaceSidebar } from '../src/renderer/src/components/WorkspaceSidebar'
import { SpaceObjectIcon } from '../src/renderer/src/components/SpaceObjectIcon'
import { ProjectIcon } from '../src/renderer/src/components/ProjectIcon'
import { FocusProjectLanes } from '../src/renderer/src/components/FocusProjectLanes'

const HOUR = 60 * 60_000, NOW = 1_800_000_000_000
const ASSET = 'data:image/svg+xml;base64,PHN2Zy8+'
const CSS = readFileSync(join(import.meta.dirname, '../src/renderer/src/styles/chrome.css'), 'utf8')
const project: WorkspaceRecord = { id: 'project', name: 'Project', hostId: 'local', path: '/repo', kind: 'folder' }
const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Local' }, { id: 'remote', kind: 'ssh', label: 'Remote', hostname: 'private.invalid' }],
  executors: {}, workspaces: [project], appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
const initial = useAppStore.getInitialState()
const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState')
let visibility: DocumentVisibilityState, root: Root | undefined, container: HTMLDivElement, style: HTMLStyleElement

function agent(id: string, observedAt = NOW - 30 * 60_000, source: Extract<SessionSnapshot, { kind: 'agent' }>['status']['source'] = 'native-hook', path = '/repo', hostId = 'local'): Extract<SessionSnapshot, { kind: 'agent' }> {
  return { id, kind: 'agent', providerId: 'codex', executorId: 'codex', hostId, workspacePath: path,
    label: id, createdAt: 1, updatedAt: NOW, agentSessionUpdatedAt: NOW, processState: 'running', latestOutputBytes: 0,
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    status: { state: 'done', source, observedAt }, semanticStatus: { state: 'done', source, observedAt, stateEnteredAt: 1 },
    control: { kind: 'agent', hostId, agentSessionId: id, run: { runId: `run-${id}` } } }
}
function terminal(): SessionSnapshot {
  return { id: 'terminal', kind: 'terminal', providerId: null, hostId: 'local', workspacePath: '/repo', label: 'Terminal',
    createdAt: 1, updatedAt: NOW, processState: 'running', latestOutputBytes: 100,
    status: { state: 'running', source: 'run-process', observedAt: NOW },
    control: { kind: 'terminal', hostId: 'local', runId: 'terminal-run', run: { runId: 'terminal-run' } } }
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); vi.setSystemTime(NOW)
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  useAppStore.setState({ ...initial, config, sessions: [], loading: false, activeWorkspaceId: project.id, mainSurface: 'workbench' }, true)
  vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'repository', icon: ASSET })
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [], timelines: {}, recoveryCandidates: [] })
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue()
  expect(CSS.length).toBeGreaterThan(0)
  style = document.createElement('style'); style.textContent = CSS; document.head.append(style)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined; container.remove(); style.remove()
  useAppStore.setState(initial, true)
  if (originalVisibility) Object.defineProperty(document, 'visibilityState', originalVisibility)
  else Reflect.deleteProperty(document, 'visibilityState')
  vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals()
})
async function mount(sessions: SessionSnapshot[], workspaces: WorkspaceRecord[] = [project], content: ReactNode = <WorkspaceSidebar />) {
  useAppStore.setState({ config: { ...config, workspaces }, sessions })
  await act(async () => root!.render(content))
}
function row(id = project.id) {
  const rows = [...container.querySelectorAll<HTMLButtonElement>('.project-rail-row[data-workspace-id]')]
  expect(rows.length).toBeGreaterThan(0)
  const target = rows.find(node => node.dataset.workspaceId === id)
  expect(target).toBeDefined()
  return target!
}
function image(id = project.id) {
  const shell = row(id).closest('.project-rail-row-shell')
  expect(shell).not.toBeNull()
  const images = [...shell!.querySelectorAll<HTMLImageElement>('img')]
  expect(images).toHaveLength(1)
  expect(images[0]!.getAttribute('src')).toBe(ASSET)
  return images[0]!
}
function expectTone(tone: recency.FolderIconTone, id = project.id) {
  const img = image(id), actual = getComputedStyle(img)
  expect(img.dataset.folderIconRecency).toBe(tone)
  expect(actual.filter).toBe(tone === 'full' ? 'none' : tone === 'subdued' ? 'saturate(.65) brightness(.92)' : 'saturate(.2)')
  expect(Number(actual.opacity)).toBe(tone === 'full' ? 1 : tone === 'subdued' ? .95 : .85)
  expect(img.parentElement?.title).toContain('Git project')
  expect(img.parentElement?.title).toContain(tone === 'unknown' ? 'activity time unknown' : tone === 'quiet' ? 'over 12 hours ago' : tone === 'full' ? 'within 1 hour' : '1–12 hours ago')
}
async function documentVisible(value: DocumentVisibilityState) {
  visibility = value
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
}
async function advance(ms: number) { await act(async () => vi.advanceTimersByTime(ms)) }

it.each([
  [HOUR - 1, 'full'], [HOUR, 'full'], [HOUR + 1, 'subdued'],
  [12 * HOUR - 1, 'subdued'], [12 * HOUR, 'subdued'], [12 * HOUR + 1, 'quiet']
] as const)('actual Sidebar image at age %i uses %s, including both exact inclusive boundaries', async (age, tone) => {
  await mount([agent('owned', NOW - age)])
  expect(useAppStore.getState().sessions).toHaveLength(1)
  expectTone(tone)
})

it.each(['native-hook', 'acp'] as const)('uses the retained %s observation even when display state is neutral or the Run has exited', async source => {
  const session = agent('owned', NOW - 20 * 60_000, source)
  session.semanticStatus!.state = 'running'; session.status = { state: 'running', source: 'run-process', observedAt: NOW }
  session.processState = 'exited'
  await mount([session])
  expectTone('full')
})

it.each(['run-process', 'terminal-output', 'user'] as const)('rejects %s as an activity source on the real image', async source => {
  await mount([agent('owned', NOW, source)])
  expectTone('unknown')
  expect(vi.getTimerCount()).toBe(0)
})

it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, NOW + 1])('rejects invalid/future observation %s without inventing an age', async timestamp => {
  const sessions = [agent('owned', timestamp)]
  await mount(sessions)
  expectTone('unknown')
  expect(recency.folderLastActivityAt(sessions, NOW)).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
})

it('requires the retained semantic fact, and never borrows updatedAt, display running or Terminal activity', async () => {
  const noSemantic = agent('missing', NOW); delete noSemantic.semanticStatus
  await mount([noSemantic, terminal()])
  expect(useAppStore.getState().sessions).toHaveLength(2)
  expectTone('unknown')
  expect(vi.getTimerCount()).toBe(0)
  await act(async () => useAppStore.setState({ sessions: [agent('old', NOW - 20 * HOUR)] }))
  expectTone('quiet')
  expect(image().parentElement?.title).not.toContain('unknown')
})

it('filters each bad time before taking the max, retaining an honest old observation among newer invalid ones', async () => {
  await mount([agent('nan', Number.NaN), agent('old', NOW - 20 * HOUR), agent('future', NOW + 1000), agent('infinite', Number.POSITIVE_INFINITY), agent('zero', 0), agent('illegal-source', NOW, 'user')])
  expect(useAppStore.getState().sessions).toHaveLength(6)
  expectTone('quiet')
  await act(async () => useAppStore.setState({ sessions: [agent('older', NOW - 6 * HOUR), agent('fresh', NOW - 10 * 60_000, 'acp'), agent('future', NOW + 1000)] }))
  expectTone('full')
})

it('aggregates all workspaces of this Project while isolating another Host, same name and independent descendant', async () => {
  const checkout: WorkspaceRecord = { id: 'checkout', name: 'Branch', hostId: 'local', path: '/checkout', repoPath: '/repo', kind: 'worktree', branch: 'feature/private' }
  const child: WorkspaceRecord = { id: 'child', name: 'Project', hostId: 'local', path: '/repo/child', kind: 'folder' }
  const remote: WorkspaceRecord = { ...project, id: 'remote-project', hostId: 'remote' }
  await mount([agent('root', NOW - 20 * HOUR), agent('checkout', NOW - 2 * HOUR, 'acp', checkout.path), agent('child', NOW, 'native-hook', child.path), agent('remote', NOW, 'native-hook', project.path, 'remote')], [project, checkout, child, remote])
  expect(useAppStore.getState().sessions).toHaveLength(4)
  expectTone('subdued'); expectTone('full', child.id); expectTone('full', remote.id)
  expect(api.workspaces.appearance).toHaveBeenCalledTimes(3)
  const parent = row().closest('[data-space-entry]')!
  const beforeStatus = parent.querySelector('.project-activity')?.getAttribute('aria-label')
  const disclosure = container.querySelector<HTMLButtonElement>('button[aria-label="Collapse Project"]')
  expect(disclosure).not.toBeNull()
  await act(async () => disclosure!.click())
  expect(useAppStore.getState().collapsedProjectGroups[`project:${workspaceProjectId(project)}`]).toBe(true)
  expect(container.querySelector('.project-rail-row[data-workspace-id="child"]')).toBeNull()
  expectTone('subdued')
  await act(async () => row(remote.id).click())
  expectTone('subdued'); expectTone('full', remote.id)
  expect(row(remote.id).getAttribute('aria-current')).toBe('page')
  expect(useAppStore.getState().sessions).toHaveLength(4)
  expect(beforeStatus).toBeTruthy()
})

it('the image clock crosses 1h and 12h naturally with one boundary timeout, no Store/API writes or interval', async () => {
  const timers = vi.spyOn(globalThis, 'setTimeout'), intervals = vi.spyOn(globalThis, 'setInterval')
  await mount([agent('owned', NOW - HOUR)])
  expectTone('full')
  expect(timers.mock.calls.filter(([, delay]) => delay === 1)).toHaveLength(1)
  const state = useAppStore.getState(), changed = vi.fn(), unsubscribe = useAppStore.subscribe(changed)
  try {
    await advance(1); expectTone('subdued')
    await advance(11 * HOUR - 1); expectTone('subdued')
    await advance(1); expectTone('quiet')
    expect(vi.getTimerCount()).toBe(0)
    expect(intervals).not.toHaveBeenCalled()
    expect(useAppStore.getState()).toBe(state); expect(changed).not.toHaveBeenCalled()
    expect(api.sessions.snapshot).not.toHaveBeenCalled(); expect(api.ui.requestStorageFlush).not.toHaveBeenCalled()
    expect(api.workspaces.appearance).toHaveBeenCalledTimes(1)
  } finally { unsubscribe() }
})

it('cancels while the document or Space is hidden, catches up across clock changes and releases on unmount', async () => {
  await mount([agent('owned', NOW)])
  expectTone('full'); expect(vi.getTimerCount()).toBe(1)
  await documentVisible('hidden'); expect(vi.getTimerCount()).toBe(0)
  vi.setSystemTime(NOW + 13 * HOUR)
  await documentVisible('visible'); expectTone('quiet'); expect(vi.getTimerCount()).toBe(0)
  vi.setSystemTime(NOW + 30 * 60_000)
  await documentVisible('visible'); expectTone('full'); expect(vi.getTimerCount()).toBe(1)
  await act(async () => root!.render(<WorkspaceSidebar visible={false} />))
  expect(vi.getTimerCount()).toBe(0)
  vi.setSystemTime(NOW + 2 * HOUR)
  await act(async () => root!.render(<WorkspaceSidebar visible />))
  expectTone('subdued'); expect(vi.getTimerCount()).toBe(1)
  const img = image()
  await act(async () => root!.unmount()); root = undefined
  expect(vi.getTimerCount()).toBe(0)
  expect(img.isConnected).toBe(false)
  await documentVisible('hidden'); await documentVisible('visible')
  expect(vi.getTimerCount()).toBe(0)
  expect(api.workspaces.appearance).toHaveBeenCalledTimes(1)
})

it('the actual App Settings path cancels the Folder clock through ProjectRail and rebases the same image on both returns', async () => {
  const session = agent('owned', NOW)
  const split = addWorkbenchRegion(createWorkbenchTab('retained-tab', {
    regionId: 'retained-agent', kind: 'agent', phase: 'attached', workspaceId: project.id, sessionId: session.id
  }), 'retained-agent', 'right', { regionId: 'retained-file', kind: 'file', workspaceId: project.id, path: 'README.md' })
  const tab = { ...split, layout: { ...split.layout, activeRegionId: 'retained-agent' } }
  useAppStore.setState({ initialize: vi.fn(async () => () => {}), toolsOpen: false, projectRailOpen: true,
    tabs: { [tab.id]: tab }, layouts: { [project.id]: createWorkspaceLayout('retained-group', [tab.id]) },
    agentComposerDrafts: { [session.id]: 'Original Agent draft' },
    agentFocus: { execution: { sessionId: session.id, history: [{ sessionId: session.id, focusedAt: 1 }] }, pmo: { sessionId: null } } })
  const timers = vi.spyOn(globalThis, 'setTimeout'), cleared = vi.spyOn(globalThis, 'clearTimeout')
  await mount([session], [project], <App />)
  const before = useAppStore.getState(), img = image(), paint = vi.spyOn(recency, 'folderIconRecency')
  expectTone('full')
  // This delay is unique to the actual Folder image; App resource owners may have their own unrelated timers.
  let boundaryDelay = HOUR + 1
  for (const [elapsed, returnSelector, tone] of [
    [2 * HOUR, '.window-status-bar [aria-label="Space: show terminal and file workbench"]', 'subdued'],
    [13 * HOUR, '.window-status-bar [aria-label="Settings"]', 'quiet']
  ] as const) {
    const scheduled = timers.mock.calls.map((call, index) => ({ delay: call[1], timer: timers.mock.results[index]!.value }))
      .filter(call => call.delay === boundaryDelay)
    expect(scheduled).toHaveLength(1)
    cleared.mockClear()
    const settings = container.querySelector<HTMLButtonElement>('.window-status-bar [aria-label="Settings"]')!
    expect(settings).not.toBeNull()
    await act(async () => settings.click())
    expect(container.querySelector('.settings-page')).not.toBeNull()
    expect(container.querySelector<HTMLElement>('.app-shell__workspace')?.inert).toBe(true)
    expect(image()).toBe(img)
    expect(cleared).toHaveBeenCalledWith(scheduled[0]!.timer)
    paint.mockClear(); timers.mockClear()
    await advance(elapsed - (Date.now() - NOW))
    expect(paint).not.toHaveBeenCalled()
    expect(timers.mock.calls.filter(([, delay]) => delay === HOUR + 1 || delay === 10 * HOUR + 1)).toHaveLength(0)
    const back = container.querySelector<HTMLButtonElement>(returnSelector)!
    expect(back).not.toBeNull()
    await act(async () => back.click())
    expect(container.querySelector('.settings-page')).toBeNull()
    expect(container.querySelector<HTMLElement>('.app-shell__workspace')?.inert).toBe(false)
    expect(image()).toBe(img); expectTone(tone)
    expect(paint.mock.calls.length).toBeGreaterThan(0)
    expect(useAppStore.getState().tabs).toStrictEqual(before.tabs)
    expect(useAppStore.getState().layouts).toStrictEqual(before.layouts)
    expect(useAppStore.getState().sessions).toEqual([session])
    expect(useAppStore.getState().agentComposerDrafts[session.id]).toBe('Original Agent draft')
    expect(useAppStore.getState().sessions[0]!.control.run).toEqual({ runId: 'run-owned' })
    boundaryDelay = 10 * HOUR + 1
  }
  expect(Object.keys(useAppStore.getState().tabs[tab.id]!.regions)).toEqual(['retained-agent', 'retained-file'])
  expect(api.workspaces.appearance).toHaveBeenCalledTimes(1)
  expect(api.sessions.snapshot).not.toHaveBeenCalled()
})

it('does not start the activity clock before appearance resolves, and stops when the actual image fails', async () => {
  let resolve!: (value: { kind: 'repository'; icon: string }) => void
  vi.mocked(api.workspaces.appearance).mockImplementation(() => new Promise(done => { resolve = done }))
  await mount([agent('owned', NOW)])
  expect(container.querySelector('img')).toBeNull(); expect(vi.getTimerCount()).toBe(0)
  await act(async () => resolve({ kind: 'repository', icon: ASSET }))
  expectTone('full'); expect(vi.getTimerCount()).toBe(1)
  await act(async () => image().dispatchEvent(new Event('error')))
  expect(container.querySelector('img')).toBeNull(); expect(vi.getTimerCount()).toBe(0)
  expect(container.querySelector('[data-monogram]')?.textContent).toBe('P')
  expect(api.workspaces.appearance).toHaveBeenCalledTimes(1)
})

it('keeps manual Folder, absent-image monogram, Topic and Mote identity free of activity paint or clocks', async () => {
  const key = folderSpaceIconTarget({ hostId: project.hostId, repoPath: project.path, name: project.name }).key
  useAppStore.setState({ spaceObjectIcons: { [key]: 'code' } })
  await mount([agent('owned', NOW)], [project], <><WorkspaceSidebar /><SpaceObjectIcon kind="topic" name="Topic" manualIcon={null} lastActivityAt={NOW} /><SpaceObjectIcon kind="mote" name="Mote" manualIcon={null} lastActivityAt={NOW} /></>)
  expect(container.querySelector('[data-space-icon-source="manual"]')).not.toBeNull()
  expect(container.querySelectorAll('img')).toHaveLength(0)
  expect(container.querySelectorAll('[data-folder-icon-recency]')).toHaveLength(0)
  expect(vi.getTimerCount()).toBe(0); expect(api.workspaces.appearance).not.toHaveBeenCalled()
  vi.mocked(api.workspaces.appearance).mockResolvedValue({ kind: 'directory', icon: null })
  await act(async () => useAppStore.setState({ spaceObjectIcons: {} }))
  expect(container.querySelector('[data-monogram]')).not.toBeNull()
  expect(container.querySelectorAll('img')).toHaveLength(0); expect(vi.getTimerCount()).toBe(0)
})

it('leaves the actual Focus lane and default ProjectIcon consumer in their original quiet presentation', async () => {
  const lane = { id: 'lane', workspaceId: project.id, projectId: project.id, name: project.name, path: project.path,
    labels: [project.name], topicId: null, recovery: null, projectWorkspaceId: project.id, summary: null, activeAgentIds: ['owned'], contextIds: ['owned'] }
  await mount([agent('owned', NOW)], [project], <><WorkspaceSidebar /><FocusProjectLanes lanes={[lane]} selectedWorkspaceId={project.id} onSelect={() => {}} renderLane={(_, heading) => heading} /><ProjectIcon workspaceId={project.id} name="Timeline project" /></>)
  expectTone('full')
  const images = [...container.querySelectorAll<HTMLImageElement>('.focus-project-lanes img, :scope > .project-rail-row__icon img')]
  expect(images).toHaveLength(2)
  for (const img of images) {
    expect(img.getAttribute('data-folder-icon-recency')).toBeNull()
    expect(getComputedStyle(img).filter).toBe('saturate(.2)'); expect(Number(getComputedStyle(img).opacity)).toBe(.85)
    expect(img.parentElement?.title).toBe('Git project')
  }
  expect(vi.getTimerCount()).toBe(1)
})

it('memoized primitive observations ignore unrelated Sessions/timelines and updatedAt/bytes, while a new owned Core observation lights the same image', async () => {
  const owned = agent('owned', NOW - 20 * HOUR)
  await mount([owned, agent('unrelated', NOW, 'native-hook', '/unregistered')])
  expectTone('quiet')
  const img = image(), paint = vi.spyOn(recency, 'folderIconRecency')
  vi.mocked(api.workspaces.appearance).mockClear()
  for (let index = 1; index <= 25; index += 1) await act(async () => useAppStore.setState({
    sessions: [{ ...owned, updatedAt: NOW + index, latestOutputBytes: index }, agent('unrelated', NOW, 'native-hook', '/unregistered')],
    timelines: { unrelated: { agentSessionId: 'unrelated', revision: index, items: [] } }
  }))
  expect(paint).not.toHaveBeenCalled()
  expect(image()).toBe(img); expectTone('quiet')
  expect(api.workspaces.appearance).not.toHaveBeenCalled()
  const event: RuntimeEvent = { type: 'core', hostId: 'local', event: { type: 'agent-session', session: {
    kind: 'agent', agentSessionId: owned.id, providerId: owned.providerId, executorId: owned.executorId, hostId: owned.hostId, workspacePath: owned.workspacePath,
    run: owned.control.run, retiredRuns: [], createdAt: 1, updatedAt: NOW + 100,
    semanticStatus: { state: 'done', source: 'native-hook', observedAt: NOW, stateEnteredAt: 1 }
  } } }
  await act(async () => useAppStore.getState().applyEvent(event))
  expect(image()).toBe(img); expectTone('full')
  expect(paint.mock.calls.length).toBeGreaterThan(0)
  expect(api.workspaces.appearance).not.toHaveBeenCalled()
  const semantic = useAppStore.getState().sessions.find(session => session.id === owned.id)
  expect(semantic?.kind === 'agent' ? semantic.semanticStatus?.stateEnteredAt : undefined).toBe(1)
})
