import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { folderSpaceIconTarget, topicSpaceIconTarget, spaceObjectIdentityKey } from '../src/renderer/src/lib/space-object-appearance'
import { projectWorkspaces } from '../src/renderer/src/lib/workspace-projects'

const storageName = 'agentmux-workbench-v1'
const workspace = { id: 'folder', hostId: 'local', path: '/work/project', repoPath: '/work/project', name: 'Project', kind: 'folder' as const }
const scratch = { id: '__scratch__', hostId: 'local', path: '/topics', name: 'Topics', kind: 'folder' as const }
const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Local' }], executors: {},
  workspaces: [workspace, scratch], appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
const session: SessionSnapshot = { id: 'active', kind: 'agent', providerId: 'codex', executorId: 'probe', hostId: 'local',
  workspacePath: workspace.path, label: 'Live Agent', createdAt: 1, updatedAt: 1, agentSessionUpdatedAt: 1, processState: 'running',
  status: { state: 'working', source: 'native-hook', observedAt: 1 }, latestOutputBytes: 0,
  capabilities: { terminal: true, timeline: 'complete-events', permission: 'respond', providerResume: true, replyCorrelation: 'none' },
  control: { kind: 'agent', hostId: 'local', agentSessionId: 'active', run: { runId: 'run' } } }
const topic = { id: 'view:notes', directoryPath: 'topic--view--notes', title: 'Notes', collaborators: [], summary: '', topicPath: 'topic--view--notes/topic.md' }
const folder = folderSpaceIconTarget({ hostId: workspace.hostId, repoPath: workspace.path, name: workspace.name })
const topicTarget = topicSpaceIconTarget(scratch, topic)
const moteTarget = topicSpaceIconTarget(scratch, { ...topic, id: 'view:assistant', directoryPath: 'topic--view--assistant', title: 'Researcher',
  soul: { path: 'topic--view--assistant/SOUL.md', content: 'Research', version: 'one' } })
let store: typeof import('../src/renderer/src/store').useAppStore
let api: typeof import('../src/renderer/src/lib/api').api
let backing: Map<string, string>
let storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
let dispose: (() => void) | undefined

beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers()
  backing = new Map()
  storage = { getItem: vi.fn(name => backing.get(name) ?? null), setItem: vi.fn((name, value) => backing.set(name, value)), removeItem: vi.fn(name => backing.delete(name)) }
  vi.stubGlobal('window', { localStorage: storage, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  store = (await import('../src/renderer/src/store')).useAppStore
  api = (await import('../src/renderer/src/lib/api')).api
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  vi.spyOn(api.providers, 'list').mockResolvedValue([])
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [session], timelines: {}, recoveryCandidates: [] })
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue()
})
afterEach(() => { dispose?.(); dispose = undefined; vi.clearAllTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })
async function initialize() { dispose = await store.getState().initialize(); expect(store.getState().loading).toBe(false) }
function saved() {
  const raw = backing.get(storageName)
  expect(raw).toBeTypeOf('string')
  return JSON.parse(raw!) as { state: { spaceObjectIcons: Record<string, string>; pinnedItems: Record<string, string[]>; restoredWorkbench: { tabs: Record<string, unknown>; layouts: Record<string, unknown> } } }
}

it('uses one durable directory identity across rename, classification and Project worktrees with host/root isolation', () => {
  expect(topicSpaceIconTarget(scratch, { ...topic, title: 'Renamed' }).key).toBe(topicTarget.key)
  expect(topicSpaceIconTarget(scratch, { ...topic, directoryPath: `${scratch.path}/${topic.directoryPath}` }).key).toBe(topicTarget.key)
  expect(topicSpaceIconTarget(scratch, { ...topic, soul: { path: 'SOUL.md', content: 'Mote', version: '1' } }).key).toBe(topicTarget.key)
  expect(topicSpaceIconTarget({ ...scratch, path: '/other-topics' }, topic).key).not.toBe(topicTarget.key)
  expect(topicSpaceIconTarget({ ...scratch, hostId: 'remote' }, topic).key).not.toBe(topicTarget.key)
  expect(spaceObjectIdentityKey('remote', workspace.path)).not.toBe(folder.key)
  const projects = projectWorkspaces([workspace, { ...workspace, id: 'tree', kind: 'worktree', path: '/trees/feature', branch: 'feature' }])
  expect(projects).toHaveLength(1)
  expect(folderSpaceIconTarget(projects[0]!).key).toBe(folder.key)
})

it('saves three real store selections and initializes from that same persisted projection without removing pins or Tabs', async () => {
  await initialize()
  const tab = createWorkbenchTab('original-tab', { regionId: 'original-region', kind: 'agent', phase: 'attached', workspaceId: workspace.id, sessionId: session.id })
  store.setState({ tabs: { [tab.id]: tab }, layouts: { [workspace.id]: createWorkspaceLayout('original-group', [tab.id]) } })
  store.getState().togglePinnedItem(folder.key, 'feature')
  await store.getState().setSpaceObjectIcon(folder.key, 'code')
  await store.getState().setSpaceObjectIcon(topicTarget.key, 'book')
  await store.getState().setSpaceObjectIcon(moteTarget.key, 'brain')
  const expected = { [folder.key]: 'code', [topicTarget.key]: 'book', [moteTarget.key]: 'brain' }
  expect(saved().state.spaceObjectIcons).toEqual(expected)
  expect(saved().state.pinnedItems).toEqual({ [folder.key]: ['feature'] })
  expect(Object.keys(saved().state.restoredWorkbench.tabs)).toEqual(['original-tab'])
  dispose?.(); dispose = undefined
  store.setState({ spaceObjectIcons: {} })
  await store.persist.rehydrate()
  await initialize()
  expect(store.getState().spaceObjectIcons).toEqual(expected)
  expect(store.getState().pinnedItems).toEqual({ [folder.key]: ['feature'] })
  expect(Object.keys(store.getState().tabs)).toEqual(['original-tab'])
  await store.getState().setSpaceObjectIcon(topicTarget.key, null)
  expect(saved().state.spaceObjectIcons).toEqual({ [folder.key]: 'code', [moteTarget.key]: 'brain' })
})

it('restores each metadata record independently and retains the original work surface', async () => {
  const tab = createWorkbenchTab('retained', { regionId: 'retained-region', kind: 'agent', phase: 'attached', workspaceId: workspace.id, sessionId: session.id })
  backing.set(storageName, JSON.stringify({ version: 1, state: {
    spaceObjectIcons: { [folder.key]: 'code', [topicTarget.key]: 'unrecognized', [moteTarget.key]: 'brain', broken: 'book' },
    pinnedItems: { [folder.key]: ['main'] }, restoredWorkbench: { tabs: { [tab.id]: tab }, layouts: { [workspace.id]: createWorkspaceLayout('retained-group', [tab.id]) } }
  } }))
  await initialize()
  expect(store.getState().spaceObjectIcons).toEqual({ [folder.key]: 'code', [moteTarget.key]: 'brain' })
  expect(store.getState().pinnedItems).toEqual({ [folder.key]: ['main'] })
  expect(Object.keys(store.getState().tabs)).toEqual(['retained'])
})

it('interleaves awaited selections while concurrent pins/layout survive in the latest owner projection', async () => {
  await initialize()
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  vi.mocked(api.ui.requestStorageFlush).mockImplementation(() => pending)
  const first = store.getState().setSpaceObjectIcon(folder.key, 'code')
  store.getState().togglePinnedItem(folder.key, 'main')
  const layout = createWorkspaceLayout('another-group')
  store.setState({ layouts: { ...store.getState().layouts, [workspace.id]: layout } })
  const second = store.getState().setSpaceObjectIcon(topicTarget.key, 'book')
  const third = store.getState().setSpaceObjectIcon(moteTarget.key, 'brain')
  expect(saved().state.spaceObjectIcons).toEqual({ [folder.key]: 'code', [topicTarget.key]: 'book', [moteTarget.key]: 'brain' })
  expect(saved().state.pinnedItems).toEqual({ [folder.key]: ['main'] })
  expect(saved().state.restoredWorkbench.layouts[workspace.id]).toEqual(layout)
  release(); await Promise.all([first, second, third])
  await store.getState().setSpaceObjectIcon(folder.key, 'folder')
  expect(saved().state.spaceObjectIcons).toEqual({ [folder.key]: 'folder', [topicTarget.key]: 'book', [moteTarget.key]: 'brain' })
})

it('keeps a failed synchronous write pending and saves the same selection on explicit retry', async () => {
  await initialize(); vi.advanceTimersByTime(400)
  vi.mocked(storage.setItem).mockImplementationOnce(() => { throw new Error('quota unavailable') })
  await expect(store.getState().setSpaceObjectIcon(topicTarget.key, 'book')).rejects.toThrow('quota unavailable')
  expect(store.getState().spaceObjectIcons).toEqual({ [topicTarget.key]: 'book' })
  expect(store.getState().workbenchSaveWarning).toContain('quota unavailable')
  await store.getState().setSpaceObjectIcon(topicTarget.key, 'book')
  expect(saved().state.spaceObjectIcons).toEqual({ [topicTarget.key]: 'book' })
  expect(store.getState().workbenchSaveWarning).toBeNull()
})

it('retains authored metadata after a platform request failure and clears the service notice after retry', async () => {
  await initialize(); vi.advanceTimersByTime(400)
  vi.mocked(api.ui.requestStorageFlush).mockRejectedValue(new Error('storage owner unconfirmed'))
  await expect(store.getState().setSpaceObjectIcon(moteTarget.key, 'brain')).rejects.toThrow('storage owner unconfirmed')
  expect(store.getState().spaceObjectIcons).toEqual({ [moteTarget.key]: 'brain' })
  expect(saved().state.spaceObjectIcons).toEqual({ [moteTarget.key]: 'brain' })
  expect(store.getState().workbenchSaveWarning).toContain('storage owner unconfirmed')
  vi.mocked(api.ui.requestStorageFlush).mockResolvedValue()
  await store.getState().setSpaceObjectIcon(moteTarget.key, 'brain')
  expect(store.getState().workbenchSaveWarning).toBeNull()
  expect(saved().state.spaceObjectIcons).toEqual({ [moteTarget.key]: 'brain' })
})

it('does not project or serialize authored icon metadata from unrelated Session/timeline changes', async () => {
  await initialize()
  await store.getState().setSpaceObjectIcon(topicTarget.key, 'book')
  const durable = backing.get(storageName)
  const metadata = store.getState().spaceObjectIcons
  const stringify = vi.spyOn(JSON, 'stringify')
  vi.mocked(storage.getItem).mockClear(); vi.mocked(storage.setItem).mockClear()
  for (let index = 0; index < 100; index += 1) {
    store.getState().applyEvent({ type: 'core', hostId: 'local', event: { type: 'agent-status', agentSessionId: session.id,
      state: 'working', evidence: { source: 'native-hook', observedAt: index + 2, run: { runId: 'run' } } } })
    store.setState({ timelines: { elsewhere: { agentSessionId: 'elsewhere', revision: index + 1, items: [] } } })
  }
  expect(store.getState().sessions[0]?.status.observedAt).toBe(101)
  expect(store.getState().spaceObjectIcons).toBe(metadata)
  expect(stringify).not.toHaveBeenCalled()
  expect(storage.getItem).not.toHaveBeenCalled()
  expect(storage.setItem).not.toHaveBeenCalled()
  expect(backing.get(storageName)).toBe(durable)
})
