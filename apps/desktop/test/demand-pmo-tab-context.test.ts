import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})
import type { AppConfig } from '../src/shared/contracts.js'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics.js'
import { api } from '../src/renderer/src/lib/api.js'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'
import { useAppStore } from '../src/renderer/src/store.js'

const initialState = useAppStore.getState()
let dispose: (() => void) | undefined
beforeAll(async () => { dispose = await useAppStore.getState().initialize() })
afterAll(() => dispose?.())
const scratchWorkspace = { id: SCRATCH_WORKSPACE_ID, name: 'Scratch', hostId: 'local', path: '/scratch', kind: 'scratch' as const }
const config = {
  version: 9,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: { codex: { label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true } },
  workspaces: [scratchWorkspace],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
} as unknown as AppConfig

const demand = {
  id: 'demand:one', title: 'One demand', description: 'Clarify one outcome', status: 'backlog' as const, priority: 'normal' as const,
  projectId: null, projectName: null, sessionIds: [], createdAt: 1, updatedAt: 1, source: 'default-topic' as const
}

afterEach(() => {
  vi.restoreAllMocks()
  useAppStore.setState(initialState, true)
})

describe('Demand dedicated PMO Tab context', () => {
  it('creates a unique PMO Tab, persists its binding, and launches a fresh context', async () => {
    vi.spyOn(api.scratch, 'ensureTopic').mockResolvedValue({ id: PMO_TEAMS_TOPIC_ID } as never)
    const launchAgent = vi.fn().mockResolvedValue(undefined)
    const secondDemand = { ...demand, id: 'demand:two', title: 'Two demand' }
    useAppStore.setState({
      config,
      demands: { [demand.id]: demand, [secondDemand.id]: secondDemand },
      demandPmoTabIds: {},
      tabs: {},
      layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('scratch-group') },
      launchAgent: launchAgent as never
    })

    const tabId = await useAppStore.getState().requestDemandPmoTask(demand.id, 'grill')
    const secondTabId = await useAppStore.getState().requestDemandPmoTask(secondDemand.id, 'grounding')
    const state = useAppStore.getState()
    const tab = state.tabs[tabId]
    expect(secondTabId).not.toBe(tabId)
    expect(tab?.topicId).toBe(PMO_TEAMS_TOPIC_ID)
    expect(state.tabs[secondTabId]?.topicId).toBe(PMO_TEAMS_TOPIC_ID)
    expect(state.layouts[SCRATCH_WORKSPACE_ID]?.groups[0]?.tabOrder).toContain(tabId)
    expect(state.layouts[SCRATCH_WORKSPACE_ID]?.groups[0]?.tabOrder).toContain(secondTabId)
    expect(state.demandPmoTabIds[demand.id]).toBe(tabId)
    expect(state.demandPmoTabIds[secondDemand.id]).toBe(secondTabId)
    expect(launchAgent).toHaveBeenCalledWith('codex', expect.stringContaining('Grill:'), 'scratch-group', expect.objectContaining({ tabId, regionId: tab?.layout.activeRegionId }), undefined, { tabName: 'PMO · One demand' })
    expect(launchAgent).toHaveBeenCalledWith('codex', expect.stringContaining('Grounding:'), 'scratch-group', expect.objectContaining({ tabId: secondTabId, regionId: state.tabs[secondTabId]?.layout.activeRegionId }), undefined, { tabName: 'PMO · Two demand' })
    expect(launchAgent.mock.calls[0]?.[1]).toContain('Read-only execution Agent context')
  })

  it('reopens only the mapped PMO Tab and does not create another context', async () => {
    const tab = { ...createWorkbenchTab('pmo-tab-one', { regionId: 'region-one', kind: 'agent', phase: 'attached', workspaceId: SCRATCH_WORKSPACE_ID, sessionId: 'session-one' }, 'PMO · One demand'), topicId: PMO_TEAMS_TOPIC_ID }
    const openScratchTopic = vi.fn().mockResolvedValue(undefined)
    const launchAgent = vi.fn().mockResolvedValue(undefined)
    useAppStore.setState({
      config,
      demands: { [demand.id]: demand },
      demandPmoTabIds: { [demand.id]: tab.id },
      tabs: { [tab.id]: tab },
      layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('scratch-group', [tab.id]) },
      openScratchTopic: openScratchTopic as never,
      launchAgent: launchAgent as never
    })

    await expect(useAppStore.getState().openDemandPmo(demand.id)).resolves.toBe(tab.id)
    expect(openScratchTopic).toHaveBeenCalledWith(PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, { reveal: false, tabId: tab.id })
    expect(launchAgent).not.toHaveBeenCalled()
    expect(Object.keys(useAppStore.getState().tabs)).toEqual([tab.id])
  })

  it('delivers a new Grill or Grounding task to the mapped Agent through retained userIntent admission', async () => {
    const tab = { ...createWorkbenchTab('pmo-tab-one', { regionId: 'region-one', kind: 'agent', phase: 'attached', workspaceId: SCRATCH_WORKSPACE_ID, sessionId: 'session-one' }, 'PMO'), topicId: PMO_TEAMS_TOPIC_ID }
    const send = vi.fn().mockReturnValue(true)
    const launchAgent = vi.fn()
    useAppStore.setState({ config, demands: { [demand.id]: demand }, demandPmoTabIds: { [demand.id]: tab.id }, tabs: { [tab.id]: tab }, layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('scratch-group', [tab.id]) }, openScratchTopic: vi.fn().mockResolvedValue(undefined) as never, send: send as never, launchAgent: launchAgent as never })
    await expect(useAppStore.getState().requestDemandPmoTask(demand.id, 'grill')).resolves.toBe(tab.id)
    await expect(useAppStore.getState().requestDemandPmoTask(demand.id, 'grounding')).resolves.toBe(tab.id)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[0]).toEqual(['session-one', expect.stringContaining('Grill:')])
    expect(send.mock.calls[1]).toEqual(['session-one', expect.stringContaining('Grounding:')])
    expect(send.mock.calls[1]![1]).toContain('Clarify one outcome')
    expect(launchAgent).not.toHaveBeenCalled()
    expect(Object.keys(useAppStore.getState().tabs)).toEqual([tab.id])
    send.mockReturnValue(false)
    await expect(useAppStore.getState().requestDemandPmoTask(demand.id, 'grill')).rejects.toThrow(/not queued/u)
    expect(useAppStore.getState().demands[demand.id]).toEqual(demand)
    expect(useAppStore.getState().tabs[tab.id]).toEqual(tab)
  })

  it('retains a real queued Mote task on a healthy busy Run and sends it on retry', async () => {
    const session = { id: 'session-one', kind: 'agent', control: { kind: 'agent', hostId: 'local', agentSessionId: 'session-one', run: { runId: 'healthy-run' } }, status: { state: 'working', observedAt: 1 }, processState: 'running', promptSubmissionPredecessor: null }
    const quotedDemand = { ...demand, id: "goal's-id", alignment: { revision: 1, summary: 'User goal', criteria: [{ id: "criterion's-id", text: 'Current criterion' }], openQuestions: [], confirmedAt: 1 } }
    const tab = { ...createWorkbenchTab('pmo-tab-one', { regionId: 'region-one', kind: 'agent', phase: 'attached', workspaceId: SCRATCH_WORKSPACE_ID, sessionId: session.id }, 'PMO'), topicId: PMO_TEAMS_TOPIC_ID }
    vi.spyOn(api.sessions, 'refresh').mockResolvedValue(session as never)
    vi.spyOn(api.continuousProgress, 'pauseForInput').mockResolvedValue(undefined)
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockRejectedValue(new Error('Readiness not yet observed'))
    const launch = vi.fn()
    useAppStore.setState({ config, sessions: [session as never], demands: { [quotedDemand.id]: quotedDemand }, demandPmoTabIds: { [quotedDemand.id]: tab.id }, tabs: { [tab.id]: tab }, layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('scratch-group', [tab.id]) }, openScratchTopic: vi.fn().mockResolvedValue(undefined) as never, launchAgent: launch as never })
    await expect(useAppStore.getState().requestDemandPmoTask(quotedDemand.id, 'grounding')).resolves.toBe(tab.id)
    await vi.waitFor(() => { expect(useAppStore.getState().agentSteerQueues[session.id]?.[0]).toMatchObject({ runId: 'healthy-run', status: 'deferred', error: 'Readiness not yet observed' }) })
    const retained = useAppStore.getState().agentSteerQueues[session.id]![0]!
    expect(retained.text).toContain("--demand 'goal'\"'\"'s-id'")
    expect(retained.text).toContain("criterion'\"'\"'s-id")
    expect(submit).toHaveBeenCalledWith(session.control, retained.text, retained.operationId, expect.objectContaining({ expectedRun: { runId: 'healthy-run' } }), undefined, { allowUncertainTurn: true })
    expect(useAppStore.getState().sessions).toEqual([session])
    expect(launch).not.toHaveBeenCalled()
    submit.mockResolvedValue(undefined)
    await useAppStore.getState().flushAgentSteerQueue(session.id)
    expect(useAppStore.getState().agentSteerQueues[session.id]).toBeUndefined()
    expect(submit.mock.calls.at(-1)?.[2]).toBe(retained.operationId)
    expect(Object.keys(useAppStore.getState().tabs)).toEqual([tab.id])
  })

  it('focuses the requested PMO Tab even when another Demand owns the first Tab', async () => {
    const firstTab = { ...createWorkbenchTab('pmo-tab-one', { regionId: 'region-one', kind: 'agent', phase: 'attached', workspaceId: SCRATCH_WORKSPACE_ID, sessionId: 'session-one' }, 'PMO · One demand'), topicId: PMO_TEAMS_TOPIC_ID }
    const secondTab = { ...createWorkbenchTab('pmo-tab-two', { regionId: 'region-two', kind: 'agent', phase: 'attached', workspaceId: SCRATCH_WORKSPACE_ID, sessionId: 'session-two' }, 'PMO · Two demand'), topicId: PMO_TEAMS_TOPIC_ID }
    vi.spyOn(api.scratch, 'readTopic').mockResolvedValue({ id: PMO_TEAMS_TOPIC_ID } as never)
    useAppStore.setState({
      config,
      tabs: { [firstTab.id]: firstTab, [secondTab.id]: secondTab },
      layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('scratch-group', [firstTab.id, secondTab.id]) }
    })

    await useAppStore.getState().openScratchTopic(PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, { reveal: true, tabId: secondTab.id })
    expect(useAppStore.getState().layouts[SCRATCH_WORKSPACE_ID]?.groups[0]?.activeTabId).toBe(secondTab.id)
    await expect(useAppStore.getState().openScratchTopic(PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, { reveal: false, tabId: 'missing-tab' })).rejects.toThrow()
    expect(useAppStore.getState().layouts[SCRATCH_WORKSPACE_ID]?.groups[0]?.activeTabId).toBe(secondTab.id)
  })

  it('persists the editor-owned Demand-to-Tab binding beside the Workbench projection', () => {
    useAppStore.setState({ demandPmoTabIds: { [demand.id]: 'pmo-tab-one' } })
    const partialize = useAppStore.persist.getOptions().partialize
    expect(partialize).toBeTypeOf('function')
    expect(partialize!(useAppStore.getState())).toMatchObject({ demandPmoTabIds: { [demand.id]: 'pmo-tab-one' } })
  })
})

it('keeps the Demand-to-PMO mapping in renderer persistence and exposes both PMO entry points', async () => {
  const source = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('../src/renderer/src/store.ts', import.meta.url), 'utf8'))
  const board = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('../src/renderer/src/components/GlobalBoardSurface.tsx', import.meta.url), 'utf8'))
  expect(source.length).toBeGreaterThan(0)
  expect(board.length).toBeGreaterThan(0)
  expect(source).toContain('demandPmoTabIds: state.demandPmoTabIds')
  expect(source).toContain('requestDemandPmoTask(demandId, mode)')
  expect(board).toContain('onOpenMote=')
  expect(board).toContain("await openDemandPmo(demandId)")
})
