// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceLayout, moveTabToNewGroup } from '@agentmux/layout'
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

import { SessionPane } from '../src/renderer/src/components/SessionPane.js'
import { api } from '../src/renderer/src/lib/api.js'
import { createWorkbenchTab, documentKey, fileTabId, initialWorkbenchRegionId } from '../src/renderer/src/lib/workbench-tabs.js'
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
const gitStatus: GitStatusResult = { kind: 'git-repository', hostId: 'local', repoPath: '/repo', repoRelativePrefix: '', branch: 'main', changes: [{ path: 'result.txt', origPath: null, index: ' ', worktree: 'M', staged: false, unstaged: true, untracked: false }] }
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

  async function mountReview() {
    await act(async () => root.render(createElement(SessionPane, { sessionId: session.id, surfaceKind: 'agent', interactiveResize: false, visible: true, linkOrigin: origin })))
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
