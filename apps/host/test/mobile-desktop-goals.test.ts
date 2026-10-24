import { readDesktopGoals, confirmDesktopGoalParticipation } from '../../desktop/src/main/desktop-goals.js'
import { afterEach, expect, it } from 'vitest'
import { join } from 'node:path'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { mobileWebFixture } from './helpers/mobile-web-fixture.js'
import { until } from '../../../packages/core/test/helpers/headless-runtime-fixture.js'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client.js'
import { runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { ScratchTopics } from '../src/mote-resources.js'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/mote-topic-model.js'
import { AgentMuxSpatialStateStore, spatialAgentOpenRecord } from '../../../packages/core/src/spatial-state.js'
import { createWorkspaceLayout, createWorkbenchViewLayout } from '../../../packages/core/src/spatial-layout.js'
import { openDemandStore } from '@agentmux/demand'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

it('the same original Goal and real continuation survive Desktop exit and Host restart without duplicate input', async () => {
  const f = await mobileWebFixture({ nativeRecord: true }); cleanup.push(f.close)
  const main = await f.startMain(), desktop = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: main.path } }); cleanup.push(() => desktop.dispose())
  const invalidations: string[][] = []
  const watch = await desktop.subscribe('goal.watch', {}, { onInitial: value => { invalidations.push(value.goalIds) }, onEvent: event => { if (event.type === 'change') invalidations.push(event.data.goalIds) } }); cleanup.push(() => watch.dispose())
  const goalId = 'original-mobile-goal', sessionId = f.session.agentSessionId
  const target = { hostId: 'local', agentSessionId: sessionId, providerId: f.session.providerId, workspacePath: f.session.workspacePath }
  const create = await desktop.call('goal.create', { goalId, title: 'Original authorized Goal', description: 'Preserve original work and report observed results.',
    assigneeSessionIds: [sessionId], supervisorSessionId: sessionId, operationId: 'original-goal-create', risk: 'low', confirmation: 'user' }).then(value => ({ value }), error => ({ error: { code: error.code, message: error.message } }))
  expect(create).toMatchObject({ value: { goal: { id: goalId, assigneeSessionIds: [sessionId] } } })
  expect(await readDesktopGoals({ callOriginalCore: (_hostId, method, params) => desktop.call(method, params) })).toMatchObject([{ id: goalId, parentDemandId: null, activities: [], decisions: [{ question: 'Original authorized Goal' }] }])
  const creation = (await f.client.inspectAgentCreation(sessionId)).creation!
  expect(creation.createdRun).toEqual(f.session.run)
  const provenance = { goalId, hostId: 'local', agentSessionId: sessionId, expectedRun: f.session.run, evidence: 'creation-input' as const, operationId: creation.createOperationId }
  const participation = await confirmDesktopGoalParticipation({ callOriginalCore: (_hostId, method, params) => desktop.call(method, params) }, provenance)
    .then(value => ({ value }), error => ({ error: { code: error.code, message: error.message } }))
  expect(creation.initialPrompt).toBe('not-requested')
  expect(participation).toMatchObject({ error: { code: 'CONTROL_UNAVAILABLE' } })
  expect((await desktop.call('goal.inspect', { goalId })).goal.participations).toEqual([])
  await until(() => invalidations, values => values.some(ids => ids.includes(goalId)), 'actual original Goal invalidation')
  const arrangement = await desktop.call('schedule.create', { target, afterMs: 3_600_000, prompt: 'Original authorized future message.', operationId: 'original-future-message' })
  await f.stopMain()
  const phone = await f.relay()
  const aligned = await phone.call('goal.update', { goalId, patch: { alignment: { summary: 'Preserve the authorized original work.', criteria: [{ id: 'original-criterion', text: 'Original Goal, Session and execution remain observable.' }], openQuestions: [] } }, operationId: 'original-goal-alignment' })
  expect(aligned.goal.alignment).toBeTruthy()
  await phone.call('goal.confirm', { goalId, expectedRevision: aligned.goal.alignment!.revision, operationId: 'original-goal-confirm' })
  await until(() => f.client.statusAgent(sessionId), value => value.observation.readiness === 'ready' && value.observation.semantic === 'idle' && value.session.semanticStatus?.state === 'done', 'original completed Agent turn')
  const start = await phone.call('goal.start', { goalId, sessionId, continuation: { intervalMs: 300, alignmentRevision: aligned.goal.alignment!.revision }, operationId: 'original-goal-start' }).then(value => ({ value }), error => ({ error: { code: error.code, message: error.message } }))
  expect(start, JSON.stringify(start)).toMatchObject({ value: { goal: { id: goalId, dispatches: [{ operationId: 'original-goal-start', stage: 'confirmed' }] }, continuation: { initialDelivery: { state: 'confirmed' }, status: 'active' } } })
  let observed = await phone.call('goal.inspect', { goalId })
  for (let n = 0; n < 250 && observed.goalContinuations[0]?.lastOutcome !== 'sent'; n++) {
    await new Promise(resolve => setTimeout(resolve, 100)); observed = await phone.call('goal.inspect', { goalId })
  }
  expect(observed.goalContinuations[0]?.lastOutcome, JSON.stringify(observed)).toBe('sent')
  const original = await f.native.client()
  const timeline = await original.sessionTimeline(sessionId)
  expect(timeline.items.filter(item => item.kind === 'user_message' && item.id === 'prompt:original-goal-start')).toHaveLength(1)
  expect(timeline.items.some(item => item.kind === 'user_message' && item.content.includes('Continue the original Goal ' + goalId))).toBe(true)
  const owner = (await phone.call('runtime.owner.identity', {})).owner
  const pause = { agentSessionId: sessionId, expectedRun: f.session.run, ownerInstanceId: owner.ownerInstanceId, operationId: 'original-user-input-intent' }
  expect(await phone.call('agent.automation.pause', pause)).toMatchObject({ receipt: { status: 'confirmed', pausedLoopIds: expect.arrayContaining([observed.goalContinuations[0]!.loopId, arrangement.schedule.loopId]), disabledIntentIds: expect.arrayContaining([arrangement.schedule.futureIntentId!]) } })
  expect((await phone.call('goal.inspect', { goalId })).goalContinuations[0]?.status).toBe('paused')
  expect((await original.readAgentFuturePromptIntent(sessionId, arrangement.schedule.futureIntentId!))?.active).toBe(false)
  const stateDirectory = f.native.env.AGENTMUX_STATE_DIRECTORY!, configurationPath = join(stateDirectory, 'original-configuration.json')
  const config = JSON.parse(await readFile(configurationPath, 'utf8')), scratch = join(f.native.root, 'scratch')
  await mkdir(scratch)
  config.workspaces.push({ id: SCRATCH_WORKSPACE_ID, name: 'Original Mote Workspace', hostId: 'local', kind: 'folder', path: scratch })
  config.executors.codex = { ...config.executors.codex, command: join(f.native.root, 'managed.mjs'), args: [], env: { AGENTMUX_FAKE_READY_MODE: 'before', AGENTMUX_FAKE_NATIVE_RECORD: '1' }, injectAgentMuxGuide: false }
  await writeFile(configurationPath, JSON.stringify(config))
  const mote = await new ScratchTopics().ensure({ id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: scratch }, PMO_TEAMS_TOPIC_ID)
  const spaceId = JSON.stringify(['local', mote.physicalDirectoryPath]), zoneId = 'original-mote-home'
  const spatial = new AgentMuxSpatialStateStore(join(stateDirectory, 'spatial-state.json'))
  await spatial.commit({ expectedRevision: 0, graph: {
    spaces: [{ spaceId, kind: 'mote', topicId: PMO_TEAMS_TOPIC_ID, name: 'Original primary Mote', hostId: 'local', directoryPath: mote.physicalDirectoryPath!, projectId: null }],
    zones: [{ zoneId, workspaceId: SCRATCH_WORKSPACE_ID, kind: 'home', hostId: 'local', directoryPath: mote.physicalDirectoryPath!, branch: null }],
    bindings: [{ spaceId, zoneId }], tabs: [{ tabId: 'original-mote-tab', zoneId, workspaceId: SCRATCH_WORKSPACE_ID, name: 'Original launcher', regionIds: ['original-mote-launcher'] }],
    regions: [{ tabId: 'original-mote-tab', regionId: 'original-mote-launcher', kind: 'launcher', agentSessionId: null, runId: null, execution: null }],
    layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('original-mote-group', ['original-mote-tab']) }, tabLayouts: { 'original-mote-tab': createWorkbenchViewLayout('original-mote-launcher') }, resources: {}
  } })
  const discussionGoal = await phone.call('goal.create', { goalId: 'original-discussion-goal', title: 'A new original discussion', description: 'Keep one dedicated original context.', operationId: 'original-discussion-create', risk: 'low', confirmation: 'user' })
  expect(discussionGoal.goal.discussionOperationId).toMatch(/^goal_pmo_create_/)
  // Freeze the original business intent before any Core spatial creation, then
  // challenge its real public creator with another valid launcher placement.
  const originalDemands = openDemandStore({ root: join(stateDirectory, 'demands') })
  const discussionId = discussionGoal.goal.discussionOperationId!, discussionRequestId = 'original-discussion-request'
  const frozen = { requestOperationId: discussionRequestId, mode: 'grill' as const, executorId: 'codex', spaceId, zoneId, agentMuxNote: 'Original Goal platform context.', prompt: 'Clarify this existing Goal.' }
  await originalDemands.prepareDiscussion(discussionGoal.goal.id, discussionId, frozen, discussionGoal.goal.updatedAt)
  const spatialBeforeWrong = await spatial.read()
  const wrong = await phone.call('agent.open', { operationId: discussionId, content: { kind: 'new-agent', executorId: 'codex', prompt: frozen.prompt }, destination: { spaceId, zoneId, tabId: 'original-mote-tab', regionId: 'original-mote-launcher' }, focus: false })
    .then(value => ({ value }), error => ({ error: { code: error.code } }))
  expect(wrong).toMatchObject({ error: { code: 'CONTROL_REQUEST_CONFLICT' } })
  expect(await spatial.read()).toEqual(spatialBeforeWrong)
  const discussionInput = { goalId: discussionGoal.goal.id, mode: 'grill' as const, executorId: 'codex', operationId: discussionRequestId }
  const discussed = await phone.call('goal.discuss', discussionInput).then(value => ({ value }), error => ({ error: { code: error.code, message: error.message } }))
  expect(discussed, JSON.stringify(discussed)).toMatchObject({ value: { receipt: { mode: 'grill', agentSessionId: expect.any(String) }, goal: { supervisorSessionId: expect.any(String), creationOrigin: { supervisorDefaultPending: false } } } })
  const discussionSessionId = discussed.value!.receipt.agentSessionId!
  const discussionSession = await original.readAgentSession(discussionSessionId)
  cleanup.push(async () => { const client = await f.native.client(); await client.stopAgent(discussionSessionId, (await client.readAgentSession(discussionSessionId))!.run) })
  expect(discussionSession!.creation).toMatchObject({ createOperationId: discussionId, initialPrompt: 'confirmed', createdRun: discussionSession!.run })
  expect(discussed.value!.goal.supervisorSessionId).toBe(discussionSessionId)
  await expect(phone.call('goal.discuss', { ...discussionInput, mode: 'grounding' })).rejects.toMatchObject({ code: 'CONTROL_REQUEST_CONFLICT' })
  const patrol = await phone.call('goal.patrol.all', { operationId: 'original-global-patrol' })
  expect(patrol).toMatchObject({ outcome: 'opened', agent: { agentSessionId: expect.any(String), createOperationId: 'original-global-patrol' }, save: { diskDurability: 'confirmed' } })
  const patrolSessionId = patrol.agent!.agentSessionId
  cleanup.push(async () => { const client = await f.native.client(); await client.stopAgent(patrolSessionId, (await client.readAgentSession(patrolSessionId))!.run) })
  expect((await spatial.read())!.graph.regions.find(region => region.regionId === 'original-mote-launcher')!.kind).toBe('launcher')
  const nextGoal = await phone.call('goal.create', { goalId: 'another-original-discussion-goal', title: 'Another real Goal discussion', operationId: 'another-original-discussion-create', risk: 'low', confirmation: 'user' })
  const nextInput = { goalId: nextGoal.goal.id, mode: 'grill' as const, operationId: 'another-original-discussion-request' }
  const nextDiscussion = await phone.call('goal.discuss', nextInput)
  expect(nextDiscussion.goal.supervisorSessionId).toBe(nextDiscussion.receipt.agentSessionId)
  const nextSessionId = nextDiscussion.receipt.agentSessionId!
  cleanup.push(async () => { const client = await f.native.client(); await client.stopAgent(nextSessionId, (await client.readAgentSession(nextSessionId))!.run) })
  expect((await originalDemands.get(nextGoal.goal.id))!.discussionIntent).toMatchObject({ mode: 'grill', executorId: 'codex', requestOperationId: nextInput.operationId, agentMuxNote: expect.stringContaining('Original Goal facts:') })
  const managed = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: f.native.socketPath }, credentials: { agentSessionId: sessionId, capability: f.managedEnv.AGENTMUX_AGENT_CAPABILITY } }); cleanup.push(() => managed.dispose())
  const managedGoal = await managed.call('goal.create', { goalId: 'managed-original-discussion-goal', title: 'Original creator delegated discussion', operationId: 'managed-original-goal-create', risk: 'low', confirmation: 'user' })
  expect(managedGoal.goal.supervisorSessionId).toBe(sessionId)
  const managedDiscussion = await managed.call('goal.discuss', { goalId: managedGoal.goal.id, mode: 'grill', operationId: 'managed-original-discussion-request' })
    .then(value => ({ value }), error => ({ error: { code: error.code, message: error.message } }))
  expect(managedDiscussion, JSON.stringify(managedDiscussion)).toMatchObject({ value: { goal: { supervisorSessionId: sessionId }, receipt: { agentSessionId: expect.any(String) } } })
  const managedChildId = managedDiscussion.value!.receipt.agentSessionId!
  cleanup.push(async () => { const client = await f.native.client(); await client.stopAgent(managedChildId, (await client.readAgentSession(managedChildId))!.run) })
  expect((await original.inspectAgentCreation(managedChildId)).creation?.createdBy).toMatchObject({ agentSessionId: sessionId, run: f.session.run, owner: { kind: 'local' } })
  await until(() => original.statusAgent(managedChildId), value => value.observation.readiness === 'ready' && value.observation.semantic === 'idle' && value.session.semanticStatus?.state === 'done', 'the original discussion completes its first turn before a new results request')
  const managedFurtherInput = { goalId: managedGoal.goal.id, mode: 'grounding' as const, operationId: 'managed-original-followup' }
  const managedFurther = await managed.call('goal.discuss', managedFurtherInput).then(value => ({ value }), error => ({ error: { code: error.code, message: error.message } }))
  const message = await original.readMessage({ operationId: managedFurtherInput.operationId })
  expect(message, JSON.stringify(managedFurther)).toBeTruthy()
  expect(managedFurther.error?.code ?? 'confirmed').toBeOneOf(['confirmed', 'GOAL_DISCUSSION_UNCONFIRMED'])
  expect(message?.envelope).toMatchObject({ senderSessionId: sessionId, senderRunId: f.session.run.runId, recipientSessionId: managedChildId, messageId: expect.any(String), operationId: managedFurtherInput.operationId })
  const managedChild = (await original.readAgentSession(managedChildId))!
  const messageInput = { kind: 'message' as const, agentSessionId: managedChildId, expectedRun: managedChild.run, messageId: message!.envelope.messageId }
  const messageAdmission = await until(() => original.inspectAgentPromptSubmission(messageInput), value => value?.admission?.acknowledged === true, 'the original managed message receives its own Core acknowledgement without another dispatch')
  expect(messageAdmission?.admission?.intent?.message?.authorAgentSessionId).toBe(sessionId)
  expect(await original.inspectAgentPromptSubmission({ kind: 'prompt', agentSessionId: managedChildId, expectedRun: managedChild.run, submissionId: managedFurtherInput.operationId })).toBeNull()
  const confirmedFurther = await managed.call('goal.discuss', managedFurtherInput)
  expect(confirmedFurther).toMatchObject({ receipt: { agentSessionId: managedChildId }, goal: { supervisorSessionId: sessionId } })
  expect((await managed.call('goal.discuss', managedFurtherInput)).receipt).toEqual(confirmedFurther.receipt)
  expect((await original.readMessage({ operationId: managedFurtherInput.operationId }))?.sequence).toBe(message?.sequence)
  const progressTarget = { ...target, agentSessionId: managedChildId, workspacePath: managedChild.workspacePath }
  const marker = join(f.native.root, 'unauthorized-script-marker'), readerPath = join(f.native.root, 'original-task-reader.sh')
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
  await writeFile(readerPath, 'printf unsafe > ' + quote(marker) + "\nprintf '{}\n'\n")
  const scriptInput = { target: progressTarget, intervalMs: 60_000, prompt: 'Original proposed progress.', operationId: 'managed-unauthorized-script', taskSource: { kind: 'feature' as const, root: f.native.root, ownerId: 'original-feature', readerPath } }
  const script = await managed.call('agent.progress.create', scriptInput).then(value => ({ value }), error => ({ error: { code: error.code } }))
  if (script.value) await managed.call('agent.progress.action', { target: progressTarget, loopId: script.value.loop.loopId, action: 'check', operationId: 'managed-unauthorized-script-check', expectedLoop: script.value.loop }).catch(() => {})
  expect(await access(marker).then(() => true, () => false)).toBe(false)
  expect(script).toMatchObject({ error: { code: 'CONTROL_PERMISSION_DENIED' } })
  const ordinaryAgentProgress = await managed.call('agent.progress.create', { target: progressTarget, intervalMs: 60_000, prompt: 'Original proposed progress.', operationId: 'managed-unauthorized-platform-input' }).then(value => ({ value }), error => ({ error: { code: error.code } }))
  expect(ordinaryAgentProgress).toMatchObject({ error: { code: 'CONTROL_PERMISSION_DENIED' } })
  const arranged = await phone.call('agent.progress.create', { target: progressTarget, intervalMs: 60_000, prompt: 'Original person arrangement.', operationId: 'original-person-arrangement' })
  const arrangedPause = await phone.call('agent.progress.action', { target: progressTarget, loopId: arranged.loop.loopId, action: 'pause', expectedLoop: arranged.loop, operationId: 'pause-original-person-arrangement' })
  for (const action of ['resume', 'check'] as const) await expect(managed.call('agent.progress.action', { target: progressTarget, loopId: arranged.loop.loopId, action, expectedLoop: arrangedPause.loop, operationId: 'managed-unauthorized-' + action })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  const cancelled = await managed.call('agent.progress.action', { target: progressTarget, loopId: arranged.loop.loopId, action: 'stop', expectedLoop: arrangedPause.loop, operationId: 'managed-cancel-original-arrangement' })
  expect(cancelled.loop.status).toBe('stopped')




  const before = (await original.sessionTimeline(sessionId)).items.filter(item => item.kind === 'user_message')
  await f.native.restart()
  const fresh = await f.relay()
  const originalDiscussion = await fresh.call('goal.discuss', discussionInput)
  expect(originalDiscussion.receipt).toEqual(discussed.value!.receipt)
  expect(spatialAgentOpenRecord((await spatial.read())!.graph, discussionId)?.agentSessionId).toBe(discussionSessionId)
  expect((await fresh.call('goal.patrol.all', { operationId: 'original-global-patrol' })).agent?.agentSessionId).toBe(patrolSessionId)
  expect((await (await f.native.client()).readAgentSessions()).filter(value => [discussionId, nextGoal.goal.discussionOperationId!, 'original-global-patrol'].includes(value.creation?.createOperationId ?? ''))).toHaveLength(3)
  const retained = await fresh.call('goal.inspect', { goalId })
  expect(retained.goal?.id).toBe(goalId); expect(retained.goalContinuations[0]?.status).toBe('paused')
  expect((await fresh.call('agent.automation.inspect', pause)).receipt).toBeNull()
  const replay = await fresh.call('goal.start', { goalId, sessionId, continuation: { intervalMs: 300, alignmentRevision: aligned.goal.alignment!.revision }, operationId: 'original-goal-start' })
  expect(replay.goal.dispatches?.[0]?.stage).toBe('confirmed')
  const reconnected = await f.native.client()
  expect((await reconnected.readAgentSession(sessionId))!.run).toEqual(f.session.run)
  expect((await reconnected.sessionTimeline(sessionId)).items.filter(item => item.kind === 'user_message')).toEqual(before)
  const goalLoop = retained.goalContinuations[0]!
  await fresh.call('goal.continuation-action', { goalId, loopId: goalLoop.loopId, action: 'stop', expectedRevision: goalLoop.revision!, operationId: 'stop-original-goal-loop' })
  expect((await fresh.call('schedule.inspect', { scheduleId: arrangement.schedule.loopId })).schedule?.status).toBe('paused')
  const generic = await fresh.call('agent.progress.create', { target, intervalMs: 60_000, prompt: 'Continue only the authorized original work.', operationId: 'original-ordinary-progress' })
  const paused = await fresh.call('agent.progress.action', { target, loopId: generic.loop.loopId, action: 'pause', operationId: 'pause-original-ordinary-progress', expectedLoop: { ...generic.loop, lastDecision: 'Different human-facing explanation must not change authority.' } })
  expect(paused.loop.status).toBe('paused'); expect(paused.loop.revision).toBe(generic.loop.revision); expect(paused.loop.lastMutation).toBeUndefined()
  const repeated = await fresh.call('agent.progress.action', { target, loopId: generic.loop.loopId, action: 'pause', operationId: 'pause-original-ordinary-progress', expectedLoop: { ...generic.loop, lastDecision: 'Different human-facing explanation must not change authority.' } })
  expect(repeated.loop).toEqual(paused.loop)
  const decisions = await fresh.call('goal.decisions', { goalId })
  expect(decisions.decisions).toMatchObject([{ id: 'routing:original-goal-create', question: 'Original authorized Goal' }])
  const confirmedInput = { goalId, hostId: 'local', agentSessionId: sessionId, expectedRun: f.session.run, evidence: 'prompt-input' as const, operationId: 'original-goal-start' }
  const confirmingSource = fresh.call('goal.participation.confirm', confirmedInput)
  await expect(confirmingSource).resolves.toMatchObject({ diskDurability: 'confirmed' })
  const confirmedSource = await confirmingSource
  expect(confirmedSource).toMatchObject({ operationId: confirmedInput.operationId, diskDurability: 'confirmed' })
  expect((await fresh.call('goal.participation.confirm', confirmedInput)).goal.participations).toEqual(confirmedSource.goal.participations)
  await expect(fresh.call('goal.participation.confirm', { ...confirmedInput, expectedRun: { runId: 'another-run' } })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  const cli = await runCompiledObjectCli(['--endpoint', 'unix:' + f.native.socketPath, 'goal', 'inspect', '--goal', goalId], f.native.env)
  expect(cli.code, cli.stderr).toBe(0); expect(cli.stdout).toContain(goalId)
  const automationCli = await runCompiledObjectCli(['--endpoint', 'unix:' + f.native.socketPath, 'agent', 'automation', 'inspect', '--session', sessionId, '--run', f.session.run.runId, '--owner', pause.ownerInstanceId, '--operation-id', pause.operationId], f.native.env)
  expect(automationCli.code, automationCli.stderr).toBe(0); expect(JSON.parse(automationCli.stdout).result.receipt).toBeNull()
  const query = join(f.native.root, 'original-progress-query.json'); await writeFile(query, JSON.stringify({ target }))
  const progressCli = await runCompiledObjectCli(['--endpoint', 'unix:' + f.native.socketPath, 'agent', 'progress', 'list', '--data', query], f.native.env)
  expect(progressCli.code, progressCli.stderr).toBe(0); expect(progressCli.stdout).toContain(generic.loop.loopId)
  const participationInput = join(f.native.root, 'original-participation-query.json'); await writeFile(participationInput, JSON.stringify(confirmedInput))
  const participationCli = await runCompiledObjectCli(['--endpoint', 'unix:' + f.native.socketPath, 'goal', 'participation', 'confirm', '--data', participationInput], f.native.env)
  expect(participationCli.code, participationCli.stderr).toBe(0); expect(JSON.parse(participationCli.stdout).result.operationId).toBe(confirmedInput.operationId)
  const originalStore = JSON.parse(await readFile(join(f.native.env.AGENTMUX_STATE_DIRECTORY!, 'demands', 'store.json'), 'utf8'))
  expect(JSON.stringify(originalStore)).toContain('original-goal-start')
}, 150_000)
