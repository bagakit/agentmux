// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { type Root } from 'react-dom/client'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
// Activity, shared messages, author resolution and Composer are actual owners.
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { App } from '../src/renderer/src/App'
import { ScratchTopics } from '../src/main/scratch-topics'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { spaceObjectIdentityKey, topicSpaceIconTarget } from '../src/renderer/src/lib/space-object-appearance'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { customAgent, defaultAgent, defaultTab, installNativePopover, moteSessions, moteTopics, ordinaryAgent, ordinaryTab, seedMoteWorkface } from './fixtures/mote-workface'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '../src/shared/scratch-topics'

let root: Root, host: HTMLDivElement
const original = useAppStore.getState()
const directoryRoots: string[] = []
let restorePopover: (() => void) | undefined
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  seedMoteWorkface()
  useAppStore.setState({ loading: false, viewModes: { [defaultAgent.id]: 'activity', [ordinaryAgent.id]: 'activity' },
    agentNames: { [defaultAgent.id]: 'Help me keep a clear next step.', [customAgent.id]: 'External analyst' },
    spaceObjectIcons: { [spaceObjectIdentityKey('local', moteTopics[0]!.directoryPath)]: 'brain' },
    timelines: { [defaultAgent.id]: { agentSessionId: defaultAgent.id, revision: 1, items: [
      { id: 'owned-reply', agentSessionId: defaultAgent.id, kind: 'assistant_message', source: 'native-hook', status: 'complete', content: 'Original Mote reply', title: 'Original reply', createdAt: 1, updatedAt: 1 },
      { id: 'foreign-reply', agentSessionId: defaultAgent.id, authorAgentSessionId: customAgent.id, kind: 'assistant_message', source: 'native-hook', status: 'complete', content: 'External author reply', title: 'External reply', createdAt: 2, updatedAt: 2 },
      { id: 'unknown-reply', agentSessionId: defaultAgent.id, authorAgentSessionId: 'missing-author', kind: 'assistant_message', source: 'native-hook', status: 'complete', content: 'Unknown author reply', title: 'Unknown reply', createdAt: 3, updatedAt: 3 }
    ] } } })
  vi.spyOn(api.sessions, 'historyPage').mockImplementation(async control => ({ agentSessionId: control.agentSessionId,
    source: { providerId: 'fixture', nativeSessionId: 'original-history' }, items: [], nextCursor: null }))
  vi.spyOn(api.sessions, 'observeHistory').mockResolvedValue({ source: { providerId: 'fixture', nativeSessionId: 'original-history' }, dispose() {} })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); restorePopover?.(); restorePopover = undefined
  vi.restoreAllMocks(); useAppStore.setState(original, true); window.localStorage.clear()
  await Promise.all(directoryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
async function mount(sessionId = defaultAgent.id, tab = defaultTab, visible = true) {
  await act(async () => root.render(createElement(SessionPane, { sessionId, surfaceKind: 'agent', visible, interactiveResize: false,
    linkOrigin: { workspaceId: SCRATCH_WORKSPACE_ID, tabId: tab.id, tabGroupId: 'mote-group', regionId: tab.layout.activeRegionId, sessionId } })))
  await act(async () => new Promise(resolve => setTimeout(resolve, 40)))
}
function row(id: string) { const element = host.querySelector<HTMLElement>('[data-message-id="' + id + '"]'); expect(element).not.toBeNull(); return element! }

describe('actual retained Session message identity', () => {
  it.each([false, true])('consumes actual ScratchTopics output in App while keeping the original Session, draft and avatar; legacy identity=%s', async legacy => {
    const parent = await mkdtemp(join(tmpdir(), 'agentmux-directory-renderer-')); directoryRoots.push(parent)
    const workspace = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: join(await realpath(parent), 'scratch'), name: 'Topics', kind: 'folder' as const }
    await mkdir(workspace.path)
    const service = new ScratchTopics(), first = await service.ensureMote(workspace, PMO_TEAMS_TOPIC_ID)
    const logical = scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID), legacyPath = join(workspace.path, logical)
    expect(first.directoryPath).toBe(logical)
    expect(first.physicalDirectoryPath).toBe(join(await realpath(parent), 'motes', logical))
    expect(first.identityDirectoryPath).toBe(first.physicalDirectoryPath)
    if (legacy) await writeFile(join(first.physicalDirectoryPath!, '.agentmux/directory-identity.json'), JSON.stringify({ version: 1, identityDirectoryPath: legacyPath }))
    const topics = await service.list(workspace), topic = topics.find(item => item.id === PMO_TEAMS_TOPIC_ID)!
    expect(topic.identityDirectoryPath).toBe(legacy ? legacyPath : first.physicalDirectoryPath)
    const target = topicSpaceIconTarget(workspace, topic)
    expect(target.key).toBe(spaceObjectIdentityKey('local', topic.identityDirectoryPath!))
    const launch = vi.fn(), stop = vi.fn(), state = useAppStore.getState()
    useAppStore.setState({ config: { ...state.config!, workspaces: state.config!.workspaces.map(item => item.id === workspace.id ? workspace : item) },
      sessions: state.sessions.map(session => session.id === defaultAgent.id ? { ...session, workspacePath: legacy ? legacyPath : topic.physicalDirectoryPath! } : session),
      scratchTopicSnapshots: { [workspace.id]: { scope: scratchTopicsScope(workspace), revision: 0, topics, error: null, reading: false } },
      spaceObjectIcons: { [target.key]: 'brain' }, initialize: async () => () => {}, prewarmTerminal: vi.fn(), detectExecutors: vi.fn(async () => {}),
      launchAgent: launch, stopSession: stop, activeWorkspaceId: workspace.id, mainSurface: 'workbench', projectRailOpen: true })
    useAppStore.getState().activateTab(workspace.id, 'mote-group', defaultTab.id)
    vi.spyOn(api.scratch, 'listTopics').mockImplementation(() => service.list(workspace))
    const readDirectory = vi.spyOn(api.files, 'readDirectory').mockResolvedValue([])
    vi.spyOn(api.files, 'observe').mockResolvedValue(undefined)
    vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined)
    restorePopover = installNativePopover()
    const protectedState = useAppStore.getState()
    await act(async () => root.render(createElement(App)))
    await act(async () => new Promise(resolve => setTimeout(resolve, 40)))
    const workface = host.querySelector<HTMLElement>('.workspace-workbench-registry [data-mote-workface="' + topic.id + '"]')
    expect(workface).not.toBeNull()
    expect(workface!.textContent).toContain('Discussions')
    const spaceEntry = host.querySelector<HTMLButtonElement>('[data-space-nav="topic:' + topic.id + '"]')
    expect(spaceEntry).not.toBeNull()
    expect(spaceEntry!.getAttribute('data-space-icon-target')).toBe(target.key)
    expect(spaceEntry!.title).toContain(topic.physicalDirectoryPath)
    expect(row('owned-reply').querySelector('.log-turn__who')!.textContent).toBe('Mote')
    expect(row('owned-reply').querySelector('[data-space-icon]')?.getAttribute('data-space-icon')).toBe('brain')
    expect(host.querySelector('[aria-label="Message Agent"]')?.textContent).toContain('Default unsent')
    const materials = workface!.querySelector<HTMLButtonElement>('.mote-conversations__secondary button')
    expect(materials).not.toBeNull()
    await act(async () => materials!.click())
    await act(async () => new Promise(resolve => setTimeout(resolve, 30)))
    expect(workface!.querySelector<HTMLElement>('.file-explorer')?.dataset.fileRoot).toBe(logical)
    expect(readDirectory).toHaveBeenCalledWith(workspace.id, logical)
    expect(useAppStore.getState().sessions.map(session => ({ id: session.id, control: session.control, workspacePath: session.workspacePath, processState: session.processState })))
      .toEqual(protectedState.sessions.map(session => ({ id: session.id, control: session.control, workspacePath: session.workspacePath, processState: session.processState })))
    expect(useAppStore.getState().sessions[0]!.control).toBe(defaultAgent.control)
    expect(useAppStore.getState().agentComposerDrafts).toBe(protectedState.agentComposerDrafts)
    expect(useAppStore.getState().tabs[defaultTab.id]).toBe(protectedState.tabs[defaultTab.id])
    expect(useAppStore.getState().layouts).toBe(protectedState.layouts)
    expect(launch).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled()
    if (legacy) {
      await act(async () => useAppStore.setState(current => ({ sessions: current.sessions.map(session => session.id === defaultAgent.id ? { ...session, workspacePath: topic.physicalDirectoryPath! } : session) })))
      expect(row('owned-reply').querySelector('.log-turn__who')!.textContent).toBe('Mote')
      expect(row('owned-reply').querySelector('[data-space-icon]')?.getAttribute('data-space-icon')).toBe('brain')
      expect(useAppStore.getState().agentComposerDrafts).toBe(protectedState.agentComposerDrafts)
      expect(useAppStore.getState().sessions[0]!.control).toBe(defaultAgent.control)
    }
  })

  it('uses the original Mote name/avatar only for its exact author, retaining foreign and unknown authors', async () => {
    await mount()
    expect(row('owned-reply').querySelector('.log-turn__who')!.textContent).toBe('Mote')
    expect(row('owned-reply').querySelector('[data-mote-author]')?.getAttribute('data-mote-author')).toBe(moteTopics[0]!.id)
    expect(row('owned-reply').querySelector('[data-space-icon]')?.getAttribute('data-space-icon')).toBe('brain')
    expect(row('foreign-reply').querySelector('.log-turn__who')!.textContent).toBe('External analyst')
    expect(row('foreign-reply').querySelector('[data-mote-author]')).toBeNull()
    expect(row('unknown-reply').querySelector('.log-turn__who')!.textContent).toBe('missing-author')
    expect(row('unknown-reply').querySelector('[data-mote-author]')).toBeNull()
    expect(host.querySelector('.activity-feed')?.getAttribute('data-mote-conversation')).toBe('true')
    expect(useAppStore.getState().sessions.map(item => item.control)).toEqual(moteSessions.map(item => item.control))
  })

  it('updates durable display name/appearance without renaming the Session or draft, and ordinary Topic stays ordinary', async () => {
    await mount()
    const before = useAppStore.getState()
    const old = before.scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]!
    await act(async () => useAppStore.setState({ scratchTopicSnapshots: { ...before.scratchTopicSnapshots,
      [SCRATCH_WORKSPACE_ID]: { ...old, topics: old.topics!.map(topic => topic.id === moteTopics[0]!.id ? { ...topic, title: 'Steady partner' } : topic) } },
      spaceObjectIcons: { [spaceObjectIdentityKey('local', moteTopics[0]!.directoryPath)]: 'compass' } }))
    expect(row('owned-reply').querySelector('.log-turn__who')!.textContent).toBe('Steady partner')
    expect(row('owned-reply').querySelector('[data-space-icon]')?.getAttribute('data-space-icon')).toBe('compass')
    expect(useAppStore.getState().agentNames).toBe(before.agentNames)
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    await mount(ordinaryAgent.id, ordinaryTab)
    expect(host.querySelector('.activity-feed')?.getAttribute('data-mote-conversation')).toBeNull()
    expect(host.querySelector('[data-mote-author]')).toBeNull()
  })

  it('does not claim the current Mote for a Session from another Host or a nested directory', async () => {
    for (const change of [{ hostId: 'other-host' }, { workspacePath: defaultAgent.workspacePath + '/nested' }]) {
      await act(async () => useAppStore.setState({ sessions: useAppStore.getState().sessions.map(session => session.id === defaultAgent.id ? { ...defaultAgent, ...change } : session) }))
      await mount()
      expect(row('owned-reply').querySelector('.log-turn__who')!.textContent).toBe('Help me keep a clear next step.')
      expect(row('owned-reply').querySelector('[data-mote-author]')).toBeNull()
    }
  })

  it('keeps original identity resolution cold while unrelated timelines receive output', async () => {
    const find = vi.spyOn(moteTopics, 'find')
    await mount()
    expect(find).toHaveBeenCalled()
    find.mockClear()
    for (let revision = 1; revision <= 8; revision++) await act(async () => useAppStore.setState(state => ({ timelines: {
      ...state.timelines, unrelated: { agentSessionId: 'unrelated', revision, items: [
        { id: 'unrelated-reply', agentSessionId: 'unrelated', kind: 'assistant_message', source: 'native-hook', status: 'complete', content: String(revision), title: 'Unrelated output', createdAt: 1, updatedAt: revision }
      ] }
    } })))
    expect(find).not.toHaveBeenCalled()
    expect(row('owned-reply').querySelector('.log-turn__who')!.textContent).toBe('Mote')
    expect(row('foreign-reply').querySelector('.log-turn__who')!.textContent).toBe('External analyst')
  })
})
