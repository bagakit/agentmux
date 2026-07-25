import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import {
  AGENTMUX_CONTROL_SCHEMA_VERSION,
  type AgentMuxControlRequest
} from '@agentmux/core'
import type { AgentLaunchResult, AppConfig, SessionSnapshot } from '../src/shared/contracts.js'
import { api } from '../src/renderer/src/lib/api.js'
import { createWorkspaceLayout } from '../src/renderer/src/lib/workbench-layout.js'
import {
  addWorkbenchRegion,
  createWorkbenchTab,
  initialWorkbenchRegionId,
  workbenchSurfaces,
  type WorkbenchTab
} from '../src/renderer/src/lib/workbench-tabs.js'
import { executorDetectionKey, useAppStore } from '../src/renderer/src/store.js'

const initialState = useAppStore.getState()
const config: AppConfig = {
  version: 7,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {
    codex: {
      label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true
    }
  },
  workspaces: [{ id: 'workspace', name: 'Project', hostId: 'local', path: '/repo', kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true } }
}

function agent(id: string): Extract<SessionSnapshot, { kind: 'agent' }> {
  return {
    id,
    kind: 'agent',
    providerId: 'codex',
    executorId: 'codex',
    capabilities: {
      terminal: true, hookEvents: true, timeline: 'streaming', permission: 'observe',
      providerResume: true, acp: false, replyCorrelation: 'none'
    },
    hostId: 'local',
    workspacePath: '/repo',
    label: id,
    createdAt: 1,
    updatedAt: 1,
    processState: 'running',
    status: { state: 'running', source: 'run-process', observedAt: 1 },
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } }
  }
}

function terminal(id: string): Extract<SessionSnapshot, { kind: 'terminal' }> {
  return {
    id,
    kind: 'terminal',
    providerId: null,
    hostId: 'local',
    workspacePath: '/repo',
    label: id,
    createdAt: 1,
    updatedAt: 1,
    processState: 'running',
    status: { state: 'running', source: 'run-process', observedAt: 1 },
    latestOutputBytes: 0,
    control: { kind: 'terminal', hostId: 'local', runId: id, run: { runId: id } }
  }
}

function fixture(extraSessions: SessionSnapshot[] = []): WorkbenchTab {
  const caller = agent('caller')
  const tab = createWorkbenchTab('tab-caller', {
    regionId: 'region-caller',
    kind: 'agent',
    phase: 'attached',
    workspaceId: 'workspace',
    sessionId: caller.id
  })
  useAppStore.setState({
    config,
    sessions: [caller, ...extraSessions],
    activeWorkspaceId: 'workspace',
    mainSurface: 'workbench',
    tabs: { [tab.id]: tab },
    layouts: { workspace: createWorkspaceLayout('group', [tab.id]) },
    pendingAgentLaunches: {},
    executorDetections: {
      [executorDetectionKey('local', 'codex')]: {
        state: 'ready',
        result: { executorId: 'codex', providerId: 'codex', hostId: 'local', installed: true }
      }
    },
    error: null
  })
  return tab
}

function request<T extends AgentMuxControlRequest>(value: Omit<T, 'schemaVersion' | 'requestId'>): T {
  return {
    schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
    requestId: `request-${value.operation}`,
    ...value
  } as T
}

function launch(session: Extract<SessionSnapshot, { kind: 'agent' }>): AgentLaunchResult {
  return { session, timeline: { agentSessionId: session.id, revision: 0, items: [] } }
}

afterEach(() => {
  vi.restoreAllMocks()
  useAppStore.setState(initialState, true)
})

describe('Desktop Control owner', () => {
  it('inspects one Tab with closed Agent, Terminal, Browser, File, and Launcher projections', async () => {
    let tab = fixture([terminal('terminal-run')])
    tab = addWorkbenchRegion(tab, 'region-caller', 'right', {
      regionId: 'region-terminal', kind: 'terminal', phase: 'attached', workspaceId: 'workspace', sessionId: 'terminal-run'
    })
    tab = addWorkbenchRegion(tab, 'region-terminal', 'down', {
      regionId: 'region-browser', kind: 'browser', workspaceId: 'workspace', browserId: 'browser-1',
      id: 'browser-1', url: 'https://example.com', title: 'Example', canGoBack: false, canGoForward: false,
      loading: false, profileId: 'default', viewport: 'responsive', navigationId: 'navigation-1', error: null
    })
    tab = addWorkbenchRegion(tab, 'region-caller', 'down', {
      regionId: 'region-file', kind: 'file', workspaceId: 'workspace', path: '/repo/a.ts'
    })
    tab = addWorkbenchRegion(tab, 'region-file', 'right', {
      regionId: 'region-launcher', kind: 'launcher', workspaceId: 'workspace'
    })
    useAppStore.setState((state) => ({ tabs: { ...state.tabs, [tab.id]: tab } }))

    const result = await useAppStore.getState().executeControl(request({
      operation: 'inspect.tab', target: { kind: 'tab', tabId: tab.id }
    }))

    expect(result.operation).toBe('inspect.tab')
    if (result.operation !== 'inspect.tab') throw new Error('Unexpected result')
    expect(result.tab.regions.map(({ kind }) => kind)).toEqual(['agent', 'file', 'launcher', 'terminal', 'browser'])
    expect(result.tab.regions.find(({ kind }) => kind === 'browser')).not.toHaveProperty('url')
  })

  it('deduplicates Tab Agent Sessions and returns typed ambiguity candidates', async () => {
    let tab = fixture([agent('reviewer')])
    tab = addWorkbenchRegion(tab, 'region-caller', 'right', {
      regionId: 'region-caller-2', kind: 'agent', phase: 'attached', workspaceId: 'workspace', sessionId: 'caller'
    })
    useAppStore.setState((state) => ({ tabs: { ...state.tabs, [tab.id]: tab } }))
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue()
    await useAppStore.getState().executeControl(request({
      operation: 'send', target: { kind: 'tab', tabId: tab.id }, text: 'continue'
    }))
    expect(submit).toHaveBeenCalledOnce()

    tab = addWorkbenchRegion(tab, 'region-caller-2', 'down', {
      regionId: 'region-reviewer', kind: 'agent', phase: 'attached', workspaceId: 'workspace', sessionId: 'reviewer'
    })
    useAppStore.setState((state) => ({ tabs: { ...state.tabs, [tab.id]: tab } }))
    await expect(useAppStore.getState().executeControl(request({
      operation: 'send', target: { kind: 'tab', tabId: tab.id }, text: 'continue'
    }))).rejects.toMatchObject({
      code: 'MESSAGE_TARGET_NOT_UNIQUE',
      candidates: [
        { agentSessionId: 'caller', regionIds: ['region-caller', 'region-caller-2'] },
        { agentSessionId: 'reviewer', regionIds: ['region-reviewer'] }
      ]
    })
  })

  it('opens Agent, Terminal, and Browser through their owners with exact creation payloads', async () => {
    fixture()
    vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async (input) => launch(agent(input.agentSessionId!)))
    const launchTerminal = vi.spyOn(api.sessions, 'launchTerminal').mockResolvedValue(terminal('terminal-created'))
    const createBrowser = vi.spyOn(api.browser, 'create').mockImplementation(async (id, url) => ({
      id, url, title: '', canGoBack: false, canGoForward: false, loading: false, profileId: 'default',
      viewport: 'responsive', navigationId: 'navigation-created', error: null
    }))

    const openedAgent = await useAppStore.getState().executeControl(request({
      operation: 'open.agent',
      content: { kind: 'new-agent', executorId: 'codex', prompt: 'write' },
      destination: { kind: 'split', direction: 'right', region: { kind: 'region', regionId: 'region-caller' } }
    }))
    expect(openedAgent.operation).toBe('open.agent')

    const openedTerminal = await useAppStore.getState().executeControl(request({
      operation: 'open.terminal',
      shellCommand: 'pnpm test:fast',
      destination: { kind: 'split', direction: 'down', region: { kind: 'region', regionId: 'region-caller' } }
    }))
    expect(launchTerminal).toHaveBeenCalledWith(expect.objectContaining({
      createOperationId: 'request-open.terminal', shellCommand: 'pnpm test:fast'
    }))

    const openedBrowser = await useAppStore.getState().executeControl(request({
      operation: 'open.browser',
      url: 'https://example.com',
      destination: { kind: 'new-tab', after: { kind: 'tab', tabId: 'tab-caller' } }
    }))
    expect(openedBrowser.operation).toBe('open.browser')
    if (openedBrowser.operation !== 'open.browser') throw new Error('Unexpected result')
    expect(openedBrowser.region.browserId).not.toBe(openedBrowser.region.regionId)
    expect(createBrowser).toHaveBeenCalledWith(openedBrowser.region.browserId, 'https://example.com')
    expect(openedTerminal.operation).toBe('open.terminal')
  })

  it('rolls back only its planned Region and cleans a Browser created after cancellation', async () => {
    const tab = fixture()
    let release!: (value: Awaited<ReturnType<typeof api.browser.create>>) => void
    let requestedBrowserId = ''
    vi.spyOn(api.browser, 'create').mockImplementation(async (id) => {
      requestedBrowserId = id
      return await new Promise((resolve) => { release = resolve })
    })
    const close = vi.spyOn(api.browser, 'close').mockResolvedValue()
    const controller = new AbortController()
    const pending = useAppStore.getState().executeControl(request({
      operation: 'open.browser',
      url: 'https://example.com',
      destination: { kind: 'split', direction: 'right', region: { kind: 'region', regionId: 'region-caller' } }
    }), controller.signal)
    controller.abort(Object.assign(new Error('timed out'), { code: 'CONTROL_TIMEOUT' }))
    release({
      id: requestedBrowserId, url: 'https://example.com', title: '', canGoBack: false, canGoForward: false,
      loading: false, profileId: 'default', viewport: 'responsive', navigationId: 'nav', error: null
    })

    await expect(pending).rejects.toMatchObject({ code: 'CONTROL_TIMEOUT' })
    expect(close).toHaveBeenCalledWith(requestedBrowserId)
    expect(useAppStore.getState().tabs[tab.id]).toEqual(tab)
  })

  it('creates requested presets atomically and inserts a new Tab immediately after its anchor', async () => {
    const tab = fixture([agent('target')])
    const arranged = await useAppStore.getState().executeControl(request({
      operation: 'arrange', target: { kind: 'tab', tabId: tab.id }, mode: { kind: 'preset', preset: 'grid-4' }
    }))
    expect(arranged.operation).toBe('arrange')
    if (arranged.operation !== 'arrange') throw new Error('Unexpected result')
    expect(arranged.tab.regions).toHaveLength(4)

    const opened = await useAppStore.getState().executeControl(request({
      operation: 'open.agent',
      content: { kind: 'agent-session', agentSessionId: 'target' },
      destination: { kind: 'new-tab', after: { kind: 'tab', tabId: tab.id } }
    }))
    expect(opened.operation).toBe('open.agent')
    if (opened.operation !== 'open.agent') throw new Error('Unexpected result')
    expect(useAppStore.getState().layouts.workspace?.groups[0]?.tabOrder.slice(0, 2)).toEqual([tab.id, opened.region.tabId])
  })
})
