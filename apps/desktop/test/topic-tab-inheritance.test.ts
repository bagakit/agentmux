import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import type { AgentLaunchResult, AppConfig, BrowserSnapshot, SessionSnapshot } from '../src/shared/contracts.js'
import { api } from '../src/renderer/src/lib/api.js'
import { createWorkspaceLayout } from '@agentmux/layout'
import {
  createWorkbenchTab,
  inheritedTopicIdForNewTab,
  initialWorkbenchRegionId,
  type WorkbenchTab
} from '../src/renderer/src/lib/workbench-tabs.js'
import { useAppStore } from '../src/renderer/src/store.js'
import { SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '../src/shared/scratch-topics.js'

const initialState = useAppStore.getState()
const topicId = 'view:shared'
const scratchPath = '/scratch'
const topicPath = `${scratchPath}/${scratchTopicDirectoryName(topicId)}`

const config: AppConfig = {
  version: 9,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {
    codex: { label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true }
  },
  workspaces: [{ id: SCRATCH_WORKSPACE_ID, name: 'Scratch', hostId: 'local', path: scratchPath, kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true } }
}

function launcher(id: string, binding: string | undefined = topicId): WorkbenchTab {
  const tab = createWorkbenchTab(id, {
    regionId: initialWorkbenchRegionId(id),
    kind: 'launcher',
    workspaceId: SCRATCH_WORKSPACE_ID
  })
  return binding ? { ...tab, topicId: binding } : tab
}

function agentSession(id: string): Extract<SessionSnapshot, { kind: 'agent' }> {
  return {
    id,
    kind: 'agent',
    providerId: 'codex',
    executorId: 'codex',
    capabilities: {
      terminal: true,
      timeline: 'streaming',
      permission: 'observe',
      providerResume: true,
      replyCorrelation: 'none'
    },
    hostId: 'local',
    workspacePath: topicPath,
    label: 'Codex',
    createdAt: 1,
    updatedAt: 1,
    processState: 'running',
    status: { state: 'running', source: 'run-process', observedAt: 1 },
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run:${id}` } }
  }
}

function browser(id: string, url = 'about:blank'): BrowserSnapshot {
  return {
    id,
    navigationId: `${id}:navigation`,
    profileId: 'profile:default',
    url,
    title: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    viewport: 'responsive',
    error: null,
    driving: false
  }
}

function launch(session: Extract<SessionSnapshot, { kind: 'agent' }>): AgentLaunchResult {
  return { session, timeline: { agentSessionId: session.id, revision: 0, items: [] } }
}

function mountAnchor(binding: string | undefined = topicId): WorkbenchTab {
  const anchor = launcher('anchor', binding)
  useAppStore.setState({
    config,
    sessions: [],
    timelines: {},
    activeWorkspaceId: SCRATCH_WORKSPACE_ID,
    mainSurface: 'workbench',
    tabs: { [anchor.id]: anchor },
    layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('group', [anchor.id]) },
    pendingAgentLaunches: {},
    closingWorkbenchViews: {},
    error: null
  })
  return anchor
}

function createdTabExcept(anchorId: string): WorkbenchTab {
  const tab = Object.values(useAppStore.getState().tabs).find((candidate) => candidate.id !== anchorId)
  if (!tab) throw new Error('Expected a newly created Tab')
  return tab
}

afterEach(() => {
  vi.restoreAllMocks()
  useAppStore.setState(initialState, true)
})

describe('Scratch Topic binding at new Tab creation boundaries', () => {
  it('copies the active Topic into the Tabbar plus Launcher', () => {
    const anchor = mountAnchor()
    useAppStore.getState().openLauncher('group')
    expect(createdTabExcept(anchor.id).topicId).toBe(topicId)
  })

  it('copies the active Topic into Agent, Terminal, and Browser Tabs created without a Launcher', async () => {
    const anchor = mountAnchor()
    const launchAgent = vi.spyOn(api.sessions, 'launchAgent')
      .mockImplementation(async (input) => launch(agentSession(input.agentSessionId!)))
    await useAppStore.getState().launchAgent('codex', 'agent', 'group')
    expect(launchAgent.mock.calls[0]![0].scratchTopicId).toBe(topicId)
    expect(createdTabExcept(anchor.id).topicId).toBe(topicId)

    useAppStore.setState({
      tabs: { [anchor.id]: anchor },
      layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('group', [anchor.id]) },
      sessions: []
    })
    await useAppStore.getState().launchTerminal('group')
    expect(createdTabExcept(anchor.id).topicId).toBe(topicId)

    useAppStore.setState({
      tabs: { [anchor.id]: anchor },
      layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('group', [anchor.id]) },
      sessions: []
    })
    vi.spyOn(api.browser, 'create').mockImplementation(async (id, url) => browser(id, url))
    await useAppStore.getState().createBrowser('group', undefined, 'https://example.com')
    expect(createdTabExcept(anchor.id).topicId).toBe(topicId)
  })

  it('copies the active Topic into an HTTP-link new Tab before Browser creation settles', async () => {
    const anchor = mountAnchor()
    let release!: () => void
    vi.spyOn(api.browser, 'create').mockImplementation(async (id, url) => (
      await new Promise<BrowserSnapshot>((resolve) => { release = () => resolve(browser(id, url)) })
    ))

    const opening = useAppStore.getState().openHttpLink({
      workspaceId: SCRATCH_WORKSPACE_ID,
      tabGroupId: 'group',
      tabId: anchor.id,
      regionId: anchor.layout.activeRegionId
    }, 'https://example.com', 'tab')
    const pending = createdTabExcept(anchor.id)
    expect(pending.topicId).toBe(topicId)
    release()
    await opening
    expect(useAppStore.getState().tabs[pending.id]?.topicId).toBe(topicId)
  })

  it('copies the active Topic into a Control new Tab while preserving explicit Session targets', async () => {
    const anchor = mountAnchor()
    const launchAgent = vi.spyOn(api.sessions, 'launchAgent')
      .mockImplementation(async (input) => launch(agentSession(input.agentSessionId!)))
    await useAppStore.getState().executeControl({
      schemaVersion: 1,
      requestId: 'control-open-agent',
      operation: 'open.agent',
      content: { kind: 'new-agent', executorId: 'codex', prompt: 'work' },
      destination: { kind: 'new-tab', after: { kind: 'tab', tabId: anchor.id } }
    })

    const created = createdTabExcept(anchor.id)
    expect(created.topicId).toBe(topicId)
    expect(launchAgent.mock.calls[0]![0].scratchTopicId).toBe(topicId)
  })

  it('does not invent a Topic for ordinary Git Workspaces', () => {
    const projectConfig: AppConfig = { ...config, workspaces: [{ ...config.workspaces[0]!, id: 'project', path: '/repo' }] }
    const anchor = createWorkbenchTab('project-anchor', {
      regionId: 'project-region', kind: 'launcher', workspaceId: 'project'
    })
    useAppStore.setState({
      config: projectConfig,
      activeWorkspaceId: 'project',
      tabs: { [anchor.id]: anchor },
      layouts: { project: createWorkspaceLayout('group', [anchor.id]) }
    })
    useAppStore.getState().openLauncher('group')
    expect(createdTabExcept(anchor.id).topicId).toBeUndefined()
  })

  it('never carries a stale Topic binding into an ordinary Git Workspace', () => {
    const projectTab = createWorkbenchTab('project-anchor', {
      regionId: 'project-region', kind: 'launcher', workspaceId: 'project'
    })
    const boundProjectTab = { ...projectTab, topicId }
    const layout = createWorkspaceLayout('group', [projectTab.id])
    expect(inheritedTopicIdForNewTab('project', layout, { [boundProjectTab.id]: boundProjectTab }))
      .toBeUndefined()
  })
})
