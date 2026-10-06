import { fixtureEpoch as _reshape_fixtureEpoch } from "../../../test/fixture-values.mjs"
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { AgentMuxClient, AgentMuxMemoryAgentSessionStore } from '@agentmux/core'
import { openDemandStore } from '@agentmux/demand'
import { GoalStartResponsibilityOwner, type GoalStartRuntimePort } from '../src/main/goal-start-responsibility'

it('keeps the actual legacy Session-owner admission without a source key unknown and preserves its original receipt, data and healthy Run', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'goal-start-legacy-'))
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime')); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state')); vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.sqlite'))
  const sessions = new AgentMuxMemoryAgentSessionStore(), demands = openDemandStore({ root: join(root, 'goals') })
  const original = { kind: 'agent' as const, agentSessionId: 'worker', providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: root,
    run: { runId: 'original-run' }, retiredRuns: [], createdAt: _reshape_fixtureEpoch(0, 0, 100), updatedAt: _reshape_fixtureEpoch(0, 0, 100), hookBindingId: 'owned-binding', hookToken: 'owned-token',
    semanticStatus: { state: 'done' as const, source: 'native-hook' as const, observedAt: _reshape_fixtureEpoch(0, 0, 100), stateEnteredAt: _reshape_fixtureEpoch(0, 0, 100) }, promptCompletionAdmission: {
      submissionId: 'original-start', completionId: 'original-completion', outputCursorBytes: 0, acknowledged: true, operationId: 'original-native-op', startByte: 0, endByte: 14,
      intent: { run: { runId: 'original-run' }, ownerInstanceId: 'original-owner', prompt: 'Original body',
        plan: { kind: 'render-then-submit' as const, payload: 'Original body', renderedText: 'Original body', submit: '\r' }, execution: 'default' as const,
        message: { userContent: 'Original body', sourceChannel: 'message-tool' as const } } } }
  await sessions.compareAndSwap(null, original)
  const client = new AgentMuxClient({ store: sessions }), stop = vi.fn(), writes: string[] = []
  const inner = client as any; let cursor = 14
  const projection = () => ({ runId: 'original-run', lifecycleOperationId: null, program: 'fixture', args: [], workspacePath: root, pid: 100, state: { type: 'running' }, cols: 80, rows: 24, latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: cursor })
  inner.connected = true; await inner.registry.load('local')
  inner.kernel.isConnected = () => true
  inner.kernel.identity = () => ({ daemonInstanceId: 'original-owner', protocolVersion: 18, buildIdentity: 'controlled-native-io' })
  inner.kernel.list = async () => [projection()]; inner.kernel.status = async () => projection()
  inner.kernel.input = async (_runId: string, input: any) => { expect(input.expectedByte).toBe(cursor); writes.push(input.data); cursor += Buffer.byteLength(input.data); return { run: projection(), appliedByteRange: { startByte: input.expectedByte, endByte: cursor } } }
  vi.spyOn(inner.screenEvidence, 'wait').mockResolvedValue(0)
  try {
    await demands.create({ id: 'goal', title: 'Original Goal', status: 'in_progress', assigneeSessionIds: ['worker'], supervisorSessionId: 'worker' })
    await demands.prepareDispatch('goal', { operationId: 'original-start', agentSessionId: 'worker', hostId: 'local', runId: 'original-run', execution: 'finite', prompt: 'Original body' })
    await demands.recordDispatchPhase('goal', 'original-start', { stage: 'confirmed', receipt: { kind: 'core-prompt', itemId: 'prompt:original-start', createdAt: _reshape_fixtureEpoch(0, 0, 100) } })
    const start = (await demands.inspectDispatch('goal', 'original-start'))!, goal = (await demands.get('goal'))!
    const key = { kind: 'prompt' as const, agentSessionId: 'worker', expectedRun: { runId: 'original-run' }, submissionId: 'original-start' }
    const old = await client.inspectAgentPromptSubmission(key)
    expect(old!.admission!.inputKey).toBeUndefined(); expect(old!.admission!.acknowledged).toBe(true)
    const owner = new GoalStartResponsibilityOwner(demands, { inspectGoalStart: async () => client.inspectAgentPromptSubmission(key),
      observeOriginalRun: async () => ({ runId: 'original-run', state: 'running' }), stop } as unknown as GoalStartRuntimePort, vi.fn())
    const observed = await owner.observe(goal, start)
    expect(observed).toMatchObject({ input: { state: 'unknown', retainedReceipt: start.receipt }, originalRun: { runId: 'original-run', state: 'running' }, responsibility: 'observation-unknown' })
    expect(observed.input.proof).toBeUndefined()
    expect(await client.inspectAgentPromptSubmission(key)).toEqual(old)
    expect(await sessions.readMetadata('worker')).toEqual(original)
    expect(await demands.inspectDispatch('goal', 'original-start')).toEqual(start)
    expect(stop).not.toHaveBeenCalled()
    await client.submitAgentPrompt({ agentSessionId: 'worker', expectedRun: { runId: 'original-run' }, afterSubmissionId: 'original-start', operationId: 'manual-next', prompt: 'The next explicit manual input.', execution: 'default' })
    const next = await client.inspectAgentPromptSubmission({ ...key, submissionId: 'manual-next' })
    expect(next!.admission).toMatchObject({ acknowledged: true, inputKey: { ...key, submissionId: 'manual-next' } })
    expect(writes.join('')).toContain('The next explicit manual input.')
    expect((await client.agentSession('worker')).run).toEqual(original.run)
    expect(await client.inspectAgentPromptSubmission(key)).toEqual(old)
    const evidence = process.env.AGENTMUX_GOAL_START_RECEIPT_DIR
    if (evidence) {
      await fs.mkdir(evidence, { recursive: true })
      await fs.writeFile(join(evidence, 'legacy-original-missing-key.json'), JSON.stringify({ schema: 'agentmux.legacy-original-start-input.v1',
        proofBoundary: 'Actual Core memory Session-owner record and SDK reader with legacy missing input source; Main/Demand observer actual, healthy Run is an explicit Runtime port. No native process recovery claim.', old, observed, start, next, nativeWrites: writes }, null, 2) + '\n')
    }
    owner.dispose()
  } finally { await client.dispose(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }) }
})
