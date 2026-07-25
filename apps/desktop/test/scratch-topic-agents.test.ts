import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import type { AgentLaunchResult, AppConfig, SessionSnapshot, WorkspaceRecord } from '../src/shared/contracts.js'
import { api } from '../src/renderer/src/lib/api.js'
import { createWorkspaceLayout } from '../src/renderer/src/lib/workbench-layout.js'
import {
  createWorkbenchTab,
  initialWorkbenchRegionId,
  type WorkbenchTab
} from '../src/renderer/src/lib/workbench-tabs.js'
import { topicsWithAgents } from '../src/renderer/src/lib/surface-tool-dock.js'
import { useAppStore } from '../src/renderer/src/store.js'
import {
  SCRATCH_WORKSPACE_ID,
  scratchTopicDirectoryName,
  type ScratchTopicSnapshot
} from '../src/shared/scratch-topics.js'

const initialState = useAppStore.getState()

const scratchWorkspace: WorkspaceRecord = {
  id: SCRATCH_WORKSPACE_ID,
  name: 'Scratch',
  hostId: 'local',
  path: '/scratch',
  kind: 'folder'
}

const config: AppConfig = {
  version: 7,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {
    codex: { label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true }
  },
  workspaces: [scratchWorkspace],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true } }
}

function topicWorkspacePath(topicId: string): string {
  return `${scratchWorkspace.path}/${scratchTopicDirectoryName(topicId)}`
}

function agent(
  id: string,
  overrides: Partial<Extract<SessionSnapshot, { kind: 'agent' }>> = {}
): Extract<SessionSnapshot, { kind: 'agent' }> {
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
    workspacePath: scratchWorkspace.path,
    label: id,
    createdAt: 1,
    updatedAt: 1,
    processState: 'running',
    status: { state: 'running', source: 'run-process', observedAt: 1 },
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } },
    ...overrides
  }
}

function launch(session: Extract<SessionSnapshot, { kind: 'agent' }>): AgentLaunchResult {
  return { session, timeline: { agentSessionId: session.id, revision: 0, items: [] } }
}

function scratchTopicTab(tabId: string, topicId?: string): WorkbenchTab {
  const tab = createWorkbenchTab(tabId, {
    regionId: initialWorkbenchRegionId(tabId),
    kind: 'launcher',
    workspaceId: scratchWorkspace.id
  })
  return topicId ? { ...tab, topicId } : tab
}

function mountScratch(tabs: WorkbenchTab[]): void {
  useAppStore.setState({
    config,
    sessions: [],
    timelines: {},
    activeWorkspaceId: scratchWorkspace.id,
    mainSurface: 'workbench',
    tabs: Object.fromEntries(tabs.map((tab) => [tab.id, tab])),
    layouts: { [scratchWorkspace.id]: createWorkspaceLayout('group', tabs.map((tab) => tab.id)) },
    closingWorkbenchViews: {},
    workspaceFileRevisions: {},
    pendingAgentLaunches: {},
    error: null
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  useAppStore.setState(initialState, true)
})

// ---------------------------------------------------------------------------
// T-001 — the target Topic is carried explicitly by the View binding; a Tab id
// is never promoted into a Topic. Because a Tab id like `launcher:<uuid>` or
// `view:<uuid>` structurally satisfies the Scratch Topic-id grammar, the earlier
// `topicId ?? tabId` bug silently minted a fresh Topic per launch. These tests
// go red the moment that derivation returns.
// ---------------------------------------------------------------------------
describe('T-001 explicit Topic on Agent launch', () => {
  it('carries the View-bound Topic so multiple Agents land in one Topic', async () => {
    const bound = scratchTopicTab('launcher:one', 'view:shared')
    const alsoBound = scratchTopicTab('launcher:two', 'view:shared')
    mountScratch([bound, alsoBound])
    const launchAgent = vi.spyOn(api.sessions, 'launchAgent')
      .mockImplementation(async (input) => launch(agent(input.agentSessionId!, {
        workspacePath: topicWorkspacePath('view:shared')
      })))

    await useAppStore.getState().launchAgent('codex', 'first', 'group', {
      tabId: bound.id, regionId: bound.layout.activeRegionId
    })
    await useAppStore.getState().launchAgent('codex', 'second', 'group', {
      tabId: alsoBound.id, regionId: alsoBound.layout.activeRegionId
    })

    expect(launchAgent).toHaveBeenCalledTimes(2)
    expect(launchAgent.mock.calls.every(([input]) => input.scratchTopicId === 'view:shared')).toBe(true)
  })

  it('launches an unbound View with no Topic instead of inventing one from the Tab id', async () => {
    // `launcher:unbound` is a valid Topic-id shape, so `?? tabId` would mint it.
    const unbound = scratchTopicTab('launcher:unbound')
    mountScratch([unbound])
    const launchAgent = vi.spyOn(api.sessions, 'launchAgent')
      .mockImplementation(async (input) => launch(agent(input.agentSessionId!)))

    await useAppStore.getState().launchAgent('codex', 'solo', 'group', {
      tabId: unbound.id, regionId: unbound.layout.activeRegionId
    })

    expect(launchAgent).toHaveBeenCalledTimes(1)
    const [input] = launchAgent.mock.calls[0]!
    expect(input.scratchTopicId).toBeUndefined()
    expect(useAppStore.getState().tabs[unbound.id]?.topicId).toBeUndefined()
  })

  it('opens a new-agent Control into a fresh Tab with no Topic, minting none from the Tab', async () => {
    mountScratch([scratchTopicTab('launcher:anchor')])
    const launchAgent = vi.spyOn(api.sessions, 'launchAgent')
      .mockImplementation(async (input) => launch(agent(input.agentSessionId!)))

    await useAppStore.getState().executeControl({
      schemaVersion: 1,
      requestId: 'request-open-agent',
      operation: 'open.agent',
      content: { kind: 'new-agent', executorId: 'codex', prompt: 'write' },
      destination: { kind: 'new-tab', after: { kind: 'tab', tabId: 'launcher:anchor' } }
    })

    expect(launchAgent).toHaveBeenCalledTimes(1)
    const [input] = launchAgent.mock.calls[0]!
    expect(input.scratchTopicId).toBeUndefined()
    const created = Object.values(useAppStore.getState().tabs).find((tab) => tab.id !== 'launcher:anchor')
    expect(created?.topicId).toBeUndefined()
  })

  it('fails closed on an invalid bound Topic instead of degrading to no Topic', async () => {
    const corrupt = { ...scratchTopicTab('launcher:corrupt'), topicId: 'not a topic id' }
    mountScratch([corrupt])
    const launchAgent = vi.spyOn(api.sessions, 'launchAgent')
      .mockImplementation(async (input) => launch(agent(input.agentSessionId!)))

    await expect(useAppStore.getState().launchAgent('codex', 'x', 'group', {
      tabId: corrupt.id, regionId: corrupt.layout.activeRegionId
    })).rejects.toThrow(/invalid Topic/i)
    expect(launchAgent).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// T-002 — the Topic panel projects each filesystem Topic's Agents as the union
// of on-disk collaborators and live Session projections. The Topic list is the
// filesystem snapshot; Sessions are matched onto it, never used to invent a
// Topic. Zero-Agent Topics stay listed and empty.
// ---------------------------------------------------------------------------
function topic(id: string, collaborators: ScratchTopicSnapshot['collaborators'] = []): ScratchTopicSnapshot {
  const directoryPath = scratchTopicDirectoryName(id)
  return {
    id,
    directoryPath,
    topicPath: `${directoryPath}/topic.md`,
    title: id,
    summary: '',
    collaborators
  }
}

describe('T-002 Topic panel projects each Topic’s Agents from the filesystem', () => {
  it('unions on-disk collaborators with live Sessions and keeps empty Topics visible', () => {
    const topics: ScratchTopicSnapshot[] = [
      topic('view:shared', [
        { fileName: 'codex.persisted.identity.md', providerId: 'codex', sessionId: 'persisted' }
      ]),
      topic('view:empty')
    ]
    const sessions: SessionSnapshot[] = [
      // Same session id as the collaborator: must dedupe into one live entry.
      agent('persisted', { workspacePath: topicWorkspacePath('view:shared') }),
      // A live Agent in the same Topic with no identity file yet: additive.
      agent('fresh', { workspacePath: topicWorkspacePath('view:shared') })
    ]

    const projected = topicsWithAgents(topics, sessions, scratchWorkspace)

    const shared = projected.find((entry) => entry.id === 'view:shared')!
    expect(shared.agents.map((agentEntry) => agentEntry.sessionId).sort()).toEqual(['fresh', 'persisted'])
    expect(shared.agents.find((agentEntry) => agentEntry.sessionId === 'persisted')?.live?.id).toBe('persisted')
    expect(shared.agents.find((agentEntry) => agentEntry.sessionId === 'fresh')?.live?.id).toBe('fresh')

    const empty = projected.find((entry) => entry.id === 'view:empty')!
    expect(empty.agents).toEqual([])
  })

  it('does not reverse-derive Topics from Sessions', () => {
    const topics = [topic('view:listed')]
    const sessions: SessionSnapshot[] = [
      // A live Agent whose cwd is a Topic directory that the filesystem snapshot does not list.
      agent('ghost', { workspacePath: topicWorkspacePath('view:unlisted') }),
      // A live Agent that is not inside any Topic directory at all.
      agent('root', { workspacePath: scratchWorkspace.path })
    ]

    const projected = topicsWithAgents(topics, sessions, scratchWorkspace)

    expect(projected.map((entry) => entry.id)).toEqual(['view:listed'])
    expect(projected[0]!.agents).toEqual([])
  })

  it('reuses the existing openScratchTopic navigation action rather than a second path', () => {
    const source = readFileSync(
      new URL('../src/renderer/src/components/SurfaceToolDock.tsx', import.meta.url),
      'utf8'
    )
    expect(source).toContain('await openScratchTopic(nextTopicId)')
    expect(source).toContain('topicsWithAgents(topics, sessions, workspace)')
  })
})

// ---------------------------------------------------------------------------
// openScratchTopic reuses one navigation path: it focuses the bound View when
// one is open, and only otherwise recreates a Launcher bound to the Topic.
// ---------------------------------------------------------------------------
describe('T-002 switching reuses the bound View', () => {
  it('focuses the View already bound to a Topic instead of opening a second one', async () => {
    const bound = scratchTopicTab('launcher:bound', 'view:shared')
    const other = scratchTopicTab('launcher:other', 'view:other')
    mountScratch([other, bound])
    vi.spyOn(api.scratch, 'readTopic').mockResolvedValue(topic('view:shared'))

    await useAppStore.getState().openScratchTopic('view:shared')

    const state = useAppStore.getState()
    const layout = state.layouts[scratchWorkspace.id]!
    expect(layout.groups[0]!.activeTabId).toBe('launcher:bound')
    // No third Tab created: the bound View was focused, not duplicated.
    expect(Object.keys(state.tabs).sort()).toEqual(['launcher:bound', 'launcher:other'])
  })
})
