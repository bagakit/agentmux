import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const view = (state: any) => ({ tabs: state.tabs, layouts: state.layouts, drafts: state.drafts,
  focus: state.focus, activeWorkspaceId: state.activeWorkspaceId })
const roots = (session: any): any[] => Object.values(session.continuityOperations ?? {}).filter((one: any) => one.supervision)

/** Three actual App generations share the existing private Store and Native Runtime. */
export async function verifySupervisionDurability({ store, spatial, win, client, ids, phase, privateRoot,
  evidence, result, state, wait, delay, nodeExecutable }: any) {
  const evaluate = (source: string) => win.webContents.executeJavaScript(source)
  const read = async (name: string) => {
    const session = await store.readMetadata(ids[name].sessionId)
    assert.ok(session, 'The original durable Session remains present: ' + name)
    return session
  }
  const root = (session: any) => {
    const values = roots(session)
    assert.equal(values.length, 1, 'Exactly one original automatic intent owns this private Session')
    return values[0]
  }
  const output = async (run: any) => Buffer.concat((await client().readRunReplay(run)).replay
    .map((one: any) => Buffer.from(one.dataBytes))).toString('utf8')
  const native = async (name: string) => {
    const bytes = await fs.readFile(ids[name].nativeHandle.transcriptPath, 'utf8')
    return { bytes, records: bytes.split('\n').filter(Boolean).map((line: string) => JSON.parse(line)) }
  }
  const facts = async () => (await client().listRuns()).map((one: any) => ({ runId: one.runId, pid: one.pid,
    state: one.state, acceptedInputBytes: one.acceptedInputBytes })).sort((a: any, b: any) => a.runId.localeCompare(b.runId))
  const expectedFile = path.join(privateRoot, 'supervision-expected.json')
  const previous = phase === 'seed' ? undefined : JSON.parse(await fs.readFile(expectedFile, 'utf8'))
  result.initial = await state()
  assert.equal(Object.keys(result.initial.tabs).length, 2)
  for (const name of ['healthy', 'working', 'idle']) assert.equal(result.initial.drafts[ids[name].sessionId], `Unsent ${name} draft remains intact`)
  if (previous) {
    assert.deepEqual(view(result.initial), previous.view, 'The original workface survives before new UI interaction')
    assert.deepEqual(result.spatialBefore, previous.spatial, 'The nonempty original spatial document precedes hydration')
    assert.ok(result.spatialBefore.graph && Object.keys(result.initial.layouts).length > 0)
  }
  const healthy = (await client().listRuns()).find((one: any) => one.runId === ids.healthy.run.runId)
  assert.equal(healthy?.state, 'running'); assert.ok(Number.isSafeInteger(healthy.pid))
  const identity = { runId: healthy.runId, pid: healthy.pid }
  if (previous) assert.deepEqual(identity, previous.healthy, 'The original healthy process survives the App process')
  result.supervision = { kind: 'durability', healthy: identity, schedulerOwnerPid: process.pid, rawInput: [], controls: [] }

  const select = async (name: string) => {
    await evaluate(`(()=>{const state=window.continuityState();const tab=Object.values(state.tabs).find(one=>Object.values(one.regions).some(region=>region.sessionId===${JSON.stringify(ids[name].sessionId)}));const button=tab&&document.querySelector('[data-workbench-tab-id="'+tab.id+'"]');if(!button)throw new Error('Original tab control is absent');button.click()})()`)
    await wait('original ' + name + ' region mounted', async () => evaluate(`!!document.querySelector('[data-workbench-region-id="continuity-${name}"]')`))
  }
  const control = async (name: string, action: 'continue' | 'cancel') => {
    await select(name)
    await evaluate(`(()=>{const region=document.querySelector('[data-workbench-region-id="continuity-${name}"]');const button=region.querySelector('.continuity-supervision button[aria-label="View service notice: Recovery paused"]');if(!button)throw new Error('Actual paused recovery notice is absent');button.click()})()`)
    const label = action === 'continue' ? 'Continue recovery' : 'Cancel automatic recovery'
    await wait('actual recovery action visible', async () => evaluate(`[...document.querySelectorAll('button')].some(one=>one.textContent.trim()===${JSON.stringify(label)}&&!one.disabled)`))
    await evaluate(`(()=>{const button=[...document.querySelectorAll('button')].find(one=>one.textContent.trim()===${JSON.stringify(label)}&&!one.disabled);if(!button)throw new Error('Original recovery action unavailable');button.click()})()`)
    const operation = await wait('GUI control reaches the original durable owner', async () => {
      const current = root(await read(name)), receipts: any[] = Object.values(current.supervision.controlOperations ?? {})
      return receipts.find((one: any) => one.request.action === action)
    })
    assert.equal(operation.request.agentSessionId, ids[name].sessionId)
    assert.equal(operation.request.intentOperationId, root(await read(name)).operationId)
    assert.equal(operation.outcome, action === 'continue' ? 'continued' : 'cancelled')
    if (action === 'continue') assert.equal(operation.request.additionalAttempts, 1)
    const call = result.calls.find((one: any) => one.operation === 'control-continuity' && one.finished &&
      one.args.some((arg: any) => arg?.operationId === operation.request.operationId))
    assert.ok(call, 'The actual Renderer -> Main control receipt is required')
    assert.deepEqual(call.result.result.receipt, operation)
    const intents = (await state()).continuityControlIntents
    assert.ok(intents && Object.values(intents).some((entries: any) => entries[operation.request.operationId]),
      'The actual Renderer retains its immutable original control packet')
    result.supervision.controls.push(operation)
    return operation
  }

  if (phase === 'seed') {
    for (const name of ['working', 'idle']) {
      const stopped = await wait('first failed automatic attempt pauses ' + name, async () => {
        const session = await read(name), operation = roots(session)[0]
        return operation?.supervision.phase === 'paused' ? session : false
      }, 30000)
      const operation = root(stopped), run = (await client().listRuns()).find((one: any) => one.runId === stopped.run.runId)
      assert.equal(operation.trigger, 'startup'); assert.equal(operation.supervision.attemptCount, 1)
      assert.equal(operation.supervision.attemptLimit, 1); assert.equal(operation.policy.retryMaxAttempts, 0)
      assert.equal(run?.state, 'exited'); assert.equal(run.exitCode, 7)
      assert.equal(operation.launchInput?.state, 'launch-carried', 'Keep the truthful first input carrier after bootstrap exit')
      assert.notEqual(stopped.run.runId, ids[name].run.runId)
      result.supervision[name + 'FirstFailure'] = { root: operation, run }
    }
    // These are real visible production controls. Neither Store metadata nor clocks are edited.
    await control('idle', 'cancel')
    await control('working', 'continue')
    const pending = await wait('original supervisor persists a future attempt', async () => {
      const operation = root(await read('working'))
      return operation.supervision.phase === 'retry-wait' && operation.supervision.nextAttemptAt > Date.now() ? operation : false
    })
    assert.equal(pending.supervision.attemptCount, 1); assert.equal(pending.supervision.attemptLimit, 2)
    result.supervision.scheduled = { observedAt: Date.now(), nextAttemptAt: pending.supervision.nextAttemptAt,
      attemptCount: pending.supervision.attemptCount, attemptLimit: pending.supervision.attemptLimit }
  } else {
    const beforeWorking = result.before.find((one: any) => one.agentSessionId === ids.working.sessionId)
    const beforeRoot = root(beforeWorking)
    if (phase === 'restore') {
      assert.equal(beforeRoot.supervision.phase, 'retry-wait')
      assert.equal(beforeRoot.supervision.attemptCount, 1); assert.equal(beforeRoot.supervision.attemptLimit, 2)
      assert.equal(beforeRoot.supervision.nextAttemptAt, previous.workingRoot.supervision.nextAttemptAt)
      assert.ok(result.beforeObservedAt < beforeRoot.supervision.nextAttemptAt, 'The restarted App must observe the original schedule before it is due')
      result.supervision.preDue = { observedAt: result.beforeObservedAt, root: beforeRoot }
    }
    const working = await wait('restarted Core admits the context-only original next attempt', async () => {
      const session = await read('working'), operation = root(session)
      return operation.supervision.attemptCount === 2 && session.run.runId !== previous.workingFirstRun.runId &&
        (await output(session.run)).includes('codex-ready:') ? session : false
    }, 60000)
    const operation = root(working), child = working.continuityOperations[operation.supervision.activeAttemptOperationId]
    assert.ok(child && child.intentOperationId === operation.operationId)
    assert.deepEqual(child.recoveryInputs, { reminder: '', continuation: '' }); assert.equal(child.launchInput, undefined)
    assert.deepEqual(operation.launchInput, previous.workingRoot.launchInput, 'Original input outcome is never rewritten or replayed')
    assert.deepEqual(operation.policy, previous.workingRoot.policy)
    assert.equal(operation.supervision.attemptLimit, 2); assert.equal(operation.supervision.contextEvidence, undefined,
      'A printed fixture context readback does not prove the approved Provider resume-context contract')
    if (phase === 'reconnect') assert.deepEqual(working.run, previous.workingRun, 'A third App generation reattaches the same recovered Run')
    const bytes = await native('working'), text = await output(working.run)
    assert.ok(bytes.bytes.startsWith(previous.native.working), 'The original native conversation prefix remains intact')
    assert.equal(bytes.records.filter((one: any) => one.type === 'fixture_resume').length, 2)
    assert.equal(bytes.records.filter((one: any) => one.type === 'fixture_bootstrap_exit').length, 1)
    assert.equal(bytes.records.filter((one: any) => one.type === 'fixture_launch_input').length, 0)
    assert.equal(text.includes('codex-launch-input:'), false); assert.equal(text.includes('codex-submit:'), false)
    const witness = JSON.parse(text.match(/codex-restored-context:([^\r\n]+)/u)?.[1] ?? 'null')
    assert.equal(witness?.nativeSessionId, ids.working.nativeHandle.sessionId)
    assert.ok(witness.bodies.some((one: any) => one.role === 'user' && one.text) && witness.bodies.some((one: any) => one.role === 'assistant' && one.text))
    result.supervision.recovered = { run: working.run, root: operation, child, nativeContextReadback: witness,
      processRunning: true, providerContextConfirmed: false, oldTaskContinuationConfirmed: false, oldInputReplayCount: 0 }
    result.supervision.controls = previous.controls
  }

  const idle = await read('idle'), idleRoot = root(idle), working = await read('working'), workingRoot = root(working)
  assert.equal(idleRoot.supervision.phase, 'cancelled'); assert.equal(idleRoot.supervision.attemptCount, 1)
  assert.deepEqual(idle.run, result.supervision.idleFirstFailure?.run ? { runId: result.supervision.idleFirstFailure.run.runId } : previous.idleRun)
  assert.equal((await native('idle')).records.filter((one: any) => one.type === 'fixture_resume').length, 1)
  assert.equal((await native('idle')).records.filter((one: any) => one.type === 'fixture_launch_input').length, 0)
  result.supervision.cancelled = { root: idleRoot, run: idle.run, noNewAttempt: true, noInputReplay: true }

  // The public server uses this generation's exact Core owner. No observer Core or scheduler is created.
  const { AgentMuxControlServer } = await import(/* @vite-ignore */ pathToFileURL(path.join(privateRoot, 'core/dist/public-rpc-server.js')).href)
  const socketPath = path.join(privateRoot, 'supervision-control.sock')
  const server = new AgentMuxControlServer({ socketPath, spatialState: spatial, coreClients: () => [{ hostId: 'local', client: client() }] })
  await server.start()
  try {
    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_)/u.test(key)))
    const env = { ...cleanEnv, AGENTMUX_RPC_ENDPOINT: 'unix:' + socketPath,
      AGENTMUX_RUNTIME_DIRECTORY: path.join(privateRoot, 'runtime'), AGENTMUX_STATE_DIRECTORY: path.join(privateRoot, 'runtime/state'),
      AGENTMUX_AGENT_SESSION_STORE: store.path, AGENTMUX_SPATIAL_STATE_PATH: path.join(privateRoot, 'spatial.json'),
      AGENTMUX_MESSAGE_QUEUE_PATH: path.join(privateRoot, 'messages.ndjson') }
    const command = async (args: string[]) => {
      const reply = await exec(nodeExecutable, [path.join(privateRoot, 'core/bin/amux'), ...args], { env, timeout: 20000, maxBuffer: 4 * 1024 * 1024 })
      const value = JSON.parse(reply.stdout); assert.equal(value.ok, true); return value
    }
    const before = await facts()
    assert.ok(before.filter((one: any) => one.state === 'running').every((one: any) => Number.isSafeInteger(one.acceptedInputBytes)))
    const checks = []
    for (const receipt of result.supervision.controls) {
      const file = path.join(privateRoot, receipt.request.operationId + '.json')
      await fs.writeFile(file, JSON.stringify(receipt.request))
      const reply = await command(['agent', 'continuity', 'control', '--input', file])
      assert.deepEqual(reply.result.receipt, receipt, 'Compiled CLI reads the immutable original GUI control result')
      const inspection = await command(['agent', 'inspect', '--session', receipt.request.agentSessionId])
      const projected = inspection.result.session, exact = await store.readMetadata(receipt.request.agentSessionId)
      assert.deepEqual(projected.run, exact.run)
      const projectedRoot = projected.continuityOperations[receipt.request.intentOperationId], storedRoot = root(exact)
      for (const key of ['phase', 'activeAttemptOperationId', 'attemptCount', 'attemptLimit', 'nextAttemptAt', 'cancellation', 'contextEvidence', 'controlOperations']) {
        assert.deepEqual(projectedRoot.supervision[key], storedRoot.supervision[key], 'Public inspection consumes the original durable supervision fact: ' + key)
      }
      checks.push({ request: receipt.request, reply, inspection })
    }
    const after = await facts(); assert.deepEqual(after, before, 'Original control receipt and inspect cannot Start, Stop or replay input')
    result.supervision.publicCli = { passed: true, boundary: 'compiled CLI -> public RPC -> this App generation Core/FileStore/Native',
      checks, nativeBefore: before, nativeAfter: after, zeroLifecycleOrInput: true }
  } finally { await server.stop() }

  await select('working')
  await wait('original mounted healthy terminal ready', async () => {
    const value = await evaluate('window.continuityTerminalState("healthy")')
    return value?.observation?.liveReady && value.observation.visible && value.text.includes('codex-ready:') ? value : false
  })
  await evaluate('window.capabilityFocusHealthy()')
  const body = 'supervision-' + phase + '-original-healthy'
  for (const character of body) win.webContents.sendInputEvent({ type: 'char', keyCode: character })
  await delay(100); win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
  const consumed = await wait('original healthy Native consumer still accepts raw input', async () => {
    const value = await output(ids.healthy.run); return value.includes('codex-submit:' + body + ':accepted') ? value : false
  })
  assert.equal(consumed.split('codex-submit:' + body + ':accepted').length - 1, 1)
  result.supervision.rawInput.push({ ...identity, body, consumedOnce: true })
  await evaluate('window.continuityFlush()')
  result.finalSpatial = await spatial.readForLayout()
  const final = await state()
  assert.equal(final.focus?.execution?.sessionId, ids.healthy.sessionId, 'Actual Terminal focus passes through the production Store before persistence')
  const currentNative = { working: (await native('working')).bytes, idle: (await native('idle')).bytes }
  if (previous) for (const key of ['tabs', 'layouts', 'drafts', 'activeWorkspaceId']) assert.deepEqual(view(final)[key], previous.view[key])
  const saved = { view: view(final), spatial: result.finalSpatial, healthy: identity, controls: result.supervision.controls,
    workingFirstRun: previous?.workingFirstRun ?? working.run, workingRun: working.run, idleRun: idle.run, workingRoot, idleRoot,
    native: previous?.native ?? currentNative }
  await fs.writeFile(expectedFile, JSON.stringify(saved))
  result.supervision.final = saved
  await fs.writeFile(path.join(evidence, phase + '-workface.png'), (await win.capturePage()).toPNG())
}
