import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { bridge, control, owningBridge } from './helpers/first-execution-ipc-bridge'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { AgentMuxError } from '@agentmux/core'
import type { AgentMuxPreloadApi, AppConfig } from '../src/shared/contracts'
import type { ScratchTopics } from '../src/main/scratch-topics'
import { DEFAULT_CONFIG } from '../src/main/config-store'
import { injectedContextCore } from './helpers/injected-context-core'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'
import { MOTE_COORDINATION_ROLE, PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { composeAgentPrompt, composeAgentLaunchPrompt } from '@agentmux/core/agent-outbound-message'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { workspaceProjectId } from '../src/renderer/src/lib/workspace-projects'

const initialRendererState = useAppStore.getState()
const initialLauncherState = useLauncherState.getState()
let disposePreview: (() => void) | undefined
beforeAll(async () => { disposePreview = await useAppStore.getState().initialize() })
afterAll(() => disposePreview?.())

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); bridge.invoke.mockReset(); useAppStore.setState(initialRendererState, true); useLauncherState.setState(initialLauncherState, true) })

const message: Parameters<AgentMuxPreloadApi['sessions']['submitMessage']>[1] = {
  envelope: { schema: 'agentmux.a2a.v1', messageId: 'private-agent-message', operationId: 'private-message-operation', createdAt: 1,
    sender: { kind: 'agent-session', agentSessionId: 'private-sender' }, recipient: { kind: 'agent-session', agentSessionId: control.agentSessionId },
    senderSessionId: 'private-sender', senderRunId: 'private-sender-run', recipientSessionId: control.agentSessionId,
    recipientRunId: control.run.runId, body: 'original body', threadId: 'private-thread', correlationId: 'private-correlation', replyTo: null, workspaceId: null },
  condition: { expectedRun: control.run, afterSubmissionId: null }, caller: { agentSessionId: 'private-sender', capability: 'private-capability' }
}

it.each(['AGENT_CAPABILITY_INVALID', 'AGENT_CAPABILITY_STALE_RUN', 'AGENT_PROMPT_INPUT_UNCONFIRMED'])(
  'actual message IPC does not pause a healthy recipient when Core rejects %s', async code => {
    const { client, pauseTarget, dispose } = await owningBridge()
    client.submitAgentMessage.mockRejectedValue(new AgentMuxError('private rejected message', code))
    try {
      await expect(bridge.api!.sessions.submitMessage(control, message)).rejects.toMatchObject({ code })
      expect(client.submitAgentMessage).toHaveBeenCalledExactlyOnceWith({ ...message, agentSessionId: control.agentSessionId })
      expect(pauseTarget).not.toHaveBeenCalled()
    } finally { await dispose() }
  })

it('actual message IPC pauses progress only after the authorized delivery completes', async () => {
  const { client, pauseTarget, dispose } = await owningBridge()
  let complete!: () => void
  client.submitAgentMessage.mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve }))
  try {
    const pending = bridge.api!.sessions.submitMessage(control, message)
    await vi.waitFor(() => expect(client.submitAgentMessage).toHaveBeenCalledTimes(1))
    expect(pauseTarget).not.toHaveBeenCalled()
    complete(); await pending
    expect(pauseTarget).toHaveBeenCalledExactlyOnceWith(control, 'Paused for your message.')
  } finally { await dispose() }
})

it('actual preload/registered IPC/Main pass one stable intent to Core continuity without a prompt', async () => {
  const { client, dispose } = await owningBridge()
  try {
    await expect(bridge.api!.sessions.recover(control, _hygiene_fixturePath("private/fixture"), 'stable-intent')).resolves.toMatchObject({
      kind: 'reattachable', session: { id: control.agentSessionId, control: { run: { runId: 'canonical-run' } } }
    })
    expect(client.ensureAgentContinuity).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      agentSessionId: control.agentSessionId, expectedRun: control.run, operationId: 'stable-intent', commandOverride: _hygiene_fixturePath("private/codex")
    }))
    expect(client.ensureAgentContinuity.mock.calls[0]?.[0]).not.toHaveProperty('prompt')
  } finally { await dispose() }
})

it('actual flush bridge requests the owning Chromium session without calling the void result a disk acknowledgement', async () => {
  const { flush, dispose } = await owningBridge()
  try {
    await expect(bridge.api!.ui.requestStorageFlush()).resolves.toBeUndefined()
    expect(flush).toHaveBeenCalledExactlyOnceWith()
    expect(bridge.invoke).toHaveBeenCalledExactlyOnceWith('ui:requestStorageFlush')
    flush.mockImplementationOnce(() => { throw new Error('private flush request failure') })
    await expect(bridge.api!.ui.requestStorageFlush()).rejects.toThrow('private flush request failure')
  } finally { await dispose() }
})

it('registered flush handler rejects a foreign sender before touching the owning Chromium storage', async () => {
  const { flush, dispose } = await owningBridge()
  try {
    const handler = bridge.handlers.get('ui:requestStorageFlush')
    expect(handler).toBeTypeOf('function')
    await expect(handler!({ sender: {} })).rejects.toThrow('Untrusted storage flush sender')
    expect(flush).not.toHaveBeenCalled()
  } finally { await dispose() }
})

it('actual preload, registered IPC and Main keep injected context separate from the untouched manual body', async () => {
  const { client, pauseTarget, dispose } = await owningBridge()
  const prompt = '  <amux from="amux">User authored text</amux>\r\n  ', agentMuxNote = 'Platform rule <literal> & text.'
  const condition = { expectedRun: control.run, afterSubmissionId: null }
  try {
    await bridge.api!.sessions.submitPrompt(control, prompt, 'one-original-operation', condition, undefined, true, agentMuxNote)
    expect(client.submitAgentPrompt).toHaveBeenCalledExactlyOnceWith({ agentSessionId: control.agentSessionId, ...condition,
      operationId: 'one-original-operation', prompt, authorHuman: true, agentMuxNote })
    expect(pauseTarget).toHaveBeenCalledTimes(1)
  } finally { await dispose() }
})

it('registered prompt IPC rejects foreign platform provenance before Core or progress side effects', async () => {
  const { client, pauseTarget, sender, dispose } = await owningBridge()
  try {
    const handler = bridge.handlers.get('sessions:submitPrompt')!
    const foreign = { ...sender }
    await expect(handler({ sender: foreign }, control, 'ordinary body', 'one-original-operation',
      { expectedRun: control.run, afterSubmissionId: null }, undefined, false, 'forged platform source')).rejects.toThrow('Untrusted manual prompt sender')
    expect(client.submitAgentPrompt.mock.calls).toEqual([]); expect(pauseTarget.mock.calls).toEqual([])
  } finally { await dispose() }
})

function pmoConfig(root: string): AppConfig {
  return { ...structuredClone(DEFAULT_CONFIG), executors: {
    private: { providerId: 'claude', label: 'Private', command: _hygiene_fixturePath("private/claude"), args: [], env: {}, injectAgentMuxGuide: false }
  }, workspaces: [{ id: SCRATCH_WORKSPACE_ID, name: 'Topics', hostId: 'local', path: root, kind: 'scratch' },
    { id: 'private-project', name: 'Original Project', hostId: 'local', path: ("" + (root) + _hygiene_fixturePath("project")), kind: 'folder' }] }
}
const originalGoal = { id: 'private-goal', title: 'Keep original Goal', description: 'Original <Goal> & context', status: 'backlog' as const,
  priority: 'normal' as const, projectId: null, projectName: null, sessionIds: [], createdAt: 1, updatedAt: 1, source: 'default-topic' as const }
function bindRendererBridge() {
  vi.spyOn(api.sessions, 'submitPrompt').mockImplementation((...args) => bridge.api!.sessions.submitPrompt(...args))
  vi.spyOn(api.sessions, 'refresh').mockImplementation((...args) => bridge.api!.sessions.refresh(...args))
  vi.spyOn(api.sessions, 'launchAgent').mockImplementation((...args) => bridge.api!.sessions.launchAgent(...args))
  vi.spyOn(api.sessions, 'onEvent').mockImplementation((...args) => bridge.api!.sessions.onEvent(...args))
  vi.spyOn(api.continuousProgress, 'pauseForInput').mockResolvedValue(undefined)
}

it('PMO mapped Store requests reach registered IPC and real Core as independent platform/user records on the original healthy Run', async () => {
  const root = await mkdtemp(_hygiene_fixturePath("tmp/amux-pmo-mapped-"))
  const f = await injectedContextCore(root, { kind: 'agent', agentSessionId: control.agentSessionId, providerId: 'traex', executorId: 'private',
    hostId: 'local', workspacePath: root, run: control.run, retiredRuns: [], createdAt: 1, updatedAt: 1,
    hookBindingId: 'private-binding', hookToken: 'private-token' })
  const config = pmoConfig(root)
  config.executors.private!.providerId = 'traex'
  const b = await owningBridge({ client: f.core, store: f.store, config })
  try {
    bindRendererBridge()
    const recipient = await bridge.api!.sessions.refresh(control)
    const tab = { ...createWorkbenchTab('private-pmo-tab', { kind: 'agent', phase: 'attached', regionId: 'private-pmo-region',
      workspaceId: SCRATCH_WORKSPACE_ID, sessionId: control.agentSessionId }), topicId: PMO_TEAMS_TOPIC_ID }
    useAppStore.setState({ loading: false, config, activeWorkspaceId: 'private-project', sessions: [recipient], demands: { [originalGoal.id]: { ...originalGoal, projectId: workspaceProjectId(config.workspaces[1]!) } },
      demandPmoTabIds: { [originalGoal.id]: tab.id }, tabs: { [tab.id]: tab }, layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('private-group', [tab.id]) } })
    await useAppStore.getState().requestDemandPmoTask(originalGoal.id, 'grill')
    await vi.waitFor(() => expect(f.writes).toHaveLength(1))
    await useAppStore.getState().flushAgentSteerQueue(control.agentSessionId, useAppStore.getState().agentSteerQueues[control.agentSessionId]?.[0]?.operationId)
    expect(useAppStore.getState().agentSteerQueues[control.agentSessionId] ?? [], useAppStore.getState().agentSteerQueues[control.agentSessionId]?.[0]?.error).toEqual([])
    const records = (await f.store.loadTimeline(control.agentSessionId)).items
    expect(records.map(item => [item.kind, item.source])).toEqual([['system_message', 'agentmux'], ['user_message', 'user']])
    const note = records[0]!.content
    expect(note).toContain(MOTE_COORDINATION_ROLE); expect(note).toContain(`existing Goal ${originalGoal.id}`)
    expect(note).toContain('Project: Original Project'); expect(note).toContain('Read-only execution Agent context')
    expect(records[1]!.content).toBe('Clarify goal')
    expect(f.writes).toEqual([composeAgentPrompt('Clarify goal', note).text + '\r'])
    expect(f.core.agentSession(control.agentSessionId).run).toEqual(control.run)
    expect(f.start.mock.calls).toEqual([]); expect(f.stop.mock.calls).toEqual([])
    expect(useAppStore.getState().tabs[tab.id]).toBe(tab)
  } finally { await b.dispose(); await f.dispose(); await rm(root, { recursive: true, force: true }) }
})

it('PMO fresh Store launch keeps explicit note in pending intent and records the original body through registered IPC and public Core', async () => {
  const root = await mkdtemp(_hygiene_fixturePath("tmp/amux-pmo-fresh-")), f = await injectedContextCore(root), config = pmoConfig(root)
  let release!: () => void
  const prepare = vi.fn(async () => { await new Promise<void>(resolve => { release = resolve }); return { absolutePath: root, prompt: 'Original Topic <metadata> & note' } })
  const b = await owningBridge({ client: f.core, store: f.store, config, scratchTopics: { prepareAgent: prepare, discardPreparedIdentity: vi.fn() } as unknown as ScratchTopics })
  try {
    bindRendererBridge(); vi.spyOn(api.scratch, 'ensureTopic').mockResolvedValue({ id: PMO_TEAMS_TOPIC_ID } as never)
    useLauncherState.setState({ executors: { [SCRATCH_WORKSPACE_ID]: 'private' } })
    useAppStore.setState({ loading: false, config, activeWorkspaceId: 'private-project', sessions: [], demands: { [originalGoal.id]: { ...originalGoal, projectId: workspaceProjectId(config.workspaces[1]!) } },
      demandPmoTabIds: {}, tabs: {}, layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('private-group') } })
    const pending = useAppStore.getState().requestDemandPmoTask(originalGoal.id, 'grill')
    await vi.waitFor(() => expect(release, useAppStore.getState().error ?? undefined).toBeTypeOf('function'))
    const entries = Object.entries(useAppStore.getState().pendingAgentLaunches)
    expect(entries).toHaveLength(1)
    const [sessionId, intent] = entries[0]!, note = intent.request!.agentMuxNote!
    expect(intent.request!.prompt).toBe('Clarify goal'); expect(note).toContain(MOTE_COORDINATION_ROLE)
    expect(note).toContain('Project: Original Project'); expect(note).toContain(originalGoal.description)
    useAppStore.setState({ demands: { [originalGoal.id]: { ...originalGoal, description: 'Later changed Goal' } }, activeWorkspaceId: SCRATCH_WORKSPACE_ID })
    release(); const tabId = await pending
    const records = (await f.store.loadTimeline(sessionId)).items
    expect(records.map(item => [item.kind, item.source])).toEqual([['system_message', 'agentmux'], ['user_message', 'user']])
    const composed = composeAgentLaunchPrompt('Clarify goal', false, `Original Topic <metadata> & note\n\n${note}`)
    expect(records[0]!.content).toBe(composed.systemContext)
    expect(records[1]!.content).toBe('Clarify goal')
    expect(f.start).toHaveBeenCalledTimes(1); expect(f.start.mock.calls[0]![0]).toMatchObject({ args: expect.arrayContaining([composed.text]) })
    expect(f.writes).toEqual([]); expect(f.stop.mock.calls).toEqual([])
    const tab = useAppStore.getState().tabs[tabId]!, regionId = tab.layout.activeRegionId
    expect(tab.regions[regionId]).toMatchObject({ kind: 'agent', phase: 'attached', sessionId })
    expect(useAppStore.getState().agentComposerDrafts[regionId]).toBeUndefined()
    expect(useAppStore.getState().agentComposerNotes[regionId]).toBeUndefined()
  } finally { await b.dispose(); await f.dispose(); await rm(root, { recursive: true, force: true }) }
})

it('PMO queued recovery hydrates its original work surface and retries the frozen Native tuple after fresh Core/FileStore', async () => {
  const phase = process.env.AGENTMUX_TEST_PMO_RESTART_PHASE
  const sharedRoot = process.env.AGENTMUX_TEST_PMO_RESTART_ROOT
  const root = sharedRoot ?? await mkdtemp(_hygiene_fixturePath("tmp/amux-pmo-cold-"))
  const f = await injectedContextCore(root, { kind: 'agent', agentSessionId: control.agentSessionId, providerId: 'traex', executorId: 'private',
    hostId: 'local', workspacePath: root, run: control.run, retiredRuns: [], createdAt: 1, updatedAt: 1,
    hookBindingId: 'private-binding', hookToken: 'private-token' })
  const config = pmoConfig(root); config.executors.private!.providerId = 'traex'
  const b = await owningBridge({ client: f.core, store: f.store, config })
  let disposeCold: (() => void) | undefined
  try {
    bindRendererBridge()
    const recipient = await bridge.api!.sessions.refresh(control)
    const tab = { ...createWorkbenchTab('original-pmo-tab', { kind: 'agent', phase: 'attached', regionId: 'original-pmo-region',
      workspaceId: SCRATCH_WORKSPACE_ID, sessionId: control.agentSessionId }), topicId: PMO_TEAMS_TOPIC_ID }
    useAppStore.setState({ loading: false, config, activeWorkspaceId: SCRATCH_WORKSPACE_ID, sessions: [recipient], demands: { [originalGoal.id]: originalGoal },
      demandPmoTabIds: { [originalGoal.id]: tab.id }, tabs: { [tab.id]: tab }, layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('original-group', [tab.id]) } })
    let saved: any, pending: any
    if (phase === 'restore') {
      saved = JSON.parse(await readFile(join(root, 'renderer.json'), 'utf8'))
      expect(saved.state.agentSteerQueues[control.agentSessionId]).toHaveLength(1)
      pending = saved.state.agentSteerQueues[control.agentSessionId][0]
    } else {
      f.loseNextAck()
      await useAppStore.getState().requestDemandPmoTask(originalGoal.id, 'grill')
      await vi.waitFor(() => expect(useAppStore.getState().agentSteerQueues[control.agentSessionId]?.[0]).toMatchObject({ status: 'deferred', error: 'Private Input accepted; ACK lost' }))
      pending = structuredClone(useAppStore.getState().agentSteerQueues[control.agentSessionId]![0]!)
      saved = JSON.parse(JSON.stringify({ state: useAppStore.persist.getOptions().partialize!(useAppStore.getState()), version: 1 }))
      if (phase === 'seed') {
        await writeFile(join(root, 'renderer.json'), JSON.stringify(saved))
        expect(f.requests).toHaveLength(1); expect(f.writes).toHaveLength(1)
        expect(f.start.mock.calls).toEqual([]); expect(f.stop.mock.calls).toEqual([])
        return
      }
    }
    expect(pending.text).toBe('Clarify goal'); expect(pending.agentMuxNote).toContain(originalGoal.description)
    const cold = phase === 'restore' ? { core: f.core, store: f.store } : await f.make()
    if (phase !== 'restore') b.runtime.commit({ hosts: [{ id: 'local', client: cold.core, executionHost: { kind: 'local', dispose: vi.fn() } as never }],
      removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
    useAppStore.setState(initialRendererState, true)
    localStorage.setItem('agentmux-workbench-v1', JSON.stringify(saved))
    await useAppStore.persist.rehydrate()
    vi.spyOn(api.config, 'get').mockResolvedValue(config)
    vi.spyOn(api.sessions, 'snapshot').mockImplementation(() => bridge.api!.sessions.snapshot())
    expect((await bridge.api!.sessions.snapshot()).sessions).toHaveLength(1)
    vi.spyOn(api.demands, 'list').mockResolvedValue([{ ...originalGoal, description: 'Changed after restart', tags: [], activities: [], decisions: [] }] as never)
    disposeCold = await useAppStore.getState().initialize()
    const restored = useAppStore.getState(), queued = restored.agentSteerQueues[control.agentSessionId]!
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({ operationId: pending.operationId, text: pending.text, agentMuxNote: pending.agentMuxNote,
      runId: pending.runId, promptCondition: pending.promptCondition, status: 'deferred', errorCode: 'AGENT_EXECUTION_NOT_REQUESTED' })
    expect(restored.tabs[tab.id]).toMatchObject({ id: tab.id, topicId: PMO_TEAMS_TOPIC_ID, layout: tab.layout })
    expect(restored.tabs[tab.id]!.regions[tab.layout.activeRegionId]).toMatchObject({ sessionId: control.agentSessionId, kind: 'agent' })
    expect(restored.layouts[SCRATCH_WORKSPACE_ID]).toMatchObject({ activeGroupId: 'original-group' })
    expect(restored.sessions, restored.error ?? undefined).toEqual([expect.objectContaining({ id: control.agentSessionId, processState: 'running' })])
    expect(f.requests).toHaveLength(phase === 'restore' ? 0 : 1); expect(f.writes).toHaveLength(1)
    await restored.sendQueuedAgentSteer(control.agentSessionId, pending.operationId)
    expect(useAppStore.getState().agentSteerQueues[control.agentSessionId] ?? [], useAppStore.getState().agentSteerQueues[control.agentSessionId]?.[0]?.error).toEqual([])
    expect(f.requests).toHaveLength(phase === 'restore' ? 1 : 2)
    if (phase !== 'restore') expect(f.requests[1]).toEqual(f.requests[0])
    expect(f.writes).toHaveLength(1)
    expect((await cold.store.loadTimeline(control.agentSessionId)).items.map(item => [item.kind, item.content])).toEqual([
      ['system_message', pending.agentMuxNote], ['user_message', pending.text]
    ])
    expect(cold.core.agentSession(control.agentSessionId).run).toEqual(control.run)
    expect(f.start.mock.calls).toEqual([]); expect(f.stop.mock.calls).toEqual([])
  } finally { disposeCold?.(); await b.dispose(); await f.dispose(); if (!sharedRoot) await rm(root, { recursive: true, force: true }) }
})

it('PMO retained launcher carries the original producer note after editing raw user bytes and choosing an Executor', async () => {
  const root = await mkdtemp(_hygiene_fixturePath("tmp/amux-pmo-edited-")), f = await injectedContextCore(root), config = pmoConfig(root)
  const b = await owningBridge({ client: f.core, store: f.store, config, scratchTopics: {
    prepareAgent: vi.fn().mockResolvedValue({ absolutePath: root, prompt: '' }), discardPreparedIdentity: vi.fn()
  } as unknown as ScratchTopics })
  try {
    bindRendererBridge(); vi.spyOn(api.scratch, 'ensureTopic').mockResolvedValue({ id: PMO_TEAMS_TOPIC_ID } as never)
    useLauncherState.setState({ executors: {} })
    useAppStore.setState({ loading: false, config: { ...config, executors: {} }, activeWorkspaceId: SCRATCH_WORKSPACE_ID, sessions: [],
      demands: { [originalGoal.id]: originalGoal }, demandPmoTabIds: {}, tabs: {}, layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('retained-group') } })
    const tabId = await useAppStore.getState().openDemandPmo(originalGoal.id), tab = useAppStore.getState().tabs[tabId]!, regionId = tab.layout.activeRegionId
    const note = useAppStore.getState().agentComposerNotes[regionId]!
    expect(useAppStore.getState().agentComposerDrafts[regionId]).toBe('')
    expect(note).toContain(MOTE_COORDINATION_ROLE); expect(note).toContain(originalGoal.description)
    expect(f.start.mock.calls).toEqual([])
    const prompt = '  User edited <amux from="amux">literal body</amux>\r\nKeep the ending.  \n'
    useAppStore.getState().setAgentComposerDraft(regionId, prompt)
    useAppStore.setState({ config, demands: { [originalGoal.id]: { ...originalGoal, description: 'Later Goal state' } } })
    expect(useAppStore.persist.getOptions().partialize!(useAppStore.getState()).agentComposerNotes![regionId]).toBe(note)
    await useAppStore.getState().launchAgent('private', prompt, 'retained-group', { tabId, regionId })
    const active = useAppStore.getState().tabs[tabId]!.regions[regionId]!
    expect(active.kind).toBe('agent')
    const sessionId = (active as { sessionId: string }).sessionId, composed = composeAgentLaunchPrompt(prompt, false, note)
    expect((await f.store.loadTimeline(sessionId)).items.map(item => [item.kind, item.content])).toEqual([
      ['system_message', composed.systemContext], ['user_message', prompt]
    ])
    expect(f.start).toHaveBeenCalledTimes(1); expect(f.start.mock.calls[0]![0]).toMatchObject({ args: expect.arrayContaining([composed.text]) })
    expect(useAppStore.getState().agentComposerNotes[regionId]).toBeUndefined()
    expect(f.stop.mock.calls).toEqual([])
  } finally { await b.dispose(); await f.dispose(); await rm(root, { recursive: true, force: true }) }
})

it('PMO shared queue transports standalone platform context and untouched raw body through actual Core', async () => {
  const root = await mkdtemp(_hygiene_fixturePath("tmp/amux-pmo-queue-"))
  const f = await injectedContextCore(root, { kind: 'agent', agentSessionId: control.agentSessionId, providerId: 'traex', executorId: 'private',
    hostId: 'local', workspacePath: root, run: control.run, retiredRuns: [], createdAt: 1, updatedAt: 1,
    hookBindingId: 'private-binding', hookToken: 'private-token' })
  const config = pmoConfig(root); config.executors.private!.providerId = 'traex'
  const b = await owningBridge({ client: f.core, store: f.store, config })
  try {
    bindRendererBridge()
    const recipient = await bridge.api!.sessions.refresh(control)
    useAppStore.setState({ loading: false, config, sessions: [recipient], agentSteerQueues: {} })
    const note = 'Explicit original context <value> & note', body = '  Original <amux from="amux">user</amux>\r\n trailing  \n'
    expect(useAppStore.getState().enqueueAgentSteer(control.agentSessionId, '', undefined, 'context-operation', undefined, note)).toBe(true)
    await useAppStore.getState().flushAgentSteerQueue(control.agentSessionId, 'context-operation')
    expect(useAppStore.getState().enqueueAgentSteer(control.agentSessionId, body, undefined, 'raw-operation', 'manual', note)).toBe(true)
    await useAppStore.getState().flushAgentSteerQueue(control.agentSessionId, 'raw-operation')
    expect(f.writes).toEqual([composeAgentPrompt('', note).text + '\r', composeAgentPrompt(body, note).text + '\r'])
    expect((await f.store.loadTimeline(control.agentSessionId)).items.map(item => [item.kind, item.content])).toEqual([
      ['system_message', note], ['system_message', note], ['user_message', body]
    ])
    expect(f.start.mock.calls).toEqual([]); expect(f.stop.mock.calls).toEqual([])
  } finally { await b.dispose(); await f.dispose(); await rm(root, { recursive: true, force: true }) }
})
