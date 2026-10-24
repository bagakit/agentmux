// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { appendFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { generateKeyPair } from '@agentmux/relay/e2ee'
import { openDemandStore } from '@agentmux/demand'
import { headlessFixture, until } from '../../../packages/core/test/helpers/headless-runtime-fixture.js'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client.js'
import { AgentMuxSpatialStateStore, spatialAgentOpenRecord } from '../../../packages/core/src/spatial-state.js'
import { createWorkspaceLayout, createWorkbenchViewLayout } from '../../../packages/core/src/spatial-layout.js'
import { captureGoalDiscussionLauncherLaunch, confirmGoalDiscussionLauncherLaunch, handoffGoalDiscussion, launcherCreationSpatialIntent } from '../../desktop/src/main/goal-discussion-handoff.js'
import { ScratchTopics } from '../src/mote-resources.js'
import { SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID } from '../src/mote-topic-model.js'
import { goalDiscussionBindingKey, readGoalDiscussionBinding } from '../src/goal-discussion-bindings.js'

const cleanup: Array<() => Promise<void>> = []
const fact = (value: unknown) => { if (process.env.GOAL_HANDOFF_FACTS) appendFileSync(process.env.GOAL_HANDOFF_FACTS, JSON.stringify(value) + '\n') }
afterEach(async () => {
  const results = await Promise.allSettled(cleanup.splice(0).reverse().map(close => close()))
  fact({ cleanup: results.map(result => result.status === 'fulfilled' ? { state: 'confirmed' } : { state: 'unknown', error: String(result.reason) }) })
  expect(results.filter(result => result.status === 'rejected')).toEqual([])
})

it('the actual Host, public CLI and encrypted Relay consume one handed-off recipient across restart, and new discussions use that same canonical owner', async () => {
  const loader = resolve(import.meta.dirname, 'goal-discussion-handoff-node-loader.mjs')
  const previous = process.env.AGENTMUX_TEST_OWNER_ENTRY
  process.env.AGENTMUX_TEST_OWNER_ENTRY = resolve(import.meta.dirname, 'fixtures/mobile-web-host.mjs')
  let f: Awaited<ReturnType<typeof headlessFixture>>
  try { f = await headlessFixture({ ownerNodeArgs: ['--experimental-transform-types', '--import', loader] }) }
  finally { if (previous === undefined) delete process.env.AGENTMUX_TEST_OWNER_ENTRY; else process.env.AGENTMUX_TEST_OWNER_ENTRY = previous }
  const clients: Array<{ dispose(): Promise<void> }> = []
  cleanup.push(async () => {
    const errors = (await Promise.allSettled(clients.map(client => client.dispose()))).flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    try {
      const client = await f.client()
      const sessions = (await client.readAgentSessions()).filter(session => session.kind === 'agent')
      errors.push(...(await Promise.allSettled(sessions.map(session => client.stopAgent(session.agentSessionId, session.run)))).flatMap(result => result.status === 'rejected' ? [result.reason] : []))
    } catch (error) { errors.push(error) }
    try { await f.cleanup() } catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError(errors, 'Private handoff fixture cleanup remains unconfirmed')
  })
  const relay = async () => {
    const info = JSON.parse(await readFile(join(f.env.AGENTMUX_STATE_DIRECTORY!, 'mobile-test-owner.json'), 'utf8'))
    const client = await connectAgentMuxRpc({ endpoint: { transport: 'relay', offer: info.offer }, relayKeyPair: generateKeyPair() })
    clients.push(client); await client.call('runtime.owner.identity', {}); return client
  }
  const core = await f.client(), phone = await relay(), stateDirectory = f.env.AGENTMUX_STATE_DIRECTORY!
  const configurationPath = join(stateDirectory, 'original-configuration.json'), configuration = JSON.parse(await readFile(configurationPath, 'utf8'))
  const scratch = join(f.root, 'scratch'); await mkdir(scratch)
  const workspace = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: scratch }
  const mote = await new ScratchTopics().ensure(workspace, PMO_TEAMS_TOPIC_ID)
  const command = resolve(import.meta.dirname, '../../../packages/core/test/fixtures/fake-codex-cli.mjs')
  configuration.workspaces.push({ ...workspace, name: 'Original private Mote', kind: 'folder' })
  configuration.executors.codex = { providerId: 'codex', label: 'Private original executor', command, args: [],
    env: { AGENTMUX_FAKE_READY_MODE: 'before', AGENTMUX_FAKE_NATIVE_RECORD: '1' }, injectAgentMuxGuide: false }
  await writeFile(configurationPath, JSON.stringify(configuration))
  const original = await core.createAgent({ providerId: 'codex', executorId: 'codex', workspacePath: mote.physicalDirectoryPath!,
    createOperationId: 'original-retained-session', commandOverride: command, injectAgentMuxGuide: false,
    env: { AGENTMUX_FAKE_READY_MODE: 'before', AGENTMUX_FAKE_NATIVE_RECORD: '1' } })
  const ready = async (client: typeof core, session: typeof original, label: string) => {
    try {
      const observed = await until(() => client.statusAgent(session.agentSessionId), value => value.session.run.runId === session.run.runId &&
        value.run.runId === session.run.runId && value.observation.process === 'running' && value.observation.readiness === 'ready' &&
        value.observation.source === 'native-transcript' && value.observation.semantic === 'idle' && !value.observation.stale &&
        value.run.nativeService?.input.phase.type === 'open' && value.run.nativeService.input.unsettledCommands === 0 &&
        value.run.nativeService.input.unsettledRequestBytes === 0 && value.run.nativeService.terminalFault === null, label)
      // Nonempty native initialization does not create an initial-composer byte epoch.
      // The public Provider/Runtime observation proves this fixture's same-Run input prerequisite.
      fact({ phase: 'provider-readiness-confirmed', label, run: observed.session.run, observation: observed.observation,
        terminalPromptReadiness: observed.session.terminalPromptReadiness, nativeService: observed.run.nativeService })
      return observed
    } catch (error) {
      const observations = await Promise.allSettled([client.statusAgent(session.agentSessionId), client.readRunReplay(session.run), client.inspectAgentCreation(session.agentSessionId)])
      fact({ phase: 'provider-readiness-unconfirmed', label, original: session,
        observations: observations.map(result => result.status === 'fulfilled' ? { state: 'observed', value: result.value } : { state: 'unknown', error: String(result.reason) }) })
      throw error
    }
  }
  await ready(core, original, 'the exact original Run has its Provider input readiness')
  fact({ phase: 'original-native-ready', owner: f.owner, nativeProcessId: f.nativeProcessId, session: original })
  const spaceId = JSON.stringify(['local', mote.physicalDirectoryPath]), zoneId = 'original-home'
  const spatial = new AgentMuxSpatialStateStore(join(stateDirectory, 'spatial-state.json'))
  await spatial.commit({ expectedRevision: 0, graph: {
    spaces: [{ spaceId, kind: 'mote', topicId: PMO_TEAMS_TOPIC_ID, name: 'Original primary Mote', hostId: 'local', directoryPath: mote.physicalDirectoryPath!, projectId: null }],
    zones: [{ zoneId, workspaceId: SCRATCH_WORKSPACE_ID, kind: 'home', hostId: 'local', directoryPath: mote.physicalDirectoryPath!, branch: null }], bindings: [{ spaceId, zoneId }],
    tabs: [{ tabId: 'retained-tab', zoneId, workspaceId: SCRATCH_WORKSPACE_ID, name: 'Original discussion', regionIds: ['retained-region'] },
      { tabId: 'retained-launcher-tab', zoneId, workspaceId: SCRATCH_WORKSPACE_ID, name: 'Original unfilled discussion', regionIds: ['retained-launcher-region'] },
      { tabId: 'native-launcher-tab', zoneId, workspaceId: SCRATCH_WORKSPACE_ID, name: 'Original native Launcher', regionIds: ['native-launcher-region'] }],
    regions: [{ tabId: 'retained-tab', regionId: 'retained-region', kind: 'agent', agentSessionId: original.agentSessionId, runId: original.run.runId, execution: { hostId: 'local', cwd: original.workspacePath } },
      { tabId: 'retained-launcher-tab', regionId: 'retained-launcher-region', kind: 'launcher', agentSessionId: null, runId: null, execution: null },
      { tabId: 'native-launcher-tab', regionId: 'native-launcher-region', kind: 'launcher', agentSessionId: null, runId: null, execution: null }],
    layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('original-group', ['retained-tab', 'retained-launcher-tab', 'native-launcher-tab']) },
    tabLayouts: { 'retained-tab': createWorkbenchViewLayout('retained-region'), 'retained-launcher-tab': createWorkbenchViewLayout('retained-launcher-region'),
      'native-launcher-tab': createWorkbenchViewLayout('native-launcher-region') }, resources: {}
  } })
  const demands = openDemandStore({ root: join(stateDirectory, 'demands') })
  await demands.create({ id: 'retained-goal', title: 'An original Goal with a saved dedicated discussion', description: 'Keep its original context.', status: 'todo' })
  const before = await demands.get('retained-goal')
  expect(before?.discussionOperationId).toBeUndefined(); expect(before?.creationOrigin).toBeUndefined()
  const binding = { schema: 'agentmux.goal-discussion-binding.v1' as const, tabId: 'retained-tab', regionId: 'retained-region',
    recipient: { kind: 'agent' as const, hostId: 'local', agentSessionId: original.agentSessionId } }
  const ports = { spatial, goal: async (goalId: string) => (await phone.call('goal.inspect', { goalId })).goal,
    agent: async (hostId: string, sid: string) => {
      expect(hostId).toBe('local')
      const session = await core.readAgentSession(sid)
      if (session?.kind !== 'agent') throw Error('The exact private Agent fixture is unavailable')
      return session
    } }
  const acknowledged = await handoffGoalDiscussion({ goalId: 'retained-goal', binding }, ports)
  expect(acknowledged).toMatchObject({ diskDurability: 'confirmed', key: goalDiscussionBindingKey('retained-goal') })
  expect(await demands.get('retained-goal')).toEqual(before)
  fact({ phase: 'original-binding-acknowledged', goal: before, binding, key: acknowledged.key, revision: acknowledged.state.revision, diskDurability: acknowledged.diskDurability })
  const open = { goalId: 'retained-goal', mode: 'open' as const, operationId: 'inspect-original-binding' }
  expect((await phone.call('goal.discuss', open)).receipt).toMatchObject({ tabId: binding.tabId, regionId: binding.regionId, hostId: 'local', agentSessionId: original.agentSessionId })
  const cli = await promisify(execFile)(process.execPath, ['--experimental-transform-types', '--import', loader,
    resolve(import.meta.dirname, '../../../packages/core/src/agentmux.ts'), '--endpoint', 'unix:' + f.socketPath,
    'goal', 'discuss', '--goal', open.goalId, '--mode', 'open', '--operation-id', 'cli-original-binding'], { env: f.env })
  expect(JSON.parse(cli.stdout).result.receipt).toMatchObject({ tabId: binding.tabId, regionId: binding.regionId, hostId: 'local', agentSessionId: original.agentSessionId })
  const state = (await spatial.read())!, key = goalDiscussionBindingKey('retained-goal')
  await expect(spatial.commit({ expectedRevision: state.revision, graph: { ...state.graph,
    resources: { ...state.graph.resources, [key]: { ...binding, tabId: 'forged-tab' } } } })).rejects.toMatchObject({ code: 'SPATIAL_RESOURCE_AUTHORITY_CONFLICT' })
  const omitted = await spatial.commit({ expectedRevision: state.revision, graph: { ...state.graph, resources: {} } })
  expect(readGoalDiscussionBinding(omitted.graph, 'retained-goal')).toEqual(binding)
  const changed = structuredClone(omitted.graph); changed.regions[0]!.agentSessionId = 'a-later-region-occupant'
  const changedState = await spatial.commit({ expectedRevision: omitted.revision, graph: changed })
  await expect(phone.call('goal.discuss', open)).rejects.toMatchObject({ code: 'GOAL_DISCUSSION_UNCONFIRMED' })
  changed.regions[0]!.agentSessionId = original.agentSessionId; changed.regions[0]!.execution = { hostId: 'foreign', cwd: original.workspacePath }
  const foreign = await spatial.commit({ expectedRevision: changedState.revision, graph: changed })
  await expect(phone.call('goal.discuss', open)).rejects.toMatchObject({ code: 'GOAL_DISCUSSION_UNCONFIRMED' })
  await spatial.commit({ expectedRevision: foreign.revision, graph: omitted.graph })
  await phone.call('goal.discuss', { goalId: 'retained-goal', mode: 'grill', operationId: 'original-explicit-discussion-request' })
  const input = await core.inspectAgentPromptSubmission({ kind: 'prompt', agentSessionId: original.agentSessionId, expectedRun: original.run, submissionId: 'original-explicit-discussion-request' })
  expect(input?.admission?.acknowledged).toBe(true)
  const after = (await demands.get('retained-goal'))!
  expect(after.discussionOperationId).toBeUndefined(); expect(after.creationOrigin).toBeUndefined()
  expect(after.participations).toHaveLength(1); expect(after.supervisorSessionId).toBeNull()
  await demands.create({ id: 'retained-launcher-goal', title: 'An original Goal retaining its unfilled Launcher' })
  const launcherGoal = (await demands.get('retained-launcher-goal'))!
  const launcher = { schema: 'agentmux.goal-discussion-binding.v1' as const, tabId: 'retained-launcher-tab', regionId: 'retained-launcher-region', recipient: { kind: 'launcher' as const } }
  await handoffGoalDiscussion({ goalId: launcherGoal.id, binding: launcher }, ports)
  const launcherOpen = { goalId: launcherGoal.id, mode: 'open' as const, operationId: 'original-launcher-open' }
  expect((await phone.call('goal.discuss', launcherOpen)).receipt).toMatchObject({ tabId: launcher.tabId, regionId: launcher.regionId, hostId: null, agentSessionId: null })
  const explicitOperation = 'original-launcher-explicit-agent'
  const explicit = await phone.call('agent.open', { operationId: explicitOperation, content: { kind: 'new-agent', executorId: 'codex' },
    destination: { spaceId, zoneId, tabId: launcher.tabId, regionId: launcher.regionId }, focus: false })
  expect(explicit.outcome).toBe('opened')
  const filled = (await core.readAgentSession(explicit.agent!.agentSessionId))!
  const explicitRecord = spatialAgentOpenRecord((await spatial.read())!.graph, explicitOperation)!
  expect(explicitRecord).toMatchObject({ agentSessionId: filled.agentSessionId, address: { tabId: launcher.tabId, regionId: launcher.regionId }, execution: { hostId: 'local' } })
  expect((await core.inspectAgentCreation(filled.agentSessionId)).creation).toMatchObject({ createOperationId: explicitOperation, createdRun: filled.run })
  fact({ phase: 'original-launcher-explicit-creation', goalId: launcherGoal.id, originalBinding: launcher, session: filled, record: explicitRecord })
  await expect(phone.call('goal.discuss', launcherOpen).then(() => { throw Error('Private original upgrade reply withheld after its actual producer completed') }))
    .rejects.toThrow('Private original upgrade reply withheld')
  const afterUpgrade = (await new AgentMuxSpatialStateStore(spatial.path).read())!
  const filledBinding = { ...launcher, recipient: { kind: 'agent' as const, hostId: 'local', agentSessionId: filled.agentSessionId } }
  expect(readGoalDiscussionBinding(afterUpgrade.graph, launcherGoal.id)).toEqual(filledBinding)
  const reconfirmed = await handoffGoalDiscussion({ goalId: launcherGoal.id, binding: filledBinding }, ports)
  expect(reconfirmed.diskDurability).toBe('confirmed'); expect(reconfirmed.state.revision).toBeGreaterThan(afterUpgrade.revision)
  expect(await demands.get(launcherGoal.id)).toEqual(launcherGoal)
  await ready(core, filled, 'the explicitly filled original Launcher has its Provider input readiness')
  await phone.call('goal.discuss', { goalId: launcherGoal.id, mode: 'grill', operationId: 'original-filled-launcher-request' })
  expect((await core.inspectAgentPromptSubmission({ kind: 'prompt', agentSessionId: filled.agentSessionId, expectedRun: filled.run, submissionId: 'original-filled-launcher-request' }))?.admission?.acknowledged).toBe(true)
  expect((await demands.get(launcherGoal.id))?.discussionOperationId).toBeUndefined()
  expect((await demands.get(launcherGoal.id))?.creationOrigin).toBeUndefined()
  await demands.create({ id: 'native-launcher-goal', title: 'Retain native creation before the owned placement write' })
  const nativeGoal = (await demands.get('native-launcher-goal'))!
  const nativeLauncher = { schema: 'agentmux.goal-discussion-binding.v1' as const, tabId: 'native-launcher-tab', regionId: 'native-launcher-region', recipient: { kind: 'launcher' as const } }
  await handoffGoalDiscussion({ goalId: nativeGoal.id, binding: nativeLauncher }, ports)
  const nativeWorkspace = { id: 'native-execution', name: 'Explicit native execution Workspace', hostId: 'local', path: join(f.root, 'execution'), kind: 'folder' as const }
  await mkdir(nativeWorkspace.path)
  configuration.workspaces.push(nativeWorkspace); await writeFile(configurationPath, JSON.stringify(configuration))
  const nativeInput = { launcher: { tabId: nativeLauncher.tabId, regionId: nativeLauncher.regionId }, executionWorkspaceId: nativeWorkspace.id,
    executorId: 'codex', hostId: 'local', workspacePath: nativeWorkspace.path, agentSessionId: 'native-launcher-session',
    createOperationId: 'native-launcher-creation', prompt: 'Original native Launcher input, delivered once.' }
  const captured = await captureGoalDiscussionLauncherLaunch(nativeInput, { spatial, workspaces: configuration.workspaces })
  expect(captured).toMatchObject({ agentSessionId: nativeInput.agentSessionId, workspaceId: nativeWorkspace.id })
  // This trusted SDK producer is the same Core boundary used by Main's native creator.
  // Actual Renderer -> registered Main -> Runtime argument forwarding is covered separately.
  const nativeCreated = await core.createAgentWithDelivery({ providerId: 'codex', executorId: 'codex', workspacePath: nativeInput.workspacePath,
    agentSessionId: nativeInput.agentSessionId, createOperationId: nativeInput.createOperationId, prompt: nativeInput.prompt,
    spatialIntent: launcherCreationSpatialIntent(nativeInput, configuration.workspaces), commandOverride: command, injectAgentMuxGuide: false,
    env: { AGENTMUX_FAKE_READY_MODE: 'before', AGENTMUX_FAKE_NATIVE_RECORD: '1' } })
  expect(nativeCreated.creation).toMatchObject({ createOperationId: nativeInput.createOperationId, initialPrompt: 'confirmed', createdRun: nativeCreated.session.run,
    spatialIntent: { ...nativeInput.launcher, executionWorkspaceId: nativeWorkspace.id } })
  const nativeRuns = (await core.listRuns()).filter(run => run.agentSessionId === nativeCreated.session.agentSessionId)
  expect(nativeRuns.map(run => run.runId)).toEqual([nativeCreated.session.run.runId])
  const ownedWrite = AgentMuxSpatialStateStore.prototype.commitOwnedResource
  let refusedBeforeWrite = false
  const refusing = vi.spyOn(AgentMuxSpatialStateStore.prototype, 'commitOwnedResource').mockImplementation(async function (input) {
    if (input.agentRegion) { refusedBeforeWrite = true; throw Error('Private original owned placement write refused before application') }
    return ownedWrite.call(this, input)
  })
  try {
    await expect(confirmGoalDiscussionLauncherLaunch(captured, { created: nativeCreated.session, creation: nativeCreated.creation, projectionFailures: [] }, ports))
      .rejects.toThrow('Private original owned placement write refused before application')
  } finally { refusing.mockRestore() }
  expect(refusedBeforeWrite).toBe(true)
  const unplaced = (await new AgentMuxSpatialStateStore(spatial.path).read())!
  expect(readGoalDiscussionBinding(unplaced.graph, nativeGoal.id)).toEqual(nativeLauncher)
  expect(unplaced.graph.regions.find(region => region.regionId === nativeLauncher.regionId)).toMatchObject({ kind: 'launcher', agentSessionId: null })
  expect(spatialAgentOpenRecord(unplaced.graph, nativeInput.createOperationId)).toBeNull()
  fact({ phase: 'native-created-before-owned-write', original: nativeLauncher, created: nativeCreated.session,
    creation: nativeCreated.creation, refusedBeforeWrite, actualNativeRuns: nativeRuns.map(run => run.runId) })
  const freshGoal = await phone.call('goal.create', { goalId: 'new-canonical-goal', title: 'A new discussion uses the same owner', operationId: 'new-canonical-goal-create', risk: 'low', confirmation: 'user' })
  const discussed = await phone.call('goal.discuss', { goalId: freshGoal.goal.id, mode: 'grill', operationId: 'new-canonical-discussion' })
  const newBinding = readGoalDiscussionBinding((await spatial.read())!.graph, freshGoal.goal.id)!
  expect(newBinding).toMatchObject({ tabId: discussed.receipt.tabId, regionId: discussed.receipt.regionId,
    recipient: { kind: 'agent', hostId: discussed.receipt.hostId, agentSessionId: discussed.receipt.agentSessionId } })
  const creation = await core.inspectAgentCreation(discussed.receipt.agentSessionId!)
  expect(creation.creation).toMatchObject({ createOperationId: freshGoal.goal.discussionOperationId, initialPrompt: 'confirmed', createdRun: expect.objectContaining({ runId: expect.any(String) }) })
  expect(spatialAgentOpenRecord((await spatial.read())!.graph, freshGoal.goal.discussionOperationId!)?.agentSessionId).toBe(discussed.receipt.agentSessionId)
  const owner = f.owner.ownerInstanceId
  await phone.dispose(); await core.dispose()
  await f.restart()
  expect(f.owner.ownerInstanceId).not.toBe(owner)
  const reconnected = await relay()
  expect((await reconnected.call('goal.discuss', open)).receipt).toMatchObject({ tabId: binding.tabId, regionId: binding.regionId, hostId: 'local', agentSessionId: original.agentSessionId })
  expect((await reconnected.call('goal.discuss', launcherOpen)).receipt).toMatchObject({ tabId: launcher.tabId, regionId: launcher.regionId, hostId: 'local', agentSessionId: filled.agentSessionId })
  expect((await reconnected.call('goal.discuss', { goalId: freshGoal.goal.id, mode: 'open', operationId: 'new-canonical-reopen' })).receipt).toMatchObject({ tabId: newBinding.tabId, regionId: newBinding.regionId, agentSessionId: discussed.receipt.agentSessionId })
  const recovered = await f.client()
  const nativeOpen = { goalId: nativeGoal.id, mode: 'open' as const, operationId: 'native-launcher-reopen' }
  expect((await reconnected.call('goal.discuss', nativeOpen)).receipt).toMatchObject({ tabId: nativeLauncher.tabId, regionId: nativeLauncher.regionId,
    hostId: 'local', agentSessionId: nativeCreated.session.agentSessionId })
  const nativeRecovered = (await recovered.readAgentSession(nativeCreated.session.agentSessionId))!
  expect(nativeRecovered.run).toEqual(nativeCreated.session.run)
  expect(nativeRecovered.creation).toEqual(nativeCreated.creation)
  expect((await recovered.listRuns()).filter(run => run.agentSessionId === nativeCreated.session.agentSessionId).map(run => run.runId)).toEqual(nativeRuns.map(run => run.runId))
  expect(readGoalDiscussionBinding((await spatial.read())!.graph, nativeGoal.id)?.recipient).toEqual({ kind: 'agent', hostId: 'local', agentSessionId: nativeCreated.session.agentSessionId })
  expect(spatialAgentOpenRecord((await spatial.read())!.graph, nativeInput.createOperationId)).toBeNull()
  expect((await recovered.sessionTimeline(nativeCreated.session.agentSessionId)).items.filter(item => item.kind === 'user_message' && item.content === nativeInput.prompt)).toHaveLength(1)
  await ready(recovered, nativeCreated.session, 'the retained native Launcher Run has Provider input readiness after owner restart')
  await reconnected.call('goal.discuss', { goalId: nativeGoal.id, mode: 'grill', operationId: 'native-launcher-explicit-request' })
  expect((await recovered.inspectAgentPromptSubmission({ kind: 'prompt', agentSessionId: nativeCreated.session.agentSessionId,
    expectedRun: nativeCreated.session.run, submissionId: 'native-launcher-explicit-request' }))?.admission?.acknowledged).toBe(true)
  expect((await recovered.sessionTimeline(nativeCreated.session.agentSessionId)).items.filter(item => item.kind === 'user_message' && item.id === 'prompt:native-launcher-explicit-request')).toHaveLength(1)
  expect((await recovered.sessionTimeline(nativeCreated.session.agentSessionId)).items.filter(item => item.kind === 'user_message' && item.content === nativeInput.prompt)).toHaveLength(1)
  expect((await recovered.listRuns()).filter(run => run.agentSessionId === nativeCreated.session.agentSessionId).map(run => run.runId)).toEqual(nativeRuns.map(run => run.runId))
  expect((await demands.get(nativeGoal.id))?.discussionOperationId).toBeUndefined()
  expect((await demands.get(nativeGoal.id))?.creationOrigin).toBeUndefined()
  expect((await recovered.readAgentSession(original.agentSessionId))!.run).toEqual(original.run)
  expect((await recovered.readAgentSession(filled.agentSessionId))!.run).toEqual(filled.run)
  expect((await recovered.sessionTimeline(original.agentSessionId)).items.filter(item => item.kind === 'user_message' && item.id === 'prompt:original-explicit-discussion-request')).toHaveLength(1)
  expect((await recovered.sessionTimeline(filled.agentSessionId)).items.filter(item => item.kind === 'user_message' && item.id === 'prompt:original-filled-launcher-request')).toHaveLength(1)
  fact({ scope: 'private Source Host, official ctxmux, public Unix CLI and encrypted Relay; Desktop trusted IPC is covered separately', originalRun: original.run,
    oldGoal: before, retainedBinding: binding, launcher: { original: launcher, filled: filledBinding, explicitRecord, durableReconfirmation: reconfirmed.diskDurability },
    nativeLauncher: { original: nativeLauncher, creation: nativeCreated.creation, refusedBeforeWrite, recovered: nativeRecovered, actualNativeRuns: nativeRuns.map(run => run.runId) },
    newBinding, creation: creation.creation, ownerBefore: owner, ownerAfter: f.owner.ownerInstanceId, inputAcknowledged: input?.admission?.acknowledged })
}, 90_000)
