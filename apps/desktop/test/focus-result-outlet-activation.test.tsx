// @vitest-environment happy-dom
import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activateTab as activateLayoutTab, createWorkspaceLayout, moveTabToNewGroup } from '@agentmux/layout'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics.js'
import type { BrowserSnapshot, SessionSnapshot } from '../src/shared/contracts.js'
import type { GitFileDiff, GitStatusResult } from '../src/shared/git-contracts.js'

// These leaves need a terminal/native host or have separate input ownership. The real SessionPane,
// Result controls, Git-status hook, Store actions and placement reducers remain mounted/consumed.
// Actual Monaco paint and native Browser visibility are qualified in the private Chromium proof.
vi.mock('../src/renderer/src/components/TerminalView.js', () => ({ TerminalView: () => null }))
vi.mock('../src/renderer/src/components/ActivityView.js', () => ({ ActivityView: () => null }))
vi.mock('../src/renderer/src/components/AgentSessionComposer.js', () => ({ AgentSessionComposer: () => null }))
vi.mock('../src/renderer/src/components/AgentInteractionCard.js', () => ({ AgentInteractionCard: () => null }))
// Region chrome is real; HappyDOM does not qualify Monaco paint/native geometry.
vi.mock('../src/renderer/src/components/EditorPane.js', () => ({ EditorPane: () => null }))

import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench.js'
import { SessionPane } from '../src/renderer/src/components/SessionPane.js'
import { api } from '../src/renderer/src/lib/api.js'
import { addWorkbenchRegion, createWorkbenchTab, documentKey, fileTabId, initialWorkbenchRegionId } from '../src/renderer/src/lib/workbench-tabs.js'
import { useAppStore } from '../src/renderer/src/store.js'

const session = {
  id: 'result-agent', kind: 'agent', providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: '/repo', label: 'Result Agent',
  createdAt: 1, updatedAt: 2, processState: 'exited', latestOutputBytes: 0,
  status: { state: 'done', source: 'run-process', observedAt: 2 }, capabilities: {},
  control: { kind: 'agent', hostId: 'local', agentSessionId: 'result-agent', run: { runId: 'result-run', generation: 1 } }
} as unknown as SessionSnapshot
const origin = { workspaceId: 'repo', tabGroupId: 'group', tabId: 'agent-tab', regionId: 'agent-region', sessionId: session.id }
const agentTab = createWorkbenchTab(origin.tabId, { regionId: origin.regionId, kind: 'agent', phase: 'attached', workspaceId: 'repo', sessionId: session.id })
const context = { execution: { sessionId: session.id, history: [{ sessionId: session.id, focusedAt: 42 }] }, pmo: { sessionId: null } }
const gitStatus: Extract<GitStatusResult, { kind: 'git-repository' }> = { kind: 'git-repository', hostId: 'local', repoPath: '/repo', repoRelativePrefix: '', branch: 'main', changes: [{ path: 'result.txt', origPath: null, index: ' ', worktree: 'M', staged: false, unstaged: true, untracked: false }] }
const diff: GitFileDiff = { path: 'result.txt', old: { present: true, binary: false, text: 'before\n' }, new: { present: true, binary: false, text: 'after\n' }, binary: false, change: 'modified' }
const baseline = useAppStore.getState()
const bridgeDescriptor = Object.getOwnPropertyDescriptor(window, 'agentmux')
const snapshot = (id: string, url: string): BrowserSnapshot => ({ id, navigationId: `${id}:navigation`, profileId: 'profile:default', url, title: 'Result', loading: false, canGoBack: false, canGoForward: false, viewport: 'responsive', error: null, driving: false, appLinkPrompt: null })

describe('Focus Result controls activate their exact existing workbench destination', () => {
  let root: Root
  let container: HTMLDivElement
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    Object.defineProperty(window, 'agentmux', { configurable: true, value: { git: { status: async () => gitStatus, diff: async () => diff } } })
    vi.spyOn(api.files, 'observe').mockResolvedValue()
    vi.spyOn(api.files, 'unobserve').mockResolvedValue()
    vi.spyOn(api.files, 'read').mockImplementation(async (_workspaceId, path) => ({ status: 'read', document: { path, content: 'after\n', revision: 'r1' } }))
    vi.spyOn(api.browser, 'create').mockImplementation(async (id, url) => snapshot(id, url))
    useAppStore.setState({
      mainSurface: 'agents', activeWorkspaceId: 'other', sessions: [session], agentFocus: context,
      agentComposerDrafts: { [session.id]: 'original draft' },
      tabs: { [agentTab.id]: agentTab }, layouts: { repo: createWorkspaceLayout('group', [agentTab.id]), other: createWorkspaceLayout('other-group') },
      config: { appearance: { terminalTheme: 'graphite' }, executors: {}, workspaces: [{ id: 'repo', path: '/repo', name: 'Repo', hostId: 'local', kind: 'folder' }] } as never,
      timelines: { [session.id]: { agentSessionId: session.id, revision: 1, items: [{ id: 'assistant', kind: 'assistant_message', content: 'Preview https://example.test/result', createdAt: 2 }] } } as never,
      documents: {}, closingWorkbenchViews: {}, editorRegionModes: {}, editorRegionDiffs: {}, error: null
    })
  })
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove()
    vi.restoreAllMocks(); useAppStore.setState(baseline, true)
    if (bridgeDescriptor) Object.defineProperty(window, 'agentmux', bridgeDescriptor)
    else Reflect.deleteProperty(window, 'agentmux')
  })

  async function mountReview(workbench: 'projection' | 'owner' | undefined = undefined, workspaceId = 'repo') {
    await act(async () => root.render(createElement(Fragment, null, createElement(SessionPane, { sessionId: session.id, surfaceKind: 'agent', interactiveResize: false, visible: true, linkOrigin: origin }), workbench ? createElement(WorkspaceWorkbench, { workspaceId, visible: true, viewOwnership: workbench }) : null)))
    const review = container.querySelector('.session-result-review button[aria-expanded]') as HTMLButtonElement
    expect(review).toBeTruthy()
    await act(async () => review.click())
    expect(container.querySelectorAll('.session-result-review__details-actions button').length).toBeGreaterThan(0)
  }
  async function clickResult(title: string) {
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('.session-result-review__details-actions button')].filter((button) => button.querySelector('span')?.title === title)
    expect(buttons).toHaveLength(1)
    await act(async () => { buttons[0]!.click(); await new Promise((resolve) => setTimeout(resolve, 0)) })
  }
  function retainedExecution() {
    const state = useAppStore.getState()
    expect(state.agentFocus).toEqual(context)
    expect(state.agentComposerDrafts).toEqual({ [session.id]: 'original draft' })
    expect(state.tabs[agentTab.id]).toEqual(agentTab)
    expect(state.sessions).toEqual([session])
  }

  it('file Result reveals the canonical Diff in its owning Workspace without selecting the original Agent Tab', async () => {
    await mountReview(); await clickResult('result.txt')
    const state = useAppStore.getState(), tabId = fileTabId('repo', 'result.txt'), regionId = initialWorkbenchRegionId(tabId)
    expect(state.mainSurface).toBe('workbench')
    expect(state.activeWorkspaceId).toBe('repo')
    expect(state.layouts.repo?.groups.find((group) => group.id === 'group')?.activeTabId).toBe(tabId)
    expect(state.tabs[tabId]?.regions[regionId]).toMatchObject({ kind: 'file', workspaceId: 'repo', path: 'result.txt' })
    expect(state.tabs[tabId]?.layout.activeRegionId).toBe(regionId)
    expect(state.editorRegionModes[regionId]).toBe('diff')
    expect(state.editorRegionDiffs[regionId]).toEqual({ loading: false, diff, error: null })
    retainedExecution()
  })

  it('Preview Result reveals the newly placed Browser Tab in the durable Session group', async () => {
    await mountReview(); await clickResult('https://example.test/result')
    const state = useAppStore.getState(), created = Object.values(state.tabs).filter((tab) => tab.id !== agentTab.id)
    expect(created).toHaveLength(1)
    const tab = created[0]!, regionId = tab.layout.activeRegionId
    expect(state.mainSurface).toBe('workbench')
    expect(state.activeWorkspaceId).toBe('repo')
    expect(state.layouts.repo?.groups.find((group) => group.id === 'group')?.activeTabId).toBe(tab.id)
    expect(tab.regions[regionId]).toMatchObject({ kind: 'browser', workspaceId: 'repo', url: 'https://example.test/result', browserId: regionId })
    retainedExecution()
  })

  it('reveals an already placed file in its own group and Region', async () => {
    const tabId = fileTabId('repo', 'result.txt'), regionId = initialWorkbenchRegionId(tabId)
    const fileTab = createWorkbenchTab(tabId, { regionId, kind: 'file', workspaceId: 'repo', path: 'result.txt' })
    const layout = moveTabToNewGroup(createWorkspaceLayout('group', [agentTab.id, tabId]), tabId, 'group', 'group', 'right', 'file-group')
    useAppStore.setState({ tabs: { [agentTab.id]: agentTab, [tabId]: fileTab }, documents: { [documentKey('repo', 'result.txt')]: { path: 'result.txt', content: 'after\n', revision: 'r1' } }, layouts: { ...useAppStore.getState().layouts, repo: { ...layout, activeGroupId: 'group', groups: layout.groups.map((group) => group.id === 'file-group' ? { ...group, tabOrder: [tabId], activeTabId: tabId } : group) } } })
    await useAppStore.getState().openFileDiff('result.txt', 'repo')
    expect(useAppStore.getState().mainSurface).toBe('workbench')
    expect(useAppStore.getState().layouts.repo?.activeGroupId).toBe('file-group')
    expect(useAppStore.getState().tabs[tabId]?.layout.activeRegionId).toBe(regionId)
    retainedExecution()
  })

  it('does not reveal or load an orphan Diff when the file producer failed', async () => {
    vi.mocked(api.files.read).mockResolvedValue({ status: 'deleted' })
    await useAppStore.getState().openFileDiff('missing.txt', 'repo')
    expect(useAppStore.getState().mainSurface).toBe('agents')
    expect(useAppStore.getState().tabs).toEqual({ [agentTab.id]: agentTab })
    expect(useAppStore.getState().editorRegionModes).toEqual({})
    expect(useAppStore.getState().error).toContain('File was deleted')
    retainedExecution()
  })

  it('keeps low-level file and Browser preparation on the current main surface', async () => {
    useAppStore.setState({ activeWorkspaceId: 'repo' })
    await useAppStore.getState().openFile('prepared.txt', undefined, undefined, 'repo')
    expect(useAppStore.getState().documents[documentKey('repo', 'prepared.txt')]).toMatchObject({ content: 'after\n' })
    expect(useAppStore.getState().mainSurface).toBe('agents')
    await useAppStore.getState().createBrowser('group', undefined, 'https://example.test/prepared')
    const browsers = Object.values(useAppStore.getState().tabs).flatMap((tab) => Object.values(tab.regions)).filter((surface) => surface.kind === 'browser')
    expect(browsers).toHaveLength(1)
    expect(useAppStore.getState().mainSurface).toBe('agents')
    retainedExecution()
  })

  it('keeps the Mote Topic background preparation on its existing floating owner', async () => {
    const topicTab = { ...createWorkbenchTab('mote-tab', { kind: 'launcher', regionId: 'mote-region', workspaceId: SCRATCH_WORKSPACE_ID }), topicId: PMO_TEAMS_TOPIC_ID }
    const config = useAppStore.getState().config!
    useAppStore.setState({ config: { ...config, workspaces: [...config.workspaces, { id: SCRATCH_WORKSPACE_ID, path: '/scratch', hostId: 'local', name: 'Scratch', kind: 'scratch' }] } as never, tabs: { ...useAppStore.getState().tabs, [topicTab.id]: topicTab }, layouts: { ...useAppStore.getState().layouts, [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('mote-group', [topicTab.id]) } })
    vi.spyOn(api.scratch, 'readTopic').mockResolvedValue({ topicId: PMO_TEAMS_TOPIC_ID, soul: 'PMO', files: [] } as never)
    const before = useAppStore.getState()
    await useAppStore.getState().openScratchTopic(PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, { reveal: false, tabId: topicTab.id })
    expect(useAppStore.getState().mainSurface).toBe('agents')
    expect(useAppStore.getState().activeWorkspaceId).toBe('other')
    expect(useAppStore.getState().tabs).toBe(before.tabs)
    expect(useAppStore.getState().layouts).toBe(before.layouts)
    retainedExecution()
  })

  it('does not steal a later Focus navigation when pending Browser creation completes', async () => {
    let resolve!: (value: BrowserSnapshot) => void
    const pending = new Promise<BrowserSnapshot>((done) => { resolve = done })
    vi.mocked(api.browser.create).mockImplementation(async (id, url) => { await pending; return snapshot(id, url) })
    const opening = useAppStore.getState().openHttpLink(origin, 'https://example.test/pending', 'tab')
    expect(useAppStore.getState().mainSurface).toBe('workbench')
    const launcher = Object.values(useAppStore.getState().tabs).filter((tab) => tab.id !== agentTab.id)
    expect(launcher).toHaveLength(1)
    useAppStore.getState().setMainSurface('agents')
    resolve(snapshot('unused', 'https://example.test/pending')); await opening
    expect(useAppStore.getState().mainSurface).toBe('agents')
    expect(launcher[0] && useAppStore.getState().tabs[launcher[0].id]?.regions[launcher[0].layout.activeRegionId]).toMatchObject({ kind: 'browser' })
    retainedExecution()
  })

  it.each(['Goals', 'Workspace'] as const)('keeps later %s navigation when a pending file read completes', async (destination) => {
    let complete!: (value: Awaited<ReturnType<typeof api.files.read>>) => void
    const pending = new Promise<Awaited<ReturnType<typeof api.files.read>>>((done) => { complete = done })
    vi.mocked(api.files.read).mockReturnValue(pending)
    useAppStore.setState({ activeWorkspaceId: 'repo' })
    const opening = useAppStore.getState().openFileDiff('pending.txt', 'repo')
    await vi.waitFor(() => expect(api.files.read).toHaveBeenCalledWith('repo', 'pending.txt'))
    if (destination === 'Goals') useAppStore.getState().setMainSurface('board')
    else await useAppStore.getState().selectWorkspace('other')
    const navigation = { surface: useAppStore.getState().mainSurface, workspace: useAppStore.getState().activeWorkspaceId }
    complete({ status: 'read', document: { path: 'pending.txt', content: 'after\n', revision: 'r1' } }); await opening
    expect({ surface: useAppStore.getState().mainSurface, workspace: useAppStore.getState().activeWorkspaceId }).toEqual(navigation)
    expect(useAppStore.getState().editorRegionModes[initialWorkbenchRegionId(fileTabId('repo', 'pending.txt'))]).toBe('diff')
    retainedExecution()
  })

  function seedFileNavigation(group = false) {
    const tabId = fileTabId('repo', 'existing.txt'), regionId = initialWorkbenchRegionId(tabId)
    let tab = createWorkbenchTab(tabId, { kind: 'file', workspaceId: 'repo', path: 'existing.txt', regionId })
    tab = addWorkbenchRegion(tab, regionId, 'right', { kind: 'file', workspaceId: 'repo', path: 'secondary.txt', regionId: 'secondary-region' })
    tab = { ...tab, layout: { ...tab.layout, activeRegionId: regionId } }
    let layout = createWorkspaceLayout('group', [agentTab.id, tabId])
    if (group) layout = { ...moveTabToNewGroup(layout, tabId, 'group', 'group', 'right', 'file-group'), activeGroupId: 'group' }
    useAppStore.setState({ mainSurface: 'workbench', activeWorkspaceId: 'repo',
      tabs: { [agentTab.id]: agentTab, [tab.id]: tab },
      layouts: { ...useAppStore.getState().layouts, repo: layout },
      documents: { [documentKey('repo', 'existing.txt')]: { path: 'existing.txt', content: 'existing\n', revision: 'existing-r1' } },
      lastActiveFileByWorkspace: {} })
    return { tabId, regionId }
  }
  function deferResultRead() {
    let complete!: (value: Awaited<ReturnType<typeof api.files.read>>) => void
    vi.mocked(api.files.read).mockReturnValue(new Promise((done) => { complete = done }))
    return () => complete({ status: 'read', document: { path: 'result.txt', content: 'after\n', revision: 'r1' } })
  }
  async function clickFileTab(tabId: string) {
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('[data-workbench-tab-id]')].filter((el) => el.dataset.workbenchTabId === tabId)
    expect(buttons).toHaveLength(1)
    await act(async () => buttons[0]!.click())
  }
  async function expectResultLoaded() {
    const id = initialWorkbenchRegionId(fileTabId('repo', 'result.txt'))
    await vi.waitFor(() => expect(useAppStore.getState().editorRegionDiffs[id]).toEqual({ loading: false, diff, error: null }))
    expect(useAppStore.getState().documents[documentKey('repo', 'result.txt')]).toMatchObject({ content: 'after\n' })
    expect(useAppStore.getState().documents[documentKey('repo', 'existing.txt')]).toMatchObject({ content: 'existing\n' })
    retainedExecution()
  }

  it.each(['Tab', 'Group', 'Region'] as const)('preserves a later actual %s choice when an earlier Result read completes', async (choice) => {
    const { tabId, regionId } = seedFileNavigation(choice === 'Group')
    if (choice === 'Region') useAppStore.setState({ layouts: { ...useAppStore.getState().layouts, repo: activateLayoutTab(useAppStore.getState().layouts.repo!, 'group', tabId) } })
    const complete = deferResultRead()
    const action = vi.spyOn(useAppStore.getState(), choice === 'Region' ? 'focusRegion' : 'activateTab')
    await mountReview(choice === 'Region' ? 'owner' : 'projection')
    await clickResult('result.txt')
    await vi.waitFor(() => expect(api.files.read).toHaveBeenCalledWith('repo', 'result.txt'))
    const focus = useAppStore.getState().agentFocus
    if (choice === 'Region') {
      const regions = [...container.querySelectorAll<HTMLElement>('[data-workbench-region-id]')].filter((el) => el.dataset.workbenchRegionId === 'secondary-region')
      expect(regions).toHaveLength(1)
      await act(async () => regions[0]!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })))
      expect(action).toHaveBeenCalledWith('repo', tabId, 'secondary-region', 'pointer')
    } else {
      await clickFileTab(tabId)
      expect(action).toHaveBeenCalledWith('repo', choice === 'Group' ? 'file-group' : 'group', tabId)
    }
    const selected = useAppStore.getState(), selectedGroup = selected.layouts.repo!.activeGroupId
    expect(selected.tabs[tabId]?.layout.activeRegionId).toBe(choice === 'Region' ? 'secondary-region' : regionId)
    expect(selected.layouts.repo?.groups.find((g) => g.id === selectedGroup)?.activeTabId).toBe(tabId)
    const lastFile = selected.lastActiveFileByWorkspace.repo
    await act(async () => complete())
    await expectResultLoaded()
    const done = useAppStore.getState()
    expect(done.agentFocus).toBe(focus)
    expect(done.mainSurface).toBe('workbench'); expect(done.activeWorkspaceId).toBe('repo')
    expect(done.layouts.repo?.activeGroupId).toBe(selectedGroup)
    expect(done.layouts.repo?.groups.find((g) => g.id === selectedGroup)?.activeTabId).toBe(tabId)
    expect(done.tabs[tabId]?.layout.activeRegionId).toBe(choice === 'Region' ? 'secondary-region' : regionId)
    expect(done.lastActiveFileByWorkspace.repo).toBe(lastFile)
    expect(done.layouts.repo?.groups.find((g) => g.id === 'group')?.tabOrder).toContain(fileTabId('repo', 'result.txt'))
    const activeButtons = [...container.querySelectorAll<HTMLButtonElement>('[data-workbench-tab-id]')].filter((el) => el.dataset.workbenchTabId === tabId)
    expect(activeButtons).toHaveLength(1); expect(activeButtons[0]!.classList.contains('workbench-tab--active')).toBe(true)
  })

  it('lets a later explicit Result click join shared data with its own navigation choice', async () => {
    const { tabId } = seedFileNavigation(), complete = deferResultRead()
    const open = vi.spyOn(useAppStore.getState(), 'openFile')
    await mountReview('projection'); await clickResult('result.txt')
    await vi.waitFor(() => expect(api.files.read).toHaveBeenCalledTimes(1))
    await clickFileTab(tabId)
    await clickResult('result.txt')
    expect(api.files.read).toHaveBeenCalledTimes(1)
    await act(async () => complete())
    await expectResultLoaded()
    expect(useAppStore.getState().layouts.repo?.groups.find((g) => g.id === 'group')?.activeTabId).toBe(fileTabId('repo', 'result.txt'))
    expect(useAppStore.getState().lastActiveFileByWorkspace.repo).toBe('result.txt')
    expect(api.files.observe).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledTimes(2)
    expect(await Promise.all(open.mock.results.map((call) => call.value))).toEqual([false, true])
  })

  it('still reveals when only an unrelated Region ratio and Focus object change while reading', async () => {
    const { tabId } = seedFileNavigation(), complete = deferResultRead()
    await mountReview('projection'); await clickResult('result.txt')
    await vi.waitFor(() => expect(api.files.read).toHaveBeenCalledTimes(1))
    const state = useAppStore.getState()
    await act(async () => { state.updateRegionSplitRatio('repo', tabId, '', 0.6); useAppStore.setState({ agentFocus: { ...state.agentFocus } }) })
    await act(async () => complete())
    await expectResultLoaded()
    expect(useAppStore.getState().layouts.repo?.groups.find((g) => g.id === 'group')?.activeTabId).toBe(fileTabId('repo', 'result.txt'))
  })

  function trackFileNavigation() {
    const subscribe = useAppStore.subscribe
    const active = new Set<() => void>()
    let maximum = 0, created = 0
    vi.spyOn(useAppStore, 'subscribe').mockImplementation((listener) => {
      const dispose = subscribe(listener)
      // Observe the actual owning resource; React's own subscriptions remain outside this count.
      if (listener.name !== 'observeFileNavigation') return dispose
      created += 1
      const remove = () => { active.delete(remove); dispose() }
      active.add(remove); maximum = Math.max(maximum, active.size)
      return remove
    })
    return { get active() { return active.size }, get maximum() { return maximum }, get created() { return created } }
  }
  function deferResultPair(secondPath = 'later.txt') {
    Object.defineProperty(window, 'agentmux', { configurable: true, value: { git: {
      status: async () => ({ ...gitStatus, changes: [...gitStatus.changes, { ...gitStatus.changes[0]!, path: secondPath }] }),
      diff: async (_workspaceId: string, path: string) => ({ ...diff, path })
    } } })
    const completions = new Map<string, (status?: 'read' | 'deleted') => void>()
    vi.mocked(api.files.read).mockImplementation((_workspaceId, path) => new Promise((complete) => completions.set(path, (status = 'read') => complete(status === 'read' ? { status, document: { path, content: 'after\n', revision: 'r1' } } : { status }))))
    return (path: string, status: 'read' | 'deleted' = 'read') => { expect(completions.has(path)).toBe(true); completions.get(path)!(status) }
  }
  async function expectDiffLoaded(path: string) {
    await vi.waitFor(() => expect(useAppStore.getState().editorRegionDiffs[initialWorkbenchRegionId(fileTabId('repo', path))]).toEqual({ loading: false, diff: { ...diff, path }, error: null }))
    expect(useAppStore.getState().documents[documentKey('repo', path)]?.content).toBe('after\n')
    retainedExecution()
  }

  it.each(['earlier first', 'later first'] as const)('keeps the latest of two actual pending Result choices with %s completion', async (order) => {
    seedFileNavigation()
    const complete = deferResultPair(), resources = trackFileNavigation(), open = vi.spyOn(useAppStore.getState(), 'openFile')
    await mountReview('projection'); await clickResult('result.txt'); await clickResult('later.txt')
    expect(vi.mocked(api.files.read).mock.calls.map((call) => call[1])).toEqual(['result.txt', 'later.txt'])
    expect(resources.maximum).toBe(1); expect(resources.active).toBe(1)
    const paths = order === 'earlier first' ? ['result.txt', 'later.txt'] : ['later.txt', 'result.txt']
    await act(async () => complete(paths[0]!)); await expectDiffLoaded(paths[0]!)
    const remainingAfterFirst = resources.active
    await act(async () => complete(paths[1]!)); await expectDiffLoaded(paths[1]!)
    expect(useAppStore.getState().layouts.repo?.groups.find((g) => g.id === 'group')?.activeTabId).toBe(fileTabId('repo', 'later.txt'))
    expect(useAppStore.getState().lastActiveFileByWorkspace.repo).toBe('later.txt')
    expect(open).toHaveBeenCalledTimes(2)
    expect(await Promise.all(open.mock.results.map((call) => call.value))).toEqual([false, true])
    expect(remainingAfterFirst).toBe(order === 'earlier first' ? 1 : 0)
    expect(resources.active).toBe(0)
  })

  it('does not revive the earlier pending file when the later actual Result choice fails', async () => {
    seedFileNavigation()
    const complete = deferResultPair(), resources = trackFileNavigation()
    await mountReview('projection'); await clickResult('result.txt'); await clickResult('later.txt')
    await act(async () => complete('later.txt', 'deleted'))
    await vi.waitFor(() => expect(useAppStore.getState().error).toContain('File was deleted'))
    expect(resources.active).toBe(0)
    await act(async () => complete('result.txt')); await expectDiffLoaded('result.txt')
    expect(useAppStore.getState().layouts.repo?.groups.find((g) => g.id === 'group')?.activeTabId).toBe(agentTab.id)
    expect(useAppStore.getState().lastActiveFileByWorkspace.repo).toBeUndefined()
    expect(useAppStore.getState().tabs[fileTabId('repo', 'later.txt')]).toBeUndefined()
    expect(resources.maximum).toBe(1); expect(resources.active).toBe(0)
  })

  it('keeps the actual current Workspace Tab when a floated Result targets another Workspace', async () => {
    seedFileNavigation()
    const firstId = fileTabId('other', 'first.txt'), nextId = fileTabId('other', 'next.txt')
    const first = createWorkbenchTab(firstId, { kind: 'file', regionId: initialWorkbenchRegionId(firstId), workspaceId: 'other', path: 'first.txt' })
    const next = createWorkbenchTab(nextId, { kind: 'file', regionId: initialWorkbenchRegionId(nextId), workspaceId: 'other', path: 'next.txt' })
    const state = useAppStore.getState()
    useAppStore.setState({ activeWorkspaceId: 'other', tabs: { ...state.tabs, [firstId]: first, [nextId]: next }, layouts: { ...state.layouts, other: createWorkspaceLayout('other-group', [firstId, nextId]) }, documents: { ...state.documents, [documentKey('other', 'first.txt')]: { path: 'first.txt', content: 'first\n', revision: 'r1' }, [documentKey('other', 'next.txt')]: { path: 'next.txt', content: 'next\n', revision: 'r1' } } })
    const complete = deferResultRead(), resources = trackFileNavigation(), activate = vi.spyOn(useAppStore.getState(), 'activateTab')
    await mountReview('projection', 'other'); await clickResult('result.txt')
    await vi.waitFor(() => expect(api.files.read).toHaveBeenCalledTimes(1))
    expect(resources.active).toBe(1)
    await clickFileTab(nextId)
    expect(activate).toHaveBeenCalledWith('other', 'other-group', nextId)
    expect(resources.active).toBe(0)
    const lastFile = useAppStore.getState().lastActiveFileByWorkspace.other
    await act(async () => complete()); await expectResultLoaded()
    expect(useAppStore.getState().activeWorkspaceId).toBe('other')
    expect(useAppStore.getState().layouts.other?.groups[0]?.activeTabId).toBe(nextId)
    expect(useAppStore.getState().lastActiveFileByWorkspace.other).toBe(lastFile)
    expect(resources.active).toBe(0)
  })

  it('keeps a real Tab departure and return instead of treating equal final IDs as no navigation', async () => {
    const { tabId } = seedFileNavigation(), complete = deferResultRead(), resources = trackFileNavigation()
    await mountReview('projection'); await clickResult('result.txt')
    expect(resources.active).toBe(1)
    await clickFileTab(tabId); await clickFileTab(agentTab.id)
    expect(useAppStore.getState().layouts.repo?.groups[0]?.activeTabId).toBe(agentTab.id)
    expect(resources.active).toBe(0)
    const lastFile = useAppStore.getState().lastActiveFileByWorkspace.repo
    await act(async () => complete()); await expectResultLoaded()
    expect(useAppStore.getState().layouts.repo?.groups[0]?.activeTabId).toBe(agentTab.id)
    expect(useAppStore.getState().lastActiveFileByWorkspace.repo).toBe(lastFile)
  })

  it('gives a cached actual Result choice its own intent ahead of an earlier read', async () => {
    const { tabId } = seedFileNavigation(), complete = deferResultPair('existing.txt'), resources = trackFileNavigation()
    await mountReview('projection'); await clickResult('result.txt'); await clickResult('existing.txt')
    await vi.waitFor(() => expect(useAppStore.getState().editorRegionModes[initialWorkbenchRegionId(tabId)]).toBe('diff'))
    expect(vi.mocked(api.files.read).mock.calls.map((call) => call[1])).toEqual(['result.txt'])
    expect(resources.active).toBe(0)
    await act(async () => complete('result.txt')); await expectDiffLoaded('result.txt')
    expect(useAppStore.getState().layouts.repo?.groups[0]?.activeTabId).toBe(tabId)
    expect(resources.maximum).toBe(1); expect(resources.active).toBe(0)
  })

  it('releases the actual pending intent subscription after a read exception', async () => {
    seedFileNavigation()
    let reject!: (reason: Error) => void
    vi.mocked(api.files.read).mockReturnValue(new Promise((_resolve, fail) => { reject = fail }))
    const resources = trackFileNavigation()
    await mountReview('projection'); await clickResult('result.txt')
    expect(resources.active).toBe(1); expect(resources.created).toBe(1)
    await act(async () => reject(new Error('read failed')))
    await vi.waitFor(() => expect(useAppStore.getState().error).toContain('read failed'))
    expect(resources.active).toBe(0)
    expect(useAppStore.getState().tabs[fileTabId('repo', 'result.txt')]).toBeUndefined()
    retainedExecution()
  })

  it('keeps passive restored document data outside the explicit pending file intent', async () => {
    seedFileNavigation()
    useAppStore.setState({ documents: {} })
    const completions = new Map<string, () => void>()
    vi.mocked(api.files.read).mockImplementation((_workspaceId, path) => new Promise((done) => completions.set(path, () => done({ status: 'read', document: { path, content: 'after', revision: 'r1' } }))))
    const resources = trackFileNavigation()
    await mountReview('projection'); await clickResult('result.txt')
    // Real existing restoration producer, not an Editor leaf/Native restoration claim.
    const restoring = useAppStore.getState().attachPersistedFileDocument('repo', 'existing.txt')
    await vi.waitFor(() => expect(vi.mocked(api.files.read).mock.calls.map((call) => call[1])).toEqual(['result.txt', 'existing.txt']))
    expect(resources.active).toBe(1); expect(resources.created).toBe(1)
    await act(async () => { expect(completions.has('result.txt')).toBe(true); completions.get('result.txt')!() })
    await vi.waitFor(() => expect(useAppStore.getState().editorRegionDiffs[initialWorkbenchRegionId(fileTabId('repo', 'result.txt'))]).toEqual({ loading: false, diff, error: null }))
    expect(useAppStore.getState().layouts.repo?.groups[0]?.activeTabId).toBe(fileTabId('repo', 'result.txt'))
    await act(async () => { expect(completions.has('existing.txt')).toBe(true); completions.get('existing.txt')!(); await restoring })
    expect(useAppStore.getState().documents[documentKey('repo', 'existing.txt')]?.content).toBe('after')
    expect(useAppStore.getState().documents[documentKey('repo', 'result.txt')]?.content).toBe('after')
    expect(useAppStore.getState().layouts.repo?.groups[0]?.activeTabId).toBe(fileTabId('repo', 'result.txt'))
    expect(resources.maximum).toBe(1); expect(resources.active).toBe(0)
    retainedExecution()
  })

  function deferNonFileResult(kind: 'bookmark' | 'directory') {
    useAppStore.setState({ toolsOpen: false })
    const path = kind === 'bookmark' ? 'link.url' : 'folder'
    Object.defineProperty(window, 'agentmux', { configurable: true, value: { git: {
      status: async () => ({ ...gitStatus, changes: [{ ...gitStatus.changes[0]!, path }] }), diff: async () => diff
    } } })
    let complete!: () => void
    if (kind === 'bookmark') vi.spyOn(api.files, 'readBookmark').mockReturnValue(new Promise((done) => { complete = () => done({ url: 'https://example.test/bookmark', binary: false }) }))
    else vi.mocked(api.files.read).mockReturnValue(new Promise((done) => { complete = () => done({ status: 'directory' }) }))
    return { path, complete: async () => { complete(); await new Promise((done) => setTimeout(done, 0)) } }
  }

  it.each(['bookmark', 'directory'] as const)('keeps the later actual Tab choice after a pending %s result', async (kind) => {
    const { tabId } = seedFileNavigation(), { path, complete } = deferNonFileResult(kind)
    const activate = vi.spyOn(useAppStore.getState(), 'activateTab'), resources = trackFileNavigation()
    await mountReview('projection'); await clickResult(path)
    expect(resources.active).toBe(1)
    await clickFileTab(tabId)
    expect(activate).toHaveBeenCalledWith('repo', 'group', tabId)
    expect(resources.active).toBe(0)
    const selected = useAppStore.getState(), lastFile = selected.lastActiveFileByWorkspace.repo
    await act(complete)
    expect(useAppStore.getState().layouts.repo?.groups[0]?.activeTabId).toBe(tabId)
    expect(useAppStore.getState().tabs[tabId]?.layout.activeRegionId).toBe(selected.tabs[tabId]?.layout.activeRegionId)
    expect(useAppStore.getState().lastActiveFileByWorkspace.repo).toBe(lastFile)
    expect(useAppStore.getState().toolsOpen).toBe(false)
    expect(api.browser.create).not.toHaveBeenCalled()
    expect(useAppStore.getState().documents[documentKey('repo', path)]).toBeUndefined()
    expect(resources.active).toBe(0); retainedExecution()
  })

  it.each(['bookmark', 'directory'] as const)('keeps the existing %s outlet when its actual Result choice remains current', async (kind) => {
    seedFileNavigation()
    const { path, complete } = deferNonFileResult(kind), resources = trackFileNavigation()
    await mountReview('projection'); await clickResult(path)
    expect(resources.active).toBe(1)
    await act(complete)
    const state = useAppStore.getState()
    expect(state.mainSurface).toBe('workbench'); expect(state.activeWorkspaceId).toBe('repo')
    expect(state.documents[documentKey('repo', path)]).toBeUndefined()
    if (kind === 'bookmark') {
      const browsers = Object.values(state.tabs).flatMap((tab) => Object.values(tab.regions)).filter((surface) => surface.kind === 'browser')
      expect(browsers).toHaveLength(1)
      expect(browsers[0]).toMatchObject({ url: 'https://example.test/bookmark', bookmarkOrigin: { path, binary: false } })
      const tab = Object.values(state.tabs).find((candidate) => candidate.regions[browsers[0]!.regionId])!
      expect(state.layouts.repo?.groups[0]?.activeTabId).toBe(tab.id)
      expect(api.files.read).not.toHaveBeenCalled()
    } else {
      expect(state.toolsOpen).toBe(true); expect(state.workspaceTool).toBe('files-branches')
      expect(state.fileExplorerStates.repo?.selection.activePath).toBe(path)
      expect(api.files.observe).toHaveBeenCalledTimes(1); expect(api.files.unobserve).toHaveBeenCalledTimes(1)
      expect(api.browser.create).not.toHaveBeenCalled()
    }
    expect(resources.active).toBe(0); retainedExecution()
  })

  it('gives a joined directory Result its own latest qualification without sharing navigation', async () => {
    const { tabId } = seedFileNavigation(), { path, complete } = deferNonFileResult('directory')
    const resources = trackFileNavigation(), open = vi.spyOn(useAppStore.getState(), 'openFile')
    await mountReview('projection'); await clickResult(path); await clickFileTab(tabId); await clickResult(path)
    expect(api.files.read).toHaveBeenCalledTimes(1); expect(resources.active).toBe(1)
    await act(complete)
    const state = useAppStore.getState()
    expect(state.toolsOpen).toBe(true); expect(state.workspaceTool).toBe('files-branches')
    expect(state.fileExplorerStates.repo?.selection.activePath).toBe(path)
    expect(state.layouts.repo?.groups[0]?.activeTabId).toBe(tabId)
    expect(api.files.observe).toHaveBeenCalledTimes(1); expect(api.files.unobserve).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledTimes(2)
    // Directories have no file Document/Diff destination, even when Files is revealed.
    expect(await Promise.all(open.mock.results.map((call) => call.value))).toEqual([false, false])
    expect(state.documents[documentKey('repo', path)]).toBeUndefined()
    expect(resources.maximum).toBe(1); expect(resources.active).toBe(0); retainedExecution()
  })

  it.each([['bookmark', 'workbench'], ['bookmark', 'agents'], ['directory', 'workbench']] as const)('opens a current %s Result from %s in its requested Workspace', async (kind, surface) => {
    seedFileNavigation()
    const { path, complete } = deferNonFileResult(kind), resources = trackFileNavigation()
    const stateBefore = useAppStore.getState(), config = stateBefore.config!
    const otherId = fileTabId('other', 'current.txt')
    const otherTab = createWorkbenchTab(otherId, { kind: 'file', workspaceId: 'other', path: 'current.txt', regionId: initialWorkbenchRegionId(otherId) })
    useAppStore.setState({ mainSurface: surface, activeWorkspaceId: 'other',
      tabs: { ...stateBefore.tabs, [otherId]: otherTab },
      layouts: { ...stateBefore.layouts, other: createWorkspaceLayout('other-group', [otherId]) },
      documents: { ...stateBefore.documents, [documentKey('other', 'current.txt')]: { path: 'current.txt', content: 'current\n', revision: 'r1' } },
      config: { ...config, hosts: [{ id: 'local', kind: 'local', label: 'Local' }], workspaces: [...config.workspaces, { id: 'other', path: '/other', name: 'Other', hostId: 'local', kind: 'folder' }] } as never })
    const otherLayout = useAppStore.getState().layouts.other
    await mountReview('projection', 'other'); await clickResult(path)
    expect(kind === 'bookmark' ? api.files.readBookmark : api.files.read).toHaveBeenCalledWith('repo', path)
    expect(useAppStore.getState().activeWorkspaceId).toBe('other'); expect(resources.active).toBe(1)
    await act(complete)
    const state = useAppStore.getState()
    expect(state.activeWorkspaceId).toBe('repo'); expect(state.layouts.repo?.activeGroupId).toBe('group')
    if (kind === 'bookmark') {
      const browsers = Object.values(state.tabs).flatMap((tab) => Object.values(tab.regions)).filter((candidate) => candidate.kind === 'browser')
      expect(browsers).toHaveLength(1)
      expect(browsers[0]).toMatchObject({ workspaceId: 'repo', url: 'https://example.test/bookmark' })
      const tab = Object.values(state.tabs).find((candidate) => candidate.regions[browsers[0]!.regionId])!
      expect(state.layouts.repo?.groups.find((group) => group.id === 'group')?.activeTabId).toBe(tab.id)
    } else {
      expect(state.workspaceTool).toBe('files-branches'); expect(state.toolsOpen).toBe(true)
      expect(state.fileExplorerStates.repo?.selection.activePath).toBe(path)
      expect(api.browser.create).not.toHaveBeenCalled()
    }
    expect(state.layouts.other).toBe(otherLayout); expect(state.tabs[otherId]).toBe(otherTab)
    expect(state.mainSurface).toBe('workbench'); expect(state.documents[documentKey('repo', path)]).toBeUndefined()
    expect(resources.active).toBe(0); retainedExecution()
  })

  it('attaches late bookmark Browser data without reclaiming the later Goals surface', async () => {
    seedFileNavigation()
    const { path, complete } = deferNonFileResult('bookmark'), resources = trackFileNavigation()
    let attach!: () => void
    vi.mocked(api.browser.create).mockImplementation((id, url) => new Promise((done) => { attach = () => done(snapshot(id, url)) }))
    await mountReview('projection'); await clickResult(path); await act(complete)
    expect(api.browser.create).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().mainSurface).toBe('workbench'); expect(resources.active).toBe(0)
    await act(async () => useAppStore.getState().setMainSurface('board'))
    const selected = useAppStore.getState().layouts.repo
    await act(async () => { attach(); await new Promise((done) => setTimeout(done, 0)) })
    const state = useAppStore.getState()
    const browsers = Object.values(state.tabs).flatMap((tab) => Object.values(tab.regions)).filter((surface) => surface.kind === 'browser')
    expect(browsers).toHaveLength(1)
    expect(browsers[0]).toMatchObject({ workspaceId: 'repo', url: 'https://example.test/bookmark' })
    expect(state.mainSurface).toBe('board'); expect(state.layouts.repo).toBe(selected)
    expect(resources.active).toBe(0); retainedExecution()
  })

  it('preserves directional and system destinations without taking the main surface from a floated origin', async () => {
    await useAppStore.getState().openHttpLink(origin, 'https://example.test/beside', 'right')
    const state = useAppStore.getState()
    expect(state.mainSurface).toBe('agents')
    expect(Object.keys(state.tabs)).toEqual([agentTab.id])
    expect(Object.values(state.tabs[agentTab.id]!.regions).map((surface) => surface.kind).sort()).toEqual(['agent', 'browser'])
    expect(state.agentFocus).toEqual(context)
    const tabs = state.tabs
    vi.spyOn(api.ui, 'openExternal').mockResolvedValue()
    await useAppStore.getState().openHttpLink(origin, 'https://example.test/system', 'system')
    expect(useAppStore.getState().tabs).toBe(tabs)
    expect(useAppStore.getState().mainSurface).toBe('agents')
  })
})
