// @vitest-environment happy-dom
import { act, createElement, Profiler } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AppConfig, ScratchTopicSnapshot, SessionSnapshot } from '../src/shared/contracts'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { GlobalBoardSurface } from '../src/renderer/src/components/GlobalBoardSurface'
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { api } from '../src/renderer/src/lib/api'
import { EMPTY_AGENT_FOCUS } from '../src/renderer/src/lib/agent-focus'
import { goalExplorationPending } from '../src/renderer/src/lib/goals-entry-actions'
import { createWorkbenchTab, type WorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { executorDetectionKey, useAppStore } from '../src/renderer/src/store'
import { agentCreationFixture } from './helpers/agent-creation-fixture'

vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div data-terminal /> }))
const baseline = useAppStore.getState()
const scratch = { id: SCRATCH_WORKSPACE_ID, name: 'Topics', path: '/topics', hostId: 'local', kind: 'folder' as const }
const project = { id: 'project', name: 'Project Alpha', path: '/alpha', hostId: 'local', kind: 'folder' as const }
const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  workspaces: [scratch], executors: { configured: { providerId: 'codex', label: 'Configured Agent', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true } },
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
const oldTab = createWorkbenchTab('original-tab', { kind: 'agent', phase: 'attached', regionId: 'original-region', workspaceId: 'project', sessionId: 'original' })
function session(id: string, workspacePath = '/alpha'): Extract<SessionSnapshot, { kind: 'agent' }> {
  return { id, kind: 'agent', providerId: 'codex', executorId: 'configured', hostId: 'local', workspacePath, label: 'Configured Agent', createdAt: 1, updatedAt: 1, agentSessionUpdatedAt: 1,
    processState: 'running', status: { state: 'running', source: 'run-process', observedAt: 1 }, latestOutputBytes: 0,
    capabilities: { terminal: true, timeline: 'streaming', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } } }
}
function topic(id: string): ScratchTopicSnapshot { return { id, title: 'Untitled Mote', summary: '', directoryPath: `topic--${id.replace(':', '--')}`, topicPath: `topic--${id.replace(':', '--')}/topic.md`, collaborators: [], soul: { path: 'SOUL.md', content: '# SOUL', version: 'v1' } } }
const pendingCleanup: Array<() => void> = []
function deferred<T>() { let resolve!: (value: T) => void, reject!: (cause: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); void promise.catch(() => {}); pendingCleanup.push(() => reject(new Error('Test cleanup'))); return { promise, resolve, reject } }
function createdTab(): WorkbenchTab {
  const created = Object.values(useAppStore.getState().tabs).filter(tab => tab.id !== oldTab.id)
  expect(created).toHaveLength(1)
  expect(created[0]!.topicId).toMatch(/^launcher:/)
  return created[0]!
}
function MountedSurface() {
  const surface = useAppStore(state => state.mainSurface)
  const tabs = useAppStore(state => state.tabs)
  const layout = useAppStore(state => state.layouts[SCRATCH_WORKSPACE_ID])
  if (surface === 'board') return <GlobalBoardSurface />
  const group = layout?.groups.find(group => group.id === layout.activeGroupId)
  const tab = group?.activeTabId ? tabs[group.activeTabId] : undefined
  const region = tab?.regions[tab.layout.activeRegionId]
  return tab && group && region?.kind === 'launcher' ? <NewTabSurface tabGroupId={group.id} tabId={tab.id} regionId={region.regionId} /> : <div data-agent-workface />
}
let root: Root, container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  window.localStorage.clear()
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  useAppStore.setState({ ...baseline, config: structuredClone(config), loading: false, mainSurface: 'board', activeWorkspaceId: null,
    sessions: [session('original')], tabs: { [oldTab.id]: oldTab }, layouts: { project: createWorkspaceLayout('original-group', [oldTab.id]), [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('scratch-group') },
    agentComposerDrafts: { original: 'original draft' }, demands: {}, selectedDemandId: null, agentFocus: structuredClone(EMPTY_AGENT_FOCUS),
    scratchTopicSnapshots: {}, workspaceFileRevisions: {}, pendingAgentLaunches: {}, executorDetections: {}, error: null, lastError: null, errorNoticeContext: null,
    prewarmTerminal: vi.fn(), detectExecutors: vi.fn(async () => {}) })
  vi.spyOn(api.scratch, 'ensureMote').mockImplementation(async (_workspace, id) => topic(id))
  vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async input => {
    const value = session(input.agentSessionId!, `/topics/topic--${input.scratchTopicId!.replace(':', '--')}`)
    return { created: agentCreationFixture(value), session: value, projectionFailures: [], timeline: { agentSessionId: value.id, revision: 0, items: [] } }
  })
  vi.spyOn(api.sessions, 'stop').mockResolvedValue(undefined)
})
afterEach(async () => {
  await act(async () => { pendingCleanup.splice(0).forEach(cleanup => cleanup()); await Promise.resolve() })
  const pending = goalExplorationPending()
  await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); useAppStore.setState(baseline, true); window.localStorage.clear()
  expect(pending, 'every test settles its finite request').toBe(false)
})
async function mount() { await act(async () => root.render(<MountedSurface />)) }
function action(id: string) { const node = container.querySelector<HTMLButtonElement>(`[data-goals-entry-action="${id}"]`); expect(node).not.toBeNull(); return node! }
async function click(id: string) { await act(async () => action(id).click()) }
function readyExecutor() { useAppStore.setState({ executorDetections: { [executorDetectionKey('local', 'configured')]: { state: 'ready', input: { executorId: 'configured', providerId: 'codex', command: 'codex', host: { id: 'local', kind: 'local', label: 'This Mac' } } } } }) }

describe('Goals one-click requests through the mounted product and original owner', () => {
  it.each([
    ['understand', '我还不知道能做什么，可以了解我并给我建议吗？'],
    ['ideas', '我有一些点子，我们开始尝试一个项目']
  ])('sends %s exactly with zero Goals and Projects, preserving original work and execution focus', async (id, text) => {
    const focus = { execution: { sessionId: 'original', history: [{ sessionId: 'original', focusedAt: 1 }] }, pmo: { sessionId: null } }
    useAppStore.setState({ agentFocus: focus })
    const originalLayout = useAppStore.getState().layouts.project
    const createGoal = vi.spyOn(api.demands, 'create')
    await mount(); expect(action(id).querySelector('.goals-entry__request')?.textContent).toBe(text); expect(container.querySelector('[data-goals-entry-action="next"]')).toBeNull()
    await click(id)
    const tab = createdTab(), state = useAppStore.getState(), region = tab.regions[tab.layout.activeRegionId]!
    expect(api.scratch.ensureMote).toHaveBeenCalledExactlyOnceWith(SCRATCH_WORKSPACE_ID, tab.topicId)
    expect(api.sessions.launchAgent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ executorId: 'configured', scratchTopicId: tab.topicId, prompt: text, workspacePath: '/topics', hostId: 'local' }))
    expect(region.kind).toBe('agent'); expect(state.mainSurface).toBe('workbench'); expect(container.querySelector('.goals-entry')).toBeNull()
    expect(state.agentComposerDrafts).toEqual({ original: 'original draft' }); expect(state.pendingAgentLaunches).toEqual({})
    expect(state.tabs[oldTab.id]).toBe(oldTab); expect(state.layouts.project).toBe(originalLayout); expect(state.agentFocus).toEqual(focus)
    expect(state.sessions.find(value => value.id === 'original')).toEqual(session('original')); expect(api.sessions.stop).not.toHaveBeenCalled()
    expect(state.demands).toEqual({}); expect(createGoal).not.toHaveBeenCalled(); expect(state.config?.workspaces).toEqual([scratch])
  })

  it('synchronously owns the actual draft, deduplicates across unmount/return, and ignores navigation drift', async () => {
    const preparation = deferred<ScratchTopicSnapshot>()
    vi.mocked(api.scratch.ensureMote).mockReturnValueOnce(preparation.promise)
    await mount(); const button = action('understand')
    await act(async () => { button.click(); button.click() })
    const tab = createdTab(), surface = tab.regions[tab.layout.activeRegionId]
    expect(tab.topicPreparation).toBe('mote'); expect(surface?.kind).toBe('launcher')
    expect(useAppStore.getState().agentComposerDrafts[tab.layout.activeRegionId]).toBe('我还不知道能做什么，可以了解我并给我建议吗？')
    expect(container.querySelector('.launch-surface')?.textContent).toContain('Your request has not been sent')
    expect(api.sessions.launchAgent).not.toHaveBeenCalled()
    await act(async () => useAppStore.getState().setMainSurface('board'))
    expect(action('ideas').disabled).toBe(true)
    expect(container.querySelector('.goals-entry__actions')?.getAttribute('aria-busy')).toBe('true')
    expect(container.querySelector('.goals-entry__preparing[role="status"]')?.textContent).toBe('正在准备对话…')
    expect(action('understand').querySelector('.goals-entry__request')?.textContent).toBe('我还不知道能做什么，可以了解我并给我建议吗？')
    await click('ideas'); expect(api.scratch.ensureMote).toHaveBeenCalledTimes(1)
    await act(async () => { useAppStore.getState().renameTab(tab.id, 'My conversation'); useAppStore.setState({ activeWorkspaceId: 'project' }); preparation.resolve(topic(tab.topicId!)) })
    expect(api.sessions.launchAgent).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().mainSurface).toBe('board'); expect(useAppStore.getState().activeWorkspaceId).toBe('project')
    expect(useAppStore.getState().tabs[tab.id]?.name).toBe('My conversation'); expect(useAppStore.getState().tabs[tab.id]?.topicPreparation).toBeUndefined()
    expect(useAppStore.getState().tabs[tab.id]?.regions[tab.layout.activeRegionId]?.kind).toBe('agent')
    expect(container.querySelector('.goals-entry__preparing')).toBeNull()
    expect(container.querySelector('.goals-entry__actions')?.getAttribute('aria-busy')).toBe('false')
    await click('ideas'); expect(api.scratch.ensureMote).toHaveBeenCalledTimes(2); expect(api.sessions.launchAgent).toHaveBeenCalledTimes(2)
  })

  it('keeps an unconfirmed preparation and retries the same Mote from the actual launcher', async () => {
    vi.mocked(api.scratch.ensureMote).mockRejectedValueOnce(new Error('Metadata receipt missing'))
    readyExecutor(); await mount(); await click('ideas')
    const tab = createdTab(), regionId = tab.layout.activeRegionId
    expect(tab.topicPreparation).toBe('mote'); expect(api.sessions.launchAgent).not.toHaveBeenCalled()
    expect(container.querySelector('.launch-surface')?.textContent).toContain('Mote Topic preparation is unconfirmed')
    expect(container.querySelector('[role="textbox"]')?.textContent).toBe('我有一些点子，我们开始尝试一个项目')
    const start = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Launch agent')!
    expect(start).toBeDefined(); expect(start.disabled).toBe(false)
    await act(async () => start.click())
    expect(vi.mocked(api.scratch.ensureMote).mock.calls).toEqual([[SCRATCH_WORKSPACE_ID, tab.topicId], [SCRATCH_WORKSPACE_ID, tab.topicId]])
    expect(api.sessions.launchAgent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ scratchTopicId: tab.topicId, prompt: '我有一些点子，我们开始尝试一个项目' }))
    expect(useAppStore.getState().tabs[tab.id]?.topicPreparation).toBeUndefined(); expect(useAppStore.getState().tabs[tab.id]?.regions[regionId]?.kind).toBe('agent')
  })

  it('keeps launch failure under its exact original notice owner without a duplicate generic error', async () => {
    vi.mocked(api.sessions.launchAgent).mockRejectedValueOnce(new Error('Launch unavailable'))
    const report = vi.spyOn(useAppStore.getState(), 'reportError')
    await mount(); await click('understand')
    const tab = createdTab(), state = useAppStore.getState()
    expect(tab.regions[tab.layout.activeRegionId]?.kind).toBe('launcher')
    expect(state.agentComposerDrafts[tab.layout.activeRegionId]).toBe('我还不知道能做什么，可以了解我并给我建议吗？')
    expect(state.errorNoticeContext?.lifecycle).toEqual({ step: 'launch', tabId: tab.id, regionId: tab.layout.activeRegionId })
    expect(report).toHaveBeenCalledTimes(1); expect(api.sessions.stop).not.toHaveBeenCalled(); expect(state.pendingAgentLaunches).toEqual({})
  })

  it('does not auto-launch again after manual Start failed and restored a new launcher Surface', async () => {
    const preparation = deferred<ScratchTopicSnapshot>()
    vi.mocked(api.scratch.ensureMote).mockReturnValueOnce(preparation.promise)
    vi.mocked(api.sessions.launchAgent).mockRejectedValueOnce(new Error('Manual launch failed'))
    readyExecutor(); await mount(); await click('ideas')
    const tab = createdTab(), originalSurface = tab.regions[tab.layout.activeRegionId]
    const start = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Launch agent')!
    expect(start).toBeDefined(); await act(async () => start.click())
    const restored = useAppStore.getState().tabs[tab.id]!.regions[tab.layout.activeRegionId]
    expect(restored?.kind).toBe('launcher'); expect(restored).not.toBe(originalSurface); expect(api.sessions.launchAgent).toHaveBeenCalledTimes(1)
    await act(async () => preparation.resolve(topic(tab.topicId!)))
    expect(api.sessions.launchAgent).toHaveBeenCalledTimes(1); expect(useAppStore.getState().agentComposerDrafts[tab.layout.activeRegionId]).toBe('我有一些点子，我们开始尝试一个项目')
  })

  it('does not clear a newer manual preparation owner or relaunch after a late original receipt', async () => {
    const original = deferred<ScratchTopicSnapshot>(), manual = deferred<ScratchTopicSnapshot>()
    vi.mocked(api.scratch.ensureMote).mockReturnValueOnce(original.promise).mockReturnValueOnce(manual.promise)
    readyExecutor(); await mount(); await click('ideas'); const tab = createdTab()
    const start = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Launch agent')!
    expect(start).toBeDefined(); await act(async () => start.click())
    expect(useAppStore.getState().tabs[tab.id]?.regions[tab.layout.activeRegionId]?.kind).toBe('agent')
    await act(async () => original.resolve(topic(tab.topicId!)))
    expect(useAppStore.getState().tabs[tab.id]?.topicPreparation).toBe('mote'); expect(api.sessions.launchAgent).not.toHaveBeenCalled()
    await act(async () => manual.resolve(topic(tab.topicId!)))
    expect(api.sessions.launchAgent).toHaveBeenCalledTimes(1); expect(useAppStore.getState().tabs[tab.id]?.topicPreparation).toBeUndefined()
  })

  it('does not create a replacement when the explicit owner is closed during preparation', async () => {
    const preparation = deferred<ScratchTopicSnapshot>(); vi.mocked(api.scratch.ensureMote).mockReturnValueOnce(preparation.promise)
    await mount(); await click('ideas'); const tab = createdTab()
    await act(async () => { useAppStore.setState({ tabs: { [oldTab.id]: oldTab }, layouts: { ...useAppStore.getState().layouts, [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('scratch-group') } }); preparation.resolve(topic(tab.topicId!)) })
    expect(Object.keys(useAppStore.getState().tabs)).toEqual([oldTab.id]); expect(api.sessions.launchAgent).not.toHaveBeenCalled(); expect(api.sessions.stop).not.toHaveBeenCalled()
  })

  it('keeps a real draft and honest recovery when no Agent is configured', async () => {
    useAppStore.setState({ config: { ...config, executors: {} } }); await mount(); await click('understand')
    const tab = createdTab()
    expect(api.sessions.launchAgent).not.toHaveBeenCalled(); expect(tab.regions[tab.layout.activeRegionId]?.kind).toBe('launcher')
    expect(useAppStore.getState().agentComposerDrafts[tab.layout.activeRegionId]).toBe('我还不知道能做什么，可以了解我并给我建议吗？')
    expect(container.textContent).toContain('No Agent Executor is configured'); expect(container.textContent).toContain('Your request has not been sent')
  })

  it.each(['recent', 'current'] as const)('freezes one visible %s Project identity into the actual request', async source => {
    useAppStore.setState({ config: { ...config, workspaces: [scratch, project] }, activeWorkspaceId: source === 'current' ? project.id : null,
      agentFocus: source === 'recent' ? { execution: { sessionId: 'original', history: [{ sessionId: 'original', focusedAt: 10, identity: { name: 'Original Agent', kind: 'agent', providerId: 'codex', hostId: 'local', workspacePath: '/alpha', project: { id: project.id, name: project.name } } }] }, pmo: { sessionId: null } } : structuredClone(EMPTY_AGENT_FOCUS) })
    const preparation = deferred<ScratchTopicSnapshot>(); vi.mocked(api.scratch.ensureMote).mockReturnValueOnce(preparation.promise)
    await mount(); expect(action('next').textContent).toContain(project.name)
    const text = source === 'recent' ? '根据最近的项目情况，建议我下一步应该做什么' : '根据当前项目的情况，建议我下一步应该做什么'
    expect(action('next').textContent).toContain(text); expect(action('next').querySelector('small')?.title).toBe('project · local · /alpha')
    expect(action('next').querySelector('.goals-entry__request')?.textContent).toBe(text)
    expect(action('next').querySelector('.goals-entry__request strong')?.textContent).toBe('建议我下一步应该做什么')
    expect(action('next').querySelector('small')?.textContent).toBe(`${source === 'recent' ? '最近项目' : '当前项目'} · Project Alpha`)
    await click('next'); const tab = createdTab()
    await act(async () => { useAppStore.setState({ config: { ...config, workspaces: [scratch, { ...project, name: 'Other name', path: '/other' }] }, activeWorkspaceId: SCRATCH_WORKSPACE_ID }); preparation.resolve(topic(tab.topicId!)) })
    expect(api.sessions.launchAgent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ prompt: `${text}\n\n项目：Project Alpha\nProject ID: project\nHost: local\nPath: /alpha`, scratchTopicId: tab.topicId }))
  })

  it.each(['deleted', 'ambiguous', 'host-mismatch', 'path-mismatch', 'pmo-only'] as const)('does not invent a recent Project from %s facts', async mode => {
    const identity = { name: 'Agent', kind: 'agent' as const, providerId: 'codex', hostId: mode === 'host-mismatch' ? 'other-host' : 'local', workspacePath: mode === 'path-mismatch' ? '/other' : '/alpha', project: { id: project.id, name: project.name } }
    useAppStore.setState({ config: { ...config, workspaces: mode === 'deleted' ? [scratch] : mode === 'ambiguous' ? [scratch, project, { ...project, path: '/duplicate' }] : [scratch, project] },
      agentFocus: { execution: { sessionId: null, history: mode === 'pmo-only' ? [] : [{ sessionId: 'original', focusedAt: 1, identity }] }, pmo: { sessionId: 'original' } } })
    await mount(); expect(container.querySelectorAll('[data-goals-entry-action]')).toHaveLength(2); expect(container.querySelector('[data-goals-entry-action="next"]')).toBeNull()
  })

  it('does not rerender or read output when an unrelated Session changes', async () => {
    const commits = vi.fn(); await act(async () => root.render(createElement(Profiler, { id: 'entry', onRender: commits }, createElement(GlobalBoardSurface))))
    expect(container.querySelectorAll('[data-goals-entry-action]')).toHaveLength(2); commits.mockClear()
    await act(async () => useAppStore.setState({ sessions: [session('original'), { ...session('unrelated'), latestOutputBytes: 999 }], timelines: { unrelated: { agentSessionId: 'unrelated', revision: 1, items: [] } } }))
    expect(commits).not.toHaveBeenCalled()
  })

  it('uses the existing visible MRU boundary rather than reviving older Project observations', async () => {
    const history = Array.from({ length: 12 }, (_, index) => ({ sessionId: `unidentified-${index}`, focusedAt: 20 - index }))
    useAppStore.setState({ config: { ...config, workspaces: [scratch, project] }, agentFocus: { execution: { sessionId: null, history: [...history,
      { sessionId: 'original', focusedAt: 1, identity: { name: 'Original', kind: 'agent', providerId: 'codex', hostId: 'local', workspacePath: '/alpha', project: { id: project.id, name: project.name } } }] }, pmo: { sessionId: null } } })
    await mount(); expect(container.querySelectorAll('[data-goals-entry-action]')).toHaveLength(2); expect(container.querySelector('[data-goals-entry-action="next"]')).toBeNull()
  })

  it('resolves a current worktree to its same registered Project without claiming recency', async () => {
    useAppStore.setState({ config: { ...config, workspaces: [scratch, project, { id: 'branch', kind: 'worktree', hostId: 'local', name: 'feature', path: '/branch', repoPath: '/alpha' }] }, activeWorkspaceId: 'branch' })
    await mount(); expect(action('next').textContent).toContain('根据当前项目的情况'); expect(action('next').textContent).toContain('Project Alpha')
    await click('next'); expect(api.sessions.launchAgent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ prompt: '根据当前项目的情况，建议我下一步应该做什么\n\n项目：Project Alpha\nProject ID: project\nHost: local\nPath: /alpha' }))
  })
})
