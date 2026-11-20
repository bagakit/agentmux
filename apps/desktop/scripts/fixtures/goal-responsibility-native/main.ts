import { seedStoredDemand } from '../../../../../test/fixtures/stored-demand.mjs'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'
import { AgentMuxControlServer, AgentMuxError, AgentMuxFileAgentSessionStore, AgentMuxRpcService, agentPromptCondition } from '@agentmux/core'
import { demandExecutionReferences, demandResponsibilityScope, openDemandStore } from '@agentmux/demand'
import { goalRoleGuidance } from '@agentmux/core/goal-role-guidance'
import { goalDelegationApplication, type GoalDelegationResult } from '@agentmux/core/goal-delegation'
import { GoalDelegationOwner } from '../../../../host/src/goal-delegation-owner'
import { GoalDispatchInputOwner } from '../../../../host/src/goal-dispatch-input'
import { GoalPatrolOwner } from '../../../../host/src/goal-patrol-owner'
import { GoalResponsibilityOwner } from '../../../../host/src/goal-responsibility-owner'
import { GoalStartResponsibilityOwner } from '../../../../host/src/goal-start-responsibility'
import { createGoalRuntime } from '../../../../host/src/goal-runtime'
import { RuntimeController } from '../../../src/main/runtime-controller'
import { localRuntimeConnector } from '../../../test/helpers/local-runtime-connector'

const [privateRoot, phase, evidence, nodeExecutable, cliFile, codex, managerWorker, nativeHome] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
process.env.AGENTMUX_RUNTIME_DIRECTORY = path.join(privateRoot, 'runtime')
process.env.AGENTMUX_STATE_DIRECTORY = path.join(privateRoot, 'runtime', 'state')
process.env.AGENTMUX_MESSAGE_QUEUE_PATH = path.join(privateRoot, 'messages.ndjson')
const execute = promisify(execFile)
const store = new AgentMuxFileAgentSessionStore(path.join(privateRoot, 'sessions.json'))
const runtime = new RuntimeController(store, localRuntimeConnector)
const demands = openDemandStore({ root: path.join(privateRoot, 'goals') })
const config = { version: 9, hosts: [{ id: 'local', kind: 'local' as const, label: 'Private proof' }], executors: Object.fromEntries(
  ['manager', 'finite', 'delegate'].map(id => [id, { providerId: 'codex', label: 'Private native fixture', command: nodeExecutable,
    args: id === 'manager' ? [managerWorker, privateRoot, codex] : [path.join(privateRoot, 'fake-codex-cli.mjs')], injectAgentMuxGuide: false,
    env: { AGENTMUX_FAKE_READY_MODE: 'before', AGENTMUX_FAKE_NATIVE_RECORD: '1',
      CODEX_HOME: id === 'manager' ? nativeHome : path.join(privateRoot, 'codex'), AGENTMUX_TEST_CODEX_BINARY: codex,
      AGENTMUX_FAKE_NATIVE_RECORD_DIRECTORY: path.join(privateRoot, 'codex', 'sessions'),
      AGENTMUX_FAKE_CAPABILITY_RECEIPT: path.join(privateRoot, `${id}-credential.json`) } }])),
  workspaces: [{ id: 'private-workspace', hostId: 'local', name: 'Private proof', path: path.join(privateRoot, 'workspace'), kind: 'folder' as const }] }
const result: Record<string, any> = { schema: 'agentmux.goal-responsibility-native-phase.v1', passed: false, phase, pid: process.pid, cli: [] }
let server: AgentMuxControlServer | undefined, patrol: GoalPatrolOwner | undefined, responsibility: GoalResponsibilityOwner | undefined
const client = () => {
  const matches = runtime.rpcClients().filter(entry => entry.hostId === 'local')
  assert.equal(matches.length, 1, 'The original Native proof has one exact local Core owner')
  return matches[0]!.client
}
const context = { principal: { kind: 'user', id: 'private-proof' } } as any
const authority = { actor: { kind: 'user', id: 'private-proof' } } as const
const changed: string[][] = []
const notify = (ids: string[]) => changed.push([...ids])
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, message: string, budget = 20_000): Promise<T> {
  const deadline = Date.now() + budget
  let last: T | undefined
  do { last = await read(); if (accept(last)) return last; await delay(40) } while (Date.now() < deadline)
  throw Object.assign(new Error(message), { observation: last })
}
async function cli(args: string[], actor = 'manager') {
  const credential = JSON.parse(await fs.readFile(path.join(privateRoot, `${actor}-credential.json`), 'utf8'))
  const env = { ...process.env, AGENTMUX_AGENT_SESSION_ID: credential.agentSessionId, AGENTMUX_AGENT_CAPABILITY: credential.capability }
  delete env.ELECTRON_RUN_AS_NODE
  const { stdout } = await execute(nodeExecutable, [cliFile, ...(args.at(-1) === '--skill' ? [] : ['--endpoint', 'unix:' + server!.path]), ...args], { env, maxBuffer: 4 * 1024 * 1024 })
  const value = args.at(-1) === '--skill' ? stdout : JSON.parse(stdout)
  if (typeof value === 'string') assert.ok(value.trim().length > 100, 'A real nonempty owned module is required')
  result.cli.push({ args: args.map(arg => arg.startsWith(privateRoot) ? path.relative(privateRoot, arg) : arg), actor, value })
  return value
}
async function action(command: string[], input: unknown) {
  const file = path.join(privateRoot, 'command-input.json')
  await fs.writeFile(file, JSON.stringify(input))
  return cli(['goal', ...command, '--input', file])
}
async function nativeManagerInput() {
  const status = await client().statusAgent('private-manager'), handle = status.session.nativeHandle
  assert.ok(handle?.kind === 'provider' && handle.providerId === 'codex' && handle.transcriptPath, 'The original manager has a real native conversation')
  const rows = (await fs.readFile(handle.transcriptPath, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
  return { handle, inputs: rows.filter(row => row.type === 'response_item' && row.payload?.type === 'message' && row.payload.role === 'user').map(row => row.payload) }
}

app.whenReady().then(async () => {
  try {
    runtime.commit(await runtime.prepare(config as any))
    // Use the same Host Goal port as createHostGoals; Desktop only owns Native launch/lifecycle.
    // This isolated owner has no Renderer/composer. The real App restart proof qualifies drafts.
    const goalRuntime = createGoalRuntime({ clients: () => runtime.rpcClients(), inputOccupied: async () => false,
      checkIn: async () => { throw new Error('This responsibility proof never creates check-in schedules.') } })
    const core = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client: client() }] })
    let owner: GoalDelegationOwner
    const read = (goalId: string) => owner.call('goal.delegations', { goalId }, context, authority)
    responsibility = new GoalResponsibilityOwner(demands, goalRuntime, read, notify)
    patrol = new GoalPatrolOwner(demands, goalRuntime, read, notify)
    const starts = new GoalStartResponsibilityOwner(demands, goalRuntime, notify)
    owner = new GoalDelegationOwner(demands, goalRuntime, undefined, {
      call: (hostId, method, params, callContext) => { assert.equal(hostId, 'local'); return core.call(method, params, callContext) },
      readDispatch: async (hostId, sourceMessageId) => ({ ...await client().readDispatch({ sourceMessageId }), hostId }),
      observeRun: (hostId, runId) => goalRuntime.observeOriginalRun(hostId, runId)
    }, undefined, (goal, start) => starts.observe(goal, start), responsibility, patrol)
    server = new AgentMuxControlServer({ socketPath: path.join(privateRoot, 'control.sock'), coreClients: () => [{ hostId: 'local', client: client() }], goalDelegations: owner })
    await server.start()
    let ids: Record<string, any>
    if (phase === 'seed') {
      ids = {}; result.ids = ids
      for (const name of ['manager', 'finite', 'delegate']) {
        const launched = await runtime.launchAgent({ hostId: 'local', executorId: name, workspacePath: config.workspaces[0].path,
          agentSessionId: 'private-' + name, createOperationId: 'create-' + name }, config as any)
        ids[name] = { agentSessionId: launched.created.agentSessionId, run: launched.created.run }
        await until(() => client().statusAgent(ids[name].agentSessionId), (value: any) => value.observation.readiness === 'ready' && value.session.semanticStatus?.state === 'done', 'Native fixture did not publish its authoritative completed turn')
      }
      await fs.writeFile(path.join(privateRoot, 'ids.json'), JSON.stringify(ids))
      await seedStoredDemand(demands, { id: 'original-goal', title: 'Inspect original responsibility', status: 'in_progress',
        sessionIds: Object.values(ids).map((value: any) => value.agentSessionId),
        assigneeSessionIds: Object.values(ids).map((value: any) => value.agentSessionId), supervisorSessionId: ids.manager.agentSessionId })
      await demands.proposeAlignment('original-goal', { summary: 'Original useful result', criteria: [{ id: 'AC', text: 'Original execution evidence and next responsibility' }], openQuestions: [] })
      const body = 'Original finite work <literal>\r\n '
      await demands.prepareDispatch('original-goal', { operationId: 'original-finite-start', agentSessionId: ids.finite.agentSessionId, hostId: 'local', runId: ids.finite.run.runId, execution: 'finite', prompt: body })
      const finiteControl = { kind: 'agent' as const, hostId: 'local', ...ids.finite }
      await new GoalDispatchInputOwner(demands, goalRuntime).submit({ goalId: 'original-goal', operationId: 'original-finite-start' }, finiteControl, 'original-finite-start', body,
        () => goalRuntime.submitPrompt(finiteControl, body, 'original-finite-start', agentPromptCondition(client().agentSession(ids.finite.agentSessionId)), undefined, undefined, true,
          goalRoleGuidance({ role: 'executor', goalId: 'original-goal', agentSessionId: ids.finite.agentSessionId, runId: ids.finite.run.runId, source: { kind: 'goal-start', operationId: 'original-finite-start' } })))
      await cli(['goal', '--skill']); await cli(['agent', '--skill'])
      const inspect = await cli(['agent', 'inspect', '--session', ids.manager.agentSessionId])
      assert.ok(inspect.result, 'Agent module read is followed by a real public business read')
      const delegation = { goalId: 'original-goal', intent: { operationId: 'original-delegate', sourceMessageId: 'original-source-message', hostId: 'local',
        ownerAgentSessionId: ids.manager.agentSessionId, ownerRunId: ids.manager.run.runId, workerAgentSessionId: ids.delegate.agentSessionId, workerRunId: ids.delegate.run.runId,
        threadId: 'original-thread', text: 'Original delegated work', alignmentRevision: 1, criterionIds: ['AC'] } }
      await action(['delegation', 'prepare'], delegation)
      const frozen = (await demands.inspectDelegation(delegation.goalId, delegation.intent.operationId))!
      // Ordinary Inbox references await a native opportunity. This fixture explicitly qualifies
      // delivered Native work: the actual manager sends the frozen original once, then binds it.
      const originalInput = path.join(privateRoot, 'original-delegation-input.json')
      await fs.writeFile(originalInput, JSON.stringify({ target: { kind: 'agent-session', agentSessionId: frozen.workerAgentSessionId, hostId: 'local' },
        operationId: frozen.operationId, messageId: frozen.sourceMessageId, threadId: frozen.threadId, correlationId: frozen.sourceMessageId,
        text: frozen.text, application: goalDelegationApplication(delegation.goalId, frozen), expectedRun: { runId: frozen.workerRunId }, execution: 'immediate' }))
      await cli(['agent', 'send', '--input', originalInput])
      await action(['delegate'], delegation)
      await responsibility.start(); await patrol.start()
      result.initialResponsibility = await read('original-goal')
      assert.ok(result.initialResponsibility.responsibility.executions.some((row: any) => row.phase === 'idle-grace' && row.alert === null),
        'A genuinely short original idle must retain its reporting grace')
      result.before = await until(() => read('original-goal'), (work: GoalDelegationResult) => work.responsibility?.executions.length === 2 && work.responsibility.executions.every(row => row.binding === 'confirmed' && row.phase === 'stalled' && row.alert !== null),
        'Original Native finite/delegated idle did not become actionable after its actual grace deadline', 80_000)
      // The real Provider has already received queue/add's native item when Core settles it.
      // Lose that confirmation once, retaining the original unknown claim and correlation.
      const original = store.settlePromptAdmission.bind(store)
      let armed = true
      store.settlePromptAdmission = async (before, after, signal) => {
        const ack = after.admission.transport === 'native' ? after.admission.native : undefined
        if (armed && after.agentSessionId === ids.manager.agentSessionId && ack?.outcome === 'admitted') {
          armed = false; result.lostReceipt = { runId: after.run.runId, operationId: after.admission.submissionId, ack }
          throw new AgentMuxError('Private native queue admission ACK lost after actual acceptance.', 'PRIVATE_ACK_LOST', 'unknown')
        }
        return await original(before, after, signal)
      }
      try { result.request = await cli(['goal', 'patrol', '--goal', 'original-goal', '--operation-id', 'original-patrol']) }
      finally { store.settlePromptAdmission = original }
      assert.equal(armed, false, 'The actual original PMO native queue must admit its original input')
      assert.ok(result.lostReceipt.ack.queuedSubmissionId)
      result.nativeManager = await until(nativeManagerInput, value => value.inputs.some((input: any) => JSON.stringify(input).includes('original-patrol')),
        'The actual native writer did not consume its queued original patrol')
      result.after = await read('original-goal')
      assert.equal(result.after.patrols.length, 1)
      assert.equal(result.after.patrols[0].attempts.length, 1)
      assert.ok(result.after.patrols[0].attempts[0].attemptedAt)
      assert.equal(result.after.patrols[0].report, undefined)
      assert.ok(result.after.responsibility.executions.every((row: any) => row.alert !== null), 'Native input acceptance cannot discharge inspection responsibility')
      result.input = await goalRuntime.inspectGoalAttention({ hostId: 'local', supervisorAgentSessionId: ids.manager.agentSessionId, supervisorRunId: ids.manager.run.runId,
        operationId: result.after.patrols[0].attempts[0].operationId })
      assert.equal(result.input.admission.acknowledged, false, 'Native acceptance was witnessed, but Core never confirmed the lost receipt')
      assert.equal(result.input.admission.native?.outcome, 'claimed')
      result.receiptBoundary = { nativeAcceptedWitness: result.lostReceipt, coreUnknownClaim: result.input }
      await fs.writeFile(path.join(privateRoot, 'expected.json'), JSON.stringify({ ids, goal: await demands.get('original-goal'), input: result.input, nativeManager: result.nativeManager,
        runs: (await client().listRuns()).filter((run: any) => run.state === 'running').map((run: any) => ({ runId: run.runId, pid: run.pid, acceptedInputBytes: run.acceptedInputBytes })).sort((a: any, b: any) => a.runId.localeCompare(b.runId)) }))
    } else {
      const expected = JSON.parse(await fs.readFile(path.join(privateRoot, 'expected.json'), 'utf8')); ids = expected.ids
      assert.deepEqual(await demands.get('original-goal'), expected.goal, 'Original Goal and frozen request changed across process restart')
      result.beforeRuns = (await client().listRuns()).filter((run: any) => run.state === 'running').map((run: any) => ({ runId: run.runId, pid: run.pid, acceptedInputBytes: run.acceptedInputBytes })).sort((a: any, b: any) => a.runId.localeCompare(b.runId))
      assert.deepEqual(result.beforeRuns, expected.runs, 'Original Native Runs and accepted input bytes must survive without replacement')
      await responsibility.start(); await patrol.start()
      result.before = await read('original-goal')
      result.repeated = await cli(['goal', 'patrol', '--goal', 'original-goal', '--operation-id', 'original-patrol'])
      result.afterRuns = (await client().listRuns()).filter((run: any) => run.state === 'running').map((run: any) => ({ runId: run.runId, pid: run.pid, acceptedInputBytes: run.acceptedInputBytes })).sort((a: any, b: any) => a.runId.localeCompare(b.runId))
      assert.deepEqual(result.afterRuns, expected.runs, 'An attempted original input must never be replayed on restart or duplicate request')
      result.input = await goalRuntime.inspectGoalAttention({ hostId: 'local', supervisorAgentSessionId: ids.manager.agentSessionId,
        supervisorRunId: ids.manager.run.runId, operationId: expected.input.admission.submissionId })
      assert.deepEqual(result.input, expected.input, 'The original unknown Core claim, submission, input key and frozen native correlation survive unchanged')
      result.nativeManager = await nativeManagerInput()
      assert.deepEqual(result.nativeManager, expected.nativeManager, 'Original native thread and consumed input remain unchanged without another queue submission')
      const goal = (await demands.get('original-goal'))!, patrolRecord = goal.patrols![0]
      await fs.mkdir(path.join(config.workspaces[0].path, 'evidence'), { recursive: true })
      await fs.writeFile(path.join(config.workspaces[0].path, 'evidence', 'inspection.json'), JSON.stringify({ executions: demandExecutionReferences(goal), input: expected.input, actualRuns: result.afterRuns }))
      result.report = await action(['patrol', 'report'], { goalId: goal.id, patrolOperationId: patrolRecord.operationId, report: {
        operationId: 'original-inspection-report', summary: 'Original inputs and surviving Runs inspected; evidence is ready for the person.', status: 'in_review',
        grounding: { alignmentRevision: 1, summary: 'Original execution and inspection evidence', checks: [{ criterionId: 'AC', outcome: 'met', evidence: ['evidence/inspection.json'], note: '' }] },
        progress: demandExecutionReferences(goal).map((execution, index) => ({ operationId: 'inspected-progress-' + index, expectedScope: demandResponsibilityScope(goal), execution,
          phase: 'review', summary: 'Exact original execution inspected', evidence: ['evidence/inspection.json'], nextAction: 'Human review of the original evidence' })),
        nextOwner: { kind: 'human', agentSessionId: null, action: 'Review the original evidence and explicitly accept or request changes.' } } })
      result.after = await read(goal.id)
      assert.ok(result.after.responsibility.executions.every((row: any) => row.alert === null && row.nextOwner.kind === 'human'))
      assert.equal(result.after.goalState.status, 'in_review')
      assert.equal((await demands.get(goal.id))!.alignment!.confirmedAt, null, 'Execution and inspection do not confirm human alignment')
      assert.equal((await demands.get(goal.id))!.grounding!.acceptedAt, null, 'Inspection does not accept the human result')
    }
    result.ids = ids; result.runtimeIdentity = client().runtimeIdentity(); result.changed = changed; result.passed = true
  } catch (error: any) {
    result.failure = { name: error.name, message: error.message, stack: error.stack, observation: error.observation }
    result.managerCarrier = await fs.readFile(path.join(privateRoot, 'manager-carrier.json'), 'utf8').then(JSON.parse).catch(() => null)
  }
  finally {
    patrol?.dispose(); responsibility?.dispose()
    await Promise.allSettled([...(patrol as any)?.flights?.values() ?? [], ...(responsibility as any)?.flights?.values() ?? []])
    await server?.stop().catch(error => { result.cleanupFailure = String(error); result.passed = false })
    await runtime.dispose().catch(error => { result.cleanupFailure = String(error); result.passed = false })
    await fs.writeFile(path.join(evidence, `${phase}.json`), JSON.stringify(result, null, 2))
    app.exit(result.passed ? 0 : 1)
  }
})
