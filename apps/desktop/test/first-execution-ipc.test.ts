import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { bridge, control, owningBridge } from './helpers/first-execution-ipc-bridge'
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { AgentMuxError } from '@agentmux/core'
import { unwrapSessionInputWriteResult } from '../src/shared/session-input-result'
import type { AppConfig } from '../src/shared/contracts'
import type { ScratchTopics } from '../src/main/scratch-topics'
import { DEFAULT_CONFIG } from '../src/main/config-store'
import { injectedContextCore } from './helpers/injected-context-core'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'
import { MOTE_COORDINATION_ROLE, PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '@agentmux/host/mote-model'
import { composeAgentPrompt, composeAgentLaunchPrompt } from '@agentmux/core/agent-outbound-message'
import { goalRoleGuidance } from '@agentmux/core/goal-role-guidance'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { workspaceProjectId } from '../src/renderer/src/lib/workspace-projects'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { AgentMuxControlServer as RealStorageControlServer } from '../../../packages/core/src/public-rpc-server'
import { runDesktopStorageHostProbe } from './helpers/storage-recovery-host-probe'
import { createWorkbenchUserDocument, WORKBENCH_USER_STATE_KEY } from '../src/renderer/src/lib/workbench-user-storage'

const initialRendererState = useAppStore.getState()
const workbenchDelta = (draft: string) => JSON.stringify({ state: { agentComposerDrafts: { original: draft } },
  version: 1, inputQueueDelta: { changes: [] } })
const savedWorkbenchDraft = async () => JSON.parse((await bridge.api!.ui.readWorkbenchState())!).state.agentComposerDrafts.original

it('the registered Main source export is consumed by a second real Host adapter process and releases only its copies', async () => {
  const f = await owningBridge(), directory = await mkdtemp('/tmp/amux-real-host-source-'), socket = join(directory, 'desktop.sock')
  const server = new RealStorageControlServer({ socketPath: socket, ...(bridge.storageRecoveryExports ? { storageRecoveryExports: bridge.storageRecoveryExports } : {}) })
  const original = 'Original private unsent input'
  try {
    await bridge.api!.ui.writeWorkbenchState(workbenchDelta(original))
    await server.start()
    const child = await runDesktopStorageHostProbe(directory, socket)
    expect(child.code, child.stderr).toBe(0)
    const result = JSON.parse(child.stdout)
    expect(result.pid).not.toBe(process.pid)
    const member = result.result.members.find((item: { id: string }) => item.id === 'desktop.user-state/document')
    expect(member).toMatchObject({ target: f.workbenchUserState.databasePath })
    const copy = new DatabaseSync(member.file, { readOnly: true })
    try { expect(copy.prepare("SELECT body FROM document_rows WHERE scope = 'agentComposerDrafts' AND name = 'original'").get()?.body)
      .toBe(JSON.stringify(original)) } finally { copy.close() }
    expect(await savedWorkbenchDraft()).toBe(original)
    const { readdir } = await import('node:fs/promises')
    expect(await readdir(f.workbenchUserState.path + '.recovery-exports')).toEqual([])
    expect(f.client.ensureAgentContinuity).not.toHaveBeenCalled()
    expect(f.client.submitAgentPrompt).not.toHaveBeenCalled()
  } finally { await server.stop(); await f.dispose(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }) }
}, 40_000)
const initialLauncherState = useLauncherState.getState()
let disposePreview: (() => void) | undefined
beforeAll(async () => { disposePreview = await useAppStore.getState().initialize() })
afterAll(() => disposePreview?.())

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); bridge.invoke.mockReset(); useAppStore.setState(initialRendererState, true); useLauncherState.setState(initialLauncherState, true) })

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

it('actual native save bridge requires a matching writer ACK and rejects a missing file despite Chromium directories', async () => {
  const { flush, workbenchUserState, dispose } = await owningBridge()
  const original = 'Exact original native input'
  try {
    await expect(bridge.api!.ui.requestStorageFlush()).rejects.toThrow('no matching writer acknowledgement')
    expect(await bridge.api!.ui.writeWorkbenchState(workbenchDelta(original))).toMatchObject({ diskDurability: 'confirmed' })
    await expect(bridge.api!.ui.requestStorageFlush()).resolves.toBeUndefined()
    expect(await savedWorkbenchDraft()).toBe(original)
    await unlink(workbenchUserState.databasePath)
    await expect(bridge.api!.ui.requestStorageFlush()).rejects.toThrow('original Desktop database')
    await expect(bridge.api!.ui.writeWorkbenchState(workbenchDelta(original))).rejects.toThrow('original Desktop database')
    await expect(readFile(workbenchUserState.databasePath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(flush).not.toHaveBeenCalled()
  } finally { await dispose() }
})

it.each([1, 1600])('actual native save bridge retains the original cold input with %d archived records', async count => {
  const f = await owningBridge()
  const ownerKey = 'original-queue', operationId = 'confirmed-input', run = { runId: 'original-run' }
  const key = { kind: 'prompt', agentSessionId: ownerKey, submissionId: operationId, expectedRun: run }
  const claim = (submissionId: string) => {
    const claimed = { ...key, submissionId }, ref = { key: claimed, waitGeneration: 1 }
    return { key: claimed, ref, observation: 'closed', persistence: 'confirmed', status: 'terminal-confirmed',
      control: { ref, state: 'dispatch-authorized', at: 1, gateId: 'original-gate' } }
  }
  const completed = {
    operationId, text: 'Original archived input', status: 'deferred', archived: true,
    directInputControl: { kind: 'agent', hostId: 'local', agentSessionId: ownerKey, run },
    directInputBinding: { expectedRun: run, admissionIntent: { kind: 'manual-actor' } },
    inputReceipt: claim(operationId),
  }
  const unresolved = { ...completed, operationId: 'unknown-input', text: 'Original unresolved input',
    inputReceipt: { key: { ...key, submissionId: 'unknown-input' }, persistence: 'observed', status: 'unknown' } }
  const archived = [completed, ...Array.from({ length: count - 1 }, (_, index) => {
    const operationId = `archived-input-${index}`
    return { ...completed, operationId, text: 'Archived historical text '.repeat(200),
      inputReceipt: claim(operationId) }
  })]
  const incomplete = { ...completed, operationId: 'incomplete-receipt', text: 'Original partial receipt',
    inputReceipt: { key: { ...key, submissionId: 'incomplete-receipt' }, persistence: 'confirmed', status: 'terminal-confirmed' } }
  try {
    const legacyEnvelope = { version: 1, state: { agentComposerDrafts: { original: 'Unsent draft' },
      agentSteerQueues: { [ownerKey]: [...archived, unresolved, incomplete] } } }
    await writeFile(f.workbenchUserState.path, JSON.stringify(legacyEnvelope))
    const saved = JSON.parse((await bridge.api!.ui.readWorkbenchState())!)
    expect(saved.state.agentSteerQueues[ownerKey]).toEqual([unresolved, incomplete])
    expect(saved.state.agentComposerDrafts).toEqual(legacyEnvelope.state.agentComposerDrafts)
    const query = { ownerKey, operationId }
    await expect(bridge.api!.ui.readWorkbenchInputArchive(query)).resolves.toEqual({
      entries: [{ ownerKey, entry: completed }], nextCursor: null,
    })
    await expect(bridge.api!.ui.readWorkbenchInputArchive({ operationId })).rejects.toMatchObject({
      code: 'WORKBENCH_INPUT_ARCHIVE_QUERY_INVALID',
    })
    const document = createWorkbenchUserDocument(bridge.api!.ui, () => window.localStorage)
    const hydrated = await document.persistent.storage.getItem(WORKBENCH_USER_STATE_KEY)
    expect(hydrated).toMatchObject({ state: saved.state })
    await document.persistent.checkpoint(WORKBENCH_USER_STATE_KEY, {
      state: { ...saved.state, agentComposerDrafts: { original: 'Edited draft' } }, version: 1,
    })
    const writes = bridge.invoke.mock.calls.filter(([channel]) => channel === 'ui:writeWorkbenchState')
    expect(writes).toHaveLength(1)
    const sent = writes[0]![1] as { value: string }
    const expected = { version: 1, state: { agentComposerDrafts: { original: 'Edited draft' } }, inputQueueDelta: { changes: [] } }
    expect(JSON.parse(sent.value)).toEqual(expected)
    expect(Buffer.byteLength(sent.value)).toBe(Buffer.byteLength(JSON.stringify(expected)))
    await expect(bridge.api!.ui.requestStorageFlush()).resolves.toBeUndefined()
    await expect(bridge.api!.ui.readWorkbenchInputArchive({ ownerKey: 'another-queue', operationId })).resolves.toEqual({
      entries: [], nextCursor: null,
    })
    await expect(bridge.api!.ui.readWorkbenchInputArchive(query)).resolves.toEqual({
      entries: [{ ownerKey, entry: completed }], nextCursor: null,
    })
    const current = JSON.parse((await bridge.api!.ui.readWorkbenchState())!)
    expect(current.state.agentComposerDrafts).toEqual({ original: 'Edited draft' })
    expect(current.state.agentSteerQueues[ownerKey]).toEqual([unresolved, incomplete])
  } finally { await f.dispose() }
}, 30_000)

it('actual native save bridge validates each new document only once', async () => {
  const { dispose } = await owningBridge()
  const original = workbenchDelta('Original input'), edited = workbenchDelta('Edited input')
  const parse = vi.spyOn(JSON, 'parse')
  try {
    await expect(bridge.api!.ui.writeWorkbenchState(original)).resolves.toMatchObject({ diskDurability: 'confirmed' })
    await expect(bridge.api!.ui.writeWorkbenchState(edited)).resolves.toMatchObject({ diskDurability: 'confirmed' })
    const parsed = parse.mock.calls.map(([input]) => input).filter(input => input === original || input === edited)
    expect(parsed).toEqual([original, edited])
    expect(await savedWorkbenchDraft()).toBe('Edited input')
  } finally { parse.mockRestore(); await dispose() }
})

it('actual native save bridge protects a same-length corrupted database', async () => {
  const { workbenchUserState, dispose } = await owningBridge()
  try {
    const receipt = await bridge.api!.ui.writeWorkbenchState(workbenchDelta('Durable input'))
    const damaged = await readFile(workbenchUserState.databasePath)
    damaged[0] = 0
    await writeFile(workbenchUserState.databasePath, damaged)
    await expect(bridge.api!.ui.writeWorkbenchState(workbenchDelta('Edited input'))).rejects.toThrow()
    expect(await readFile(workbenchUserState.databasePath)).toEqual(damaged)
    expect(workbenchUserState.observe()).toMatchObject({ availability: 'unconfirmed', diskDurability: 'unconfirmed', lastConfirmedWrite: receipt })
  } finally { await dispose() }
})

it('a readable native document or replacement cannot manufacture the original writer ACK', async () => {
  const { workbenchUserState, dispose } = await owningBridge()
  const original = JSON.stringify({ state: { agentComposerDrafts: { original: 'Readable original' } }, version: 1 })
  try {
    await writeFile(workbenchUserState.path, original)
    await expect(bridge.api!.ui.requestStorageFlush()).rejects.toThrow('no matching writer acknowledgement')
    expect(await savedWorkbenchDraft()).toBe('Readable original')
    const receipt = await bridge.api!.ui.writeWorkbenchState(workbenchDelta('Readable original'))
    const database = new DatabaseSync(workbenchUserState.databasePath)
    try {
      database.prepare("UPDATE document_rows SET body=? WHERE scope='agentComposerDrafts' AND name='original'")
        .run(JSON.stringify('Externally replaced input'))
    } finally { database.close() }
    await expect(bridge.api!.ui.requestStorageFlush()).rejects.toThrow('no matching writer acknowledgement')
    expect(await savedWorkbenchDraft()).toBe('Externally replaced input')
    expect(workbenchUserState.observe().lastConfirmedWrite).toEqual(receipt)
    await expect(bridge.api!.ui.writeWorkbenchState(workbenchDelta('Attempted overwrite')))
      .rejects.toMatchObject({ code: 'WORKBENCH_USER_DATABASE_CHANGED' })
    expect(await savedWorkbenchDraft()).toBe('Externally replaced input')
  } finally { await dispose() }
})

it('registered native storage handlers reject foreign contents or frames before reaching the application owner', async () => {
  const { flush, sender, workbenchUserState, dispose } = await owningBridge()
  const reads = vi.spyOn(workbenchUserState, 'read'), writes = vi.spyOn(workbenchUserState, 'write')
  const imports = vi.spyOn(workbenchUserState, 'importIfAbsent')
  const original = JSON.stringify({ state: { agentComposerDrafts: { original: 'Foreign request' } }, version: 1 })
  try {
    for (const event of [{ sender: {}, senderFrame: sender.mainFrame }, { sender, senderFrame: { ...sender.mainFrame } }]) {
      for (const channel of ['ui:readWorkbenchState', 'ui:readWorkbenchInputArchive', 'ui:importWorkbenchState', 'ui:writeWorkbenchState', 'ui:requestStorageFlush']) {
        const handler = bridge.handlers.get(channel)
        expect(handler).toBeTypeOf('function')
        expect(() => handler!(event, original)).toThrow('Untrusted application main document sender')
      }
    }
    expect(reads).not.toHaveBeenCalled()
    expect(writes).not.toHaveBeenCalled()
    expect(imports).not.toHaveBeenCalled()
    expect(flush).not.toHaveBeenCalled()
  } finally { await dispose() }
})

it('private save revisions fence a late old request through actual preload and registered Main admission', async () => {
  const f = await owningBridge()
  const invoke = bridge.invoke.getMockImplementation()!
  let release!: () => void, entered!: () => void
  const delayed = new Promise<void>(resolve => { release = resolve }), ready = new Promise<void>(resolve => { entered = resolve })
  let first = true
  bridge.invoke.mockImplementation(async (channel, ...values) => {
    if (channel === 'ui:writeWorkbenchState' && first) { first = false; entered(); await delayed }
    return invoke(channel, ...values)
  })
  const old = workbenchDelta('old'), latest = workbenchDelta('latest')
  try {
    const pending = bridge.api!.ui.writeWorkbenchState(old)
    const refused = expect(pending).rejects.toMatchObject({ code: 'WORKBENCH_USER_STATE_SUPERSEDED' })
    await ready; await bridge.api!.ui.writeWorkbenchState(latest)
    release(); await refused
    expect(await savedWorkbenchDraft()).toBe('latest')
  } finally { release(); await f.dispose() }
})

it('actual preload, registered IPC and Main keep injected context separate from the untouched manual body', async () => {
  const { client, pauseTarget, dispose } = await owningBridge()
  const prompt = '  <amux from="amux">User authored text</amux>\r\n  ', agentMuxNote = 'Platform rule <literal> & text.'
  const condition = { expectedRun: control.run, afterSubmissionId: null }
  try {
    await bridge.api!.sessions.submitPrompt(control, prompt, 'one-original-operation', condition, undefined, true, agentMuxNote)
    expect(client.submitAgentPrompt).toHaveBeenCalledExactlyOnceWith({ agentSessionId: control.agentSessionId, ...condition,
      operationId: 'one-original-operation', prompt, authorHuman: true, agentMuxNote, sourceChannel: 'message-tool' })
    expect(pauseTarget).toHaveBeenCalledTimes(1)
  } finally { await dispose() }
})

it('registered prompt IPC rejects foreign platform provenance before Core or progress side effects', async () => {
  const { client, pauseTarget, sender, dispose } = await owningBridge()
  try {
    const handler = bridge.handlers.get('sessions:submitPrompt')!
    const foreign = { ...sender }
    await expect(handler({ sender: foreign }, control, 'ordinary body', 'one-original-operation',
      { expectedRun: control.run, afterSubmissionId: null }, undefined, false, 'forged platform source')).resolves.toEqual({ ok: false, error: { code: 'SESSION_INPUT_FAILED', message: 'Untrusted manual prompt sender' } })
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
  priority: 'normal' as const, projectId: null, projectName: null, executorId: null, tags: [], plannedStartAt: null, targetAt: null, parentDemandId: null, sessionIds: [], assigneeSessionIds: [], supervisorSessionId: null, participations: [], activities: [], decisions: [], createdAt: _tailFixtureEpoch(0, 0, 1), updatedAt: _tailFixtureEpoch(0, 0, 1), source: 'default-topic' as const }
function bindRendererBridge() {
  vi.spyOn(api.demands, 'list').mockImplementation(() => bridge.api!.demands.list())
  vi.spyOn(api.sessions, 'submitPrompt').mockImplementation((...args) => bridge.api!.sessions.submitPrompt(...args).then(unwrapSessionInputWriteResult))
  vi.spyOn(api.sessions, 'refresh').mockImplementation((...args) => bridge.api!.sessions.refresh(...args))
  vi.spyOn(api.sessions, 'launchAgent').mockImplementation((...args) => bridge.api!.sessions.launchAgent(...args))
  vi.spyOn(api.sessions, 'onEvent').mockImplementation((...args) => bridge.api!.sessions.onEvent(...args))
  vi.spyOn(api.continuousProgress, 'pauseForInput').mockResolvedValue(undefined)
}

it('PMO mapped Store requests reach registered IPC and real Core as independent platform/user records on the original healthy Run', async () => {
  const root = await mkdtemp(_hygiene_fixturePath("tmp/amux-pmo-mapped-"))
  const f = await injectedContextCore(root, { kind: 'agent', agentSessionId: control.agentSessionId, providerId: 'traex', executorId: 'private',
    hostId: 'local', workspacePath: root, run: control.run, retiredRuns: [], createdAt: _tailFixtureEpoch(0, 0, 1), updatedAt: _tailFixtureEpoch(0, 0, 1),
    hookBindingId: 'private-binding', hookToken: 'private-token' })
  const config = pmoConfig(root)
  config.executors.private!.providerId = 'traex'
  const b = await owningBridge({ client: f.core, store: f.store, config, goals: [originalGoal] })
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
  const b = await owningBridge({ client: f.core, store: f.store, config, goals: [originalGoal], scratchTopics: { setNameAudit: vi.fn(), readForDirectory: async () => null, read: async () => null, prepareAgent: prepare, discardPreparedIdentity: vi.fn() } as unknown as ScratchTopics })
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
    expect(intent.request!.prompt).toBe('Clarify goal'); expect(note).not.toContain(MOTE_COORDINATION_ROLE)
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
    hostId: 'local', workspacePath: root, run: control.run, retiredRuns: [], createdAt: _tailFixtureEpoch(0, 0, 1), updatedAt: _tailFixtureEpoch(0, 0, 1),
    hookBindingId: 'private-binding', hookToken: 'private-token' })
  const config = pmoConfig(root); config.executors.private!.providerId = 'traex'
  const b = await owningBridge({ client: f.core, store: f.store, config, goals: [originalGoal] })
  let disposeCold: (() => void) | undefined
  try {
    bindRendererBridge()
    const recipient = await bridge.api!.sessions.refresh(control)
    const tab = { ...createWorkbenchTab('original-pmo-tab', { kind: 'agent', phase: 'attached', regionId: 'original-pmo-region',
      workspaceId: SCRATCH_WORKSPACE_ID, sessionId: control.agentSessionId }), topicId: PMO_TEAMS_TOPIC_ID }
    useAppStore.setState({ loading: false, config, activeWorkspaceId: SCRATCH_WORKSPACE_ID, sessions: [recipient], demands: { [originalGoal.id]: originalGoal },
      demandPmoTabIds: { [originalGoal.id]: tab.id }, tabs: { [tab.id]: tab }, layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('original-group', [tab.id]) } })
    // Persist the same original Core occurrence, including its execution Host.
    // Renderer descriptors alone cannot authorize attaching a later Runtime fact.
    if (phase !== 'restore') {
      const previous = await bridge.api!.spatial.read()
      await bridge.api!.spatial.commit({ expectedRevision: previous?.revision ?? 0, graph: desktopSpatialGraph(useAppStore.getState(), []) })
    }
    expect((await bridge.api!.spatial.read())!.graph.regions).toContainEqual(expect.objectContaining({
      tabId: tab.id, regionId: tab.layout.activeRegionId, agentSessionId: control.agentSessionId, execution: { hostId: 'local', cwd: root }
    }))
    let saved: any, pending: any
    if (phase === 'restore') {
      saved = JSON.parse(await readFile(join(root, 'renderer.json'), 'utf8'))
      expect(saved.state.agentSteerQueues[control.agentSessionId]).toHaveLength(1)
      pending = saved.state.agentSteerQueues[control.agentSessionId][0]
    } else {
      f.loseNextAck()
      await useAppStore.getState().requestDemandPmoTask(originalGoal.id, 'grill')
      await vi.waitFor(() => expect(useAppStore.getState().agentSteerQueues[control.agentSessionId]?.[0], JSON.stringify(useAppStore.getState().agentSteerQueues[control.agentSessionId])).toMatchObject({ status: 'deferred', error: 'Private Input accepted; ACK lost [Error]', errorCode: 'Error' }))
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
    if (phase !== 'restore') b.runtime.commit({ hosts: [{ id: 'local', config: config.hosts.find(host => host.id === 'local')!, client: cold.core, executionHost: { kind: 'local', dispose: vi.fn() } as never }],
      removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
    useAppStore.setState(initialRendererState, true)
    localStorage.setItem('agentmux-workbench-v1', JSON.stringify(saved))
    await useAppStore.persist.rehydrate()
    vi.spyOn(api.config, 'get').mockResolvedValue(config)
    vi.spyOn(api.spatial, 'read').mockImplementation(() => bridge.api!.spatial.read())
    vi.spyOn(api.spatial, 'commit').mockImplementation(input => bridge.api!.spatial.commit(input))
    vi.spyOn(api.spatial, 'retainLabels').mockImplementation(values => bridge.api!.spatial.retainLabels(values))
    vi.spyOn(api.spatial, 'onChange').mockImplementation(listener => bridge.api!.spatial.onChange(listener))
    const coldSnapshots: unknown[] = []
    vi.spyOn(api.sessions, 'snapshot').mockImplementation(async () => { const value = await bridge.api!.sessions.snapshot(); coldSnapshots.push(structuredClone(value)); return value })
    expect((await bridge.api!.sessions.snapshot()).sessions).toHaveLength(1)
    vi.spyOn(api.demands, 'list').mockResolvedValue([{ ...originalGoal, description: 'Changed after restart', tags: [], activities: [], decisions: [] }] as never)
    disposeCold = await useAppStore.getState().initialize()
    const restored = useAppStore.getState(), queued = restored.agentSteerQueues[control.agentSessionId]!
    expect(queued).toHaveLength(1)
    expect(queued[0], JSON.stringify(queued[0])).toMatchObject({ operationId: pending.operationId, text: pending.text, agentMuxNote: pending.agentMuxNote,
      runId: pending.runId, promptCondition: pending.promptCondition, status: 'deferred', awaitingExplicitSend: true, error: 'Private Input accepted; ACK lost [Error]', errorCode: 'Error' })
    expect(restored.tabs[tab.id]).toMatchObject({ id: tab.id, topicId: PMO_TEAMS_TOPIC_ID, layout: tab.layout })
    expect(restored.tabs[tab.id]!.regions[tab.layout.activeRegionId]).toMatchObject({ sessionId: control.agentSessionId, kind: 'agent' })
    expect(restored.layouts[SCRATCH_WORKSPACE_ID]).toMatchObject({ activeGroupId: 'original-group' })
    // Startup publishes the durable workface first; the original membership reader
    // then attaches current Runtime facts without replacing the hydrated intent.
    await vi.waitFor(() => expect(useAppStore.getState().sessions, JSON.stringify({ error: useAppStore.getState().error, snapshots: coldSnapshots })).toEqual([expect.objectContaining({ id: control.agentSessionId, processState: 'running' })]))
    expect(f.requests).toHaveLength(phase === 'restore' ? 0 : 1); expect(f.writes).toHaveLength(1)
    await restored.sendQueuedAgentSteer(control.agentSessionId, pending.operationId)
    expect(useAppStore.getState().agentSteerQueues[control.agentSessionId] ?? [], useAppStore.getState().agentSteerQueues[control.agentSessionId]?.[0]?.error).toEqual([])
    expect(f.requests).toHaveLength(phase === 'restore' ? 1 : 2)
    if (phase !== 'restore') expect(f.requests[1]).toEqual(f.requests[0])
    expect(f.writes).toHaveLength(1)
    const originalSystemContext = [pending.agentMuxNote, goalRoleGuidance({ role: 'manager', goalId: originalGoal.id,
      agentSessionId: control.agentSessionId, runId: control.run.runId, source: { kind: 'goal-discussion', operationId: pending.operationId } })].join('\n\n')
    expect(f.writes).toEqual([composeAgentPrompt(pending.text, originalSystemContext).text + '\r'])
    expect((await cold.store.loadTimeline(control.agentSessionId)).items.map(item => [item.kind, item.content])).toEqual([
      ['system_message', originalSystemContext], ['user_message', pending.text]
    ])
    expect(cold.core.agentSession(control.agentSessionId).run).toEqual(control.run)
    expect(f.start.mock.calls).toEqual([]); expect(f.stop.mock.calls).toEqual([])
  } finally { disposeCold?.(); await b.dispose(); await f.dispose(); if (!sharedRoot) await rm(root, { recursive: true, force: true }) }
})

it('PMO retained launcher carries the original producer note after editing raw user bytes and choosing an Executor', async () => {
  const root = await mkdtemp(_hygiene_fixturePath("tmp/amux-pmo-edited-")), f = await injectedContextCore(root), config = pmoConfig(root)
  const b = await owningBridge({ client: f.core, store: f.store, config, goals: [originalGoal], scratchTopics: {
    setNameAudit: vi.fn(), readForDirectory: async () => null, read: async () => null, prepareAgent: vi.fn().mockResolvedValue({ absolutePath: root, prompt: '' }), discardPreparedIdentity: vi.fn()
  } as unknown as ScratchTopics })
  try {
    bindRendererBridge(); vi.spyOn(api.scratch, 'ensureTopic').mockResolvedValue({ id: PMO_TEAMS_TOPIC_ID } as never)
    useLauncherState.setState({ executors: {} })
    useAppStore.setState({ loading: false, config: { ...config, executors: {} }, activeWorkspaceId: SCRATCH_WORKSPACE_ID, sessions: [],
      demands: { [originalGoal.id]: originalGoal }, demandPmoTabIds: {}, tabs: {}, layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('retained-group') } })
    const tabId = await useAppStore.getState().openDemandPmo(originalGoal.id), tab = useAppStore.getState().tabs[tabId]!, regionId = tab.layout.activeRegionId
    const note = useAppStore.getState().agentComposerNotes[regionId]!
    expect(useAppStore.getState().agentComposerDrafts[regionId]).toBe('')
    expect(note).not.toContain(MOTE_COORDINATION_ROLE); expect(note).toContain(originalGoal.description)
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
    hostId: 'local', workspacePath: root, run: control.run, retiredRuns: [], createdAt: _tailFixtureEpoch(0, 0, 1), updatedAt: _tailFixtureEpoch(0, 0, 1),
    hookBindingId: 'private-binding', hookToken: 'private-token' })
  const config = pmoConfig(root); config.executors.private!.providerId = 'traex'
  const b = await owningBridge({ client: f.core, store: f.store, config, goals: [originalGoal] })
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
