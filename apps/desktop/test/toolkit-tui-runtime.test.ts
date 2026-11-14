import { expect, it, vi } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createOperationKey } from '../../../packages/core/node_modules/@ctxmux/sdk/dist/index.js'
import { AgentMuxFileAgentSessionStore } from '@agentmux/core'
import type { CtxmuxRunAdapter } from '../../../packages/core/src/ctxmux-run-adapter.js'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service.js'
import { ToolkitReceiptStore } from '../src/main/toolkit-receipt-store.js'
import type { ToolkitScriptSnapshot, ToolkitToolFields } from '@agentmux/core/control'
import { unwrapSessionObservationResult } from '../src/shared/session-observation-result.js'
import type { SessionAttachResult } from '../src/shared/contracts.js'
import { nativeMain, oneCli, until, record } from './toolkit-main.fixture.js'

const program = `exec "$1" -e 'process.stdin.setRawMode(true);process.stdout.write("x".repeat(70000)+"\\x1b[2J\\x1b[HREADY\\r\\n");process.stdin.on("data",b=>process.stdout.write("INPUT:"+b.toString()+"\\r\\n"));setInterval(()=>{},1000)'`
async function stop(main: Awaited<ReturnType<typeof nativeMain>>, executionId: string) {
  const input = join(main.directory, 'stop.json')
  await writeFile(input, JSON.stringify({ executionId }))
  await oneCli('toolkit', 'stop', 'interactive', '--input', input)
}
const inspect = async (id = 'interactive'): Promise<ToolkitScriptSnapshot> => (await oneCli('toolkit', 'inspect', id)).result.snapshot
async function pendingAction(main: Awaited<ReturnType<typeof nativeMain>>, executionId: string, action: 'cancelPendingLaunch' | 'releasePendingLaunch') {
  const input = join(main.directory, 'pending-launch.json')
  await writeFile(input, JSON.stringify({ executionId, [action]: true }))
  return (await oneCli('toolkit', 'stop', 'interactive', '--input', input)).result.snapshot as ToolkitScriptSnapshot
}
const privateKernel = (main: Awaited<ReturnType<typeof nativeMain>>): CtxmuxRunAdapter => Reflect.get(main.core, 'kernel')
async function pendingLaunch(main: Awaited<ReturnType<typeof nativeMain>>, failure: string) {
  const kernel = privateKernel(main), actualStart = kernel.startPrepared.bind(kernel)
  let advance!: () => ReturnType<typeof actualStart>
  const start = vi.spyOn(kernel, 'startPrepared').mockImplementationOnce(async (...args) => {
    advance = () => actualStart(...args)
    throw new Error(failure)
  })
  await add(main, 'interactive', false)
  await until(async () => expect(await inspect()).toMatchObject({ state: 'unknown', pendingLaunch: 'dispatched', admission: { run: null, reason: failure } }))
  const original = (await inspect()).admission!
  expect((await main.sdk.observeCreation(createOperationKey(original.executionId))).observation.outcome).not.toBe('retained')
  return { original, start, applyOriginallyDispatchedStart: () => advance() }
}
async function add(main: Awaited<ReturnType<typeof nativeMain>>, id = 'interactive', waitForRun = true) {
  const fields: ToolkitToolFields = { name: 'Interactive tool', icon: 'terminal', mode: 'tui', enabled: true,
    statusBar: 'label', workspacePath: join(main.directory, 'work'), script: program, args: [process.execPath] }
  const input = join(main.directory, `${id}.json`)
  await writeFile(input, JSON.stringify(fields))
  const definition = (await oneCli('toolkit', 'create', id, '--input', input)).result.definition
  if (waitForRun) await until(async () => expect(await inspect(id)).toMatchObject({ state: 'running', admission: { definition: { mode: 'tui' } } }))
  return definition
}

it('uses the original Native receipt through the Desktop Toolkit CLI after a lost launch reply', async () => {
  const main = await nativeMain()
  const start = main.core.createPreparedTerminal.bind(main.core), inspectOriginal = main.core.inspectTerminalCreation.bind(main.core)
  let originalRun: Awaited<ReturnType<typeof start>> | undefined
  let visible = false
  const creation = vi.spyOn(main.core, 'createPreparedTerminal').mockImplementation(async input => {
    originalRun = await start(input)
    throw new Error('Private first Start reply was lost')
  })
  const observation = vi.spyOn(main.core, 'inspectTerminalCreation').mockImplementation(async input => {
    const receipt = await inspectOriginal(input)
    if (!visible && receipt.admission) return { ...receipt,
      admission: { ...receipt.admission, observation: { availability: 'unavailable', runtime: null } } }
    return receipt
  })
  await add(main, 'interactive', false)
  await until(async () => expect(await inspect()).toMatchObject({ state: 'unknown', reason: 'Private first Start reply was lost', admission: { run: null } }))
  const pending = (await inspect()).admission!
  expect(originalRun?.runId).toBeTruthy()
  expect(observation).toHaveBeenCalledWith({ hostId: 'local', operationId: pending.executionId })
  visible = true
  const adopted = await inspect()
  expect(adopted).toMatchObject({ state: 'running',
    admission: { executionId: pending.executionId, invocationId: pending.invocationId, run: { hostId: 'local', runId: originalRun!.runId } } })
  expect(creation).toHaveBeenCalledOnce()
  const ref = adopted.admission!.run!
  const control = { kind: 'terminal' as const, hostId: ref.hostId, runId: ref.runId, run: { runId: ref.runId } }
  expect(await main.invoke('sessions:refresh', control)).toMatchObject({ kind: 'terminal', control, processState: 'running' })
  await stop(main, pending.executionId)
  await record('tui-lost-launch-receipt', { executionId: pending.executionId, run: ref, starts: creation.mock.calls.length })
})

it('continues the original TUI admission after its first save lost the reply before preparation', async () => {
  const main = await nativeMain()
  const firstPrepare = vi.spyOn(main.core, 'prepareTerminal')
  const firstStart = vi.spyOn(privateKernel(main), 'startPrepared')
  const save = ToolkitReceiptStore.prototype.save
  vi.spyOn(ToolkitReceiptStore.prototype, 'save').mockImplementationOnce(async function (this: ToolkitReceiptStore, id, receipt) {
    await save.call(this, id, receipt)
    throw new Error('Private first admission save reply was lost')
  })
  await add(main, 'interactive', false)
  const pending = await inspect()
  expect(pending).toMatchObject({ state: 'unknown', pendingLaunch: 'not-observed',
    admission: { run: null, reason: expect.stringContaining('first admission save reply was lost') } })
  const original = pending.admission!
  expect(firstPrepare).not.toHaveBeenCalled()
  expect(firstStart).not.toHaveBeenCalled()
  expect(await main.sdk.list()).toEqual([])
  await main.restart()
  const prepare = vi.spyOn(main.core, 'prepareTerminal')
  const start = vi.spyOn(privateKernel(main), 'startPrepared')
  expect(await inspect()).toMatchObject({ state: 'unknown', pendingLaunch: 'not-observed',
    admission: { executionId: original.executionId, invocationId: original.invocationId, run: null } })
  expect(prepare).not.toHaveBeenCalled()
  expect(start).not.toHaveBeenCalled()
  expect(await main.sdk.list()).toEqual([])
  const input = join(main.directory, 'continue-original.json')
  await writeFile(input, JSON.stringify({ invocationId: original.invocationId,
    expectedRevision: original.definition.revision, expectedLatestExecutionId: original.expectedLatestExecutionId }))
  const resumed = (await oneCli('toolkit', 'run', 'interactive', '--input', input)).result.snapshot
  expect(resumed).toMatchObject({ state: 'running', admission: { executionId: original.executionId, invocationId: original.invocationId,
    target: original.target, run: { hostId: 'local', runId: expect.any(String) } } })
  expect((await oneCli('toolkit', 'run', 'interactive', '--input', input)).result.snapshot.admission.run).toEqual(resumed.admission.run)
  expect(prepare).toHaveBeenCalledOnce()
  expect(start).toHaveBeenCalledOnce()
  await stop(main, original.executionId)
  await record('tui-preparation-recovery', { executionId: original.executionId, run: resumed.admission.run, starts: start.mock.calls.length })
})

it('fences the exact pending Toolkit key through the public CLI and waits for a new manual Run after restart', async () => {
  const main = await nativeMain(), pending = await pendingLaunch(main, 'Private original Start disposition is unknown')
  const { original } = pending
  const kernel = privateKernel(main), retire = vi.spyOn(kernel, 'retireOriginalCreationKey')
  const stale = await pendingAction(main, original.executionId, 'releasePendingLaunch')
  expect(stale).toMatchObject({ state: 'unknown', admission: { executionId: original.executionId }, latestConfirmed: null })
  expect(stale).not.toHaveProperty('releasedLaunch')
  expect(retire).not.toHaveBeenCalled()
  await expect(main.rpc.call('toolkit.stop', { toolId: 'interactive', input: { executionId: null, cancelPendingLaunch: true } })).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  await expect(main.rpc.call('toolkit.stop', { toolId: 'interactive', input: { executionId: original.executionId, cancelPendingLaunch: true, releasePendingLaunch: true } })).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  await expect(main.rpc.call('toolkit.stop', { toolId: 'interactive', input: { executionId: 'unrelated-private-id', cancelPendingLaunch: true } })).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' })
  expect(retire).not.toHaveBeenCalled()
  vi.spyOn(ToolkitReceiptStore.prototype, 'save').mockRejectedValueOnce(new Error('Private Toolkit receipt disk write failed'))
  const unresolved = await pendingAction(main, original.executionId, 'cancelPendingLaunch')
  expect(unresolved).toMatchObject({ state: 'unknown', pendingLaunch: 'retirement-unconfirmed', latestConfirmed: null,
    admission: { executionId: original.executionId, reason: original.reason } })
  expect(unresolved.reason).toContain('Private Toolkit receipt disk write failed')
  const stopped = await inspect()
  expect(stopped).toMatchObject({ admission: null, state: 'stopped', latestConfirmed: { executionId: original.executionId, invocationId: original.invocationId,
    cancelledPendingLaunch: true, run: null, reason: original.reason } })
  expect((await main.sdk.observeCreationRetirement(createOperationKey(original.executionId))).observation.outcome).toBe('retired')
  expect(retire).toHaveBeenCalledOnce()
  expect(pending.start).toHaveBeenCalledOnce()
  expect(await main.sdk.list()).toEqual([])
  await main.restart()
  expect(await inspect()).toMatchObject({ admission: null, latestConfirmed: { executionId: original.executionId, cancelledPendingLaunch: true } })
  expect(await main.sdk.list()).toEqual([])
  await record('tui-fenced-pending-launch', { executionId: original.executionId, snapshot: stopped, nativeOutcome: 'retired', afterMainRestartRunCount: 0 })
})

it('rejects pending launch mutations before public forwarding for unauthenticated and remote principals', async () => {
  const forwardControl = vi.fn(async () => { throw new Error('Private observation reached forwarding') })
  const service = new AgentMuxRpcService({ forwardControl })
  const principal = { kind: 'user' as const, id: `local-user:${process.getuid?.() ?? 'current'}` }
  for (const input of [{ executionId: 'private-exact', cancelPendingLaunch: true }, { executionId: 'private-exact', releasePendingLaunch: true }]) {
    await expect(service.call('toolkit.stop', { toolId: 'interactive', input })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    await expect(service.call('toolkit.stop', { toolId: 'interactive', input }, { transport: 'http', principal })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    await expect(service.call('toolkit.stop', { toolId: 'interactive', input }, { transport: 'relay', principal: { kind: 'device', id: 'remote-device' } }))
      .rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    await expect(service.call('toolkit.stop', { toolId: 'interactive', input }, { transport: 'unix', principal: { kind: 'user', id: 'unexpected-uid' } }))
      .rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  }
  expect(forwardControl).not.toHaveBeenCalled()
  await expect(service.call('toolkit.stop', { toolId: 'interactive', input: { executionId: 'private-exact' } }, { transport: 'http', principal }))
    .rejects.toThrow('Private observation reached forwarding')
  expect(forwardControl).toHaveBeenCalledOnce()
})

it('reconciles a lost retirement reply and preserves the original Run when the dispatched Start wins', async () => {
  const main = await nativeMain(), pending = await pendingLaunch(main, 'Private Native Start delivery was unconfirmed')
  const { original } = pending
  const kernel = privateKernel(main), retire = kernel.retireOriginalCreationKey.bind(kernel)
  const retireCall = vi.spyOn(kernel, 'retireOriginalCreationKey').mockImplementationOnce(async (...args) => {
    await pending.applyOriginallyDispatchedStart()
    return await retire(...args)
  })
  const cancel = main.core.retireTerminalCreation.bind(main.core)
  const lost = vi.spyOn(main.core, 'retireTerminalCreation').mockImplementationOnce(async input => { await cancel(input); throw Error('Private retirement reply was lost') })
  const recovered = await pendingAction(main, original.executionId, 'cancelPendingLaunch')
  expect(recovered).toMatchObject({ state: 'running', admission: { executionId: original.executionId, invocationId: original.invocationId }, latestConfirmed: null })
  expect(lost).toHaveBeenCalledOnce()
  expect(retireCall).toHaveBeenCalledOnce()
  expect(pending.start).toHaveBeenCalledOnce()
  const run = recovered.admission!.run!
  expect((await main.sdk.observeCreation(createOperationKey(original.executionId))).observation).toMatchObject({ outcome: 'retained', run: { id: run.runId } })
  expect((await main.core.runtimeSubject({ kind: 'terminal-run', runId: run.runId })).run.state).toBe('running')
  await record('tui-retirement-retained-original', { executionId: original.executionId, runId: run.runId, nativeOutcome: 'retained' })
})

it('requires the original Runtime to return before releasing an authorized retirement without an observed outcome', async () => {
  const main = await nativeMain(), { original, start } = await pendingLaunch(main, 'Private original Start is unconfirmed')
  const kernel = privateKernel(main), inspectOriginal = kernel.inspectRetainedStart.bind(kernel)
  let offline = false
  vi.spyOn(kernel, 'inspectRetainedStart').mockImplementation(async id => {
    if (offline && id === original.executionId) throw new Error('Private original Native inspection is offline')
    return await inspectOriginal(id)
  })
  const retire = vi.spyOn(kernel, 'retireOriginalCreationKey').mockImplementationOnce(async () => {
    offline = true
    throw new Error('Private retirement dispatch was disconnected')
  })
  const requested = await pendingAction(main, original.executionId, 'cancelPendingLaunch')
  expect(requested).toMatchObject({ state: 'unknown', pendingLaunch: 'retirement-unconfirmed', admission: { executionId: original.executionId, reason: original.reason } })
  const rejected = await pendingAction(main, original.executionId, 'releasePendingLaunch')
  expect(rejected).toMatchObject({ state: 'unknown', pendingLaunch: 'retirement-unconfirmed', admission: { executionId: original.executionId } })
  expect(rejected).not.toHaveProperty('releasedLaunch')
  offline = false
  const observed = await inspect()
  expect(observed).toMatchObject({ state: 'unknown', pendingLaunch: 'retirement-unavailable', admission: { executionId: original.executionId } })
  expect(observed).not.toHaveProperty('releasedLaunch')
  const released = await pendingAction(main, original.executionId, 'releasePendingLaunch')
  expect(released).toMatchObject({ state: 'idle', admission: null, releasedLaunch: { state: 'unknown', executionId: original.executionId, reason: original.reason } })
  expect((await main.rpc.call('terminal.creation.inspect', { hostId: 'local', operationId: original.executionId })).admission)
    .toMatchObject({ phase: 'dispatched', run: null, retirement: { phase: 'dispatched', native: null } })
  expect(retire).toHaveBeenCalledOnce()
  expect(start).toHaveBeenCalledOnce()
  expect(await main.sdk.list()).toEqual([])
  await record('tui-retirement-unconfirmed-release', { executionId: original.executionId, requested, observed, released, retirementAttempts: 1 })
})

it('uses a real legacy SQLite role blocker to preserve the unknown original and admits only a separate manual Run through CLI', async () => {
  const main = await nativeMain({ fileSessionStore: true, beforeRegister: async directory => {
    const store = new AgentMuxFileAgentSessionStore(join(directory, 'agent-sessions.json'))
    const legacyId = 'fixture-legacy-agent'
    await store.compareAndSwapMetadata(null, { kind: 'agent', hostId: 'local', agentSessionId: legacyId, providerId: 'codex', executorId: 'codex',
      workspacePath: join(directory, 'work'), run: { runId: 'fixture-legacy-run' }, retiredRuns: [], hookBindingId: 'fixture-hook', hookToken: 'fixture-secret', createdAt: 1, updatedAt: 1 })
    const db = new DatabaseSync(store.path)
    try { db.prepare("UPDATE sessions SET json=json_remove(json,'$.nativeCreationKeys') WHERE id=?").run(legacyId) } finally { db.close() }
  } })
  const pending = await pendingLaunch(main, 'Private original legacy Start reply was lost'), { original } = pending
  const retirement = vi.spyOn(privateKernel(main), 'retireOriginalCreationKey')
  const blocked = await pendingAction(main, original.executionId, 'cancelPendingLaunch')
  expect(blocked).toMatchObject({ pendingLaunch: 'retirement-unavailable', admission: { executionId: original.executionId, reason: original.reason } })
  expect(retirement).not.toHaveBeenCalled()
  expect((await main.rpc.call('terminal.creation.inspect', { hostId: 'local', operationId: original.executionId, includeRetirementBlocker: true })).admission)
    .toMatchObject({ phase: 'dispatched', run: null, retirementBlocker: 'agent-role-unconfirmed' })
  const released = await pendingAction(main, original.executionId, 'releasePendingLaunch')
  expect(released).toMatchObject({ state: 'idle', admission: null, latestConfirmed: null, releasedLaunch: { executionId: original.executionId,
    invocationId: original.invocationId, state: 'unknown', run: null, reason: original.reason } })
  expect(retirement).not.toHaveBeenCalled()
  expect((await main.sdk.observeCreationRetirement(createOperationKey(original.executionId))).observation.outcome).toBe('not_retired')
  expect(await main.sdk.list()).toEqual([])
  await main.restart()
  expect(await inspect()).toMatchObject({ state: 'idle', releasedLaunch: { executionId: original.executionId }, reason: original.reason })
  expect(await main.sdk.list()).toEqual([])
  await expect(main.rpc.call('toolkit.run', { toolId: 'interactive', input: { invocationId: original.invocationId, expectedRevision: original.definition.revision,
    expectedLatestExecutionId: original.expectedLatestExecutionId } })).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' })
  const fresh = (await oneCli('toolkit', 'run', 'interactive')).result.snapshot as ToolkitScriptSnapshot
  expect(fresh.admission).toMatchObject({ expectedLatestExecutionId: original.executionId, state: 'running' })
  expect(fresh.admission?.executionId).not.toBe(original.executionId)
  expect(fresh).not.toHaveProperty('releasedLaunch')
  const history = JSON.parse(await readFile(join(main.directory, 'toolkit-receipts.json'), 'utf8')).tools.interactive.releasedLaunches
  expect(history).toEqual([released.releasedLaunch])
  expect((await main.sdk.list()).map(run => run.id)).toEqual([fresh.admission?.run?.runId])
  await record('tui-legacy-release', { executionId: original.executionId, blocked, released, manualRunId: fresh.admission?.run?.runId, nativeRetirement: 'not_retired' })
})

it('loads a real TUI through public CLI and shares the ordinary terminal attachment, input and replay', async () => {
  const main = await nativeMain()
  const definition = await add(main)
  const snapshot = await inspect(), execution = snapshot.admission!, run = execution.run!
  const control = { kind: 'terminal' as const, hostId: run.hostId, runId: run.runId, run: { runId: run.runId } }
  expect((await oneCli('toolkit', 'ls')).result.tools).toContainEqual(expect.objectContaining({ toolId: 'interactive', mode: 'tui' }))
  const scan = vi.spyOn(main.core, 'listRuns')
  await inspect()
  expect(scan).not.toHaveBeenCalled()
  scan.mockRestore()
  await until(async () => expect((await main.core.runtimeSubject({ kind: 'terminal-run', runId: run.runId })).run.latestOutputBytes).toBeGreaterThan(70000))
  expect(await inspect()).toMatchObject({ state: 'running', admission: { text: '', run } })
  expect((await inspect()).admission).not.toHaveProperty('document')
  const metadata = await main.invoke('sessions:refresh', control)
  expect(metadata).toMatchObject({ kind: 'terminal', control, processState: 'running' })
  const first = unwrapSessionObservationResult<SessionAttachResult>(await main.invoke('sessions:attach', control, 0))
  expect(first.session.control).toEqual(control)
  expect(first.terminal).toBeTruthy()
  await main.invoke('sessions:resize', first.attachmentId, 92, 28)
  await main.invoke('sessions:write', control, 'hello', 'user')
  await until(async () => {
    const replay = await main.core.readRunReplay({ runId: run.runId }, 0, 'raw')
    expect(replay.replay.map(chunk => new TextDecoder().decode(chunk.dataBytes)).join('')).toContain('INPUT:hello')
  })
  await main.invoke('sessions:detach', first.attachmentId)
  expect((await main.core.runtimeSubject({ kind: 'terminal-run', runId: run.runId })).run.state).toBe('running')
  const reopened = unwrapSessionObservationResult<SessionAttachResult>(await main.invoke('sessions:attach', control, 0))
  expect(reopened.session.control).toEqual(control)
  await main.invoke('sessions:detach', reopened.attachmentId)
  const changed = join(main.directory, 'changed.json')
  await writeFile(changed, JSON.stringify({ changes: { mode: 'script', enabled: false, script: 'console.log("next")' }, expected: { mode: 'tui', enabled: true, script: program } }))
  await oneCli('toolkit', 'update', 'interactive', '--input', changed)
  expect(await inspect()).toMatchObject({ definition: { mode: 'script', enabled: false }, admission: { executionId: execution.executionId, definition: { mode: 'tui', revision: definition.revision }, run } })
  await stop(main, execution.executionId)
  await until(async () => expect(await inspect()).toMatchObject({ admission: null, latestConfirmed: { run, state: 'stopped', text: '' } }))
  expect((await main.core.runtimeSubject({ kind: 'terminal-run', runId: run.runId })).run.state).not.toBe('running')
  await record('tui-public-terminal', { definition, originalRun: run, originalExecution: execution.executionId, reopenedRun: reopened.session.control.run, outputOverBudget: true, terminalRetained: true })
})

it('normal Main disposal and reconstruction reconnects the exact TUI and does not restart on configuration saves', async () => {
  const main = await nativeMain()
  await add(main)
  const original = (await inspect()).admission!
  await main.restart()
  await until(async () => expect(await inspect()).toMatchObject({ state: 'running', admission: { executionId: original.executionId, run: original.run } }))
  const before = await main.core.listRuns()
  const path = join(main.directory, 'name.json')
  await writeFile(path, JSON.stringify({ changes: { statusBar: 'icon' } }))
  await oneCli('toolkit', 'update', 'interactive', '--input', path)
  expect((await main.core.listRuns()).map(run => run.runId)).toEqual(before.map(run => run.runId))
  expect((await inspect()).admission!.run).toEqual(original.run)
  await stop(main, original.executionId)
  await until(async () => expect((await inspect()).admission).toBeNull())
  const ended = (await inspect()).latestConfirmed!
  await inspect()
  expect((await main.core.listRuns()).map(run => run.runId)).toEqual(before.map(run => run.runId))
  await main.restart()
  await until(async () => expect((await inspect()).admission?.run?.runId).toBeTruthy())
  const fresh = (await inspect()).admission!
  expect(fresh.run).not.toEqual(original.run)
  expect((await inspect()).latestConfirmed?.executionId).toBe(ended.executionId)
  await record('tui-owner-recovery', { original: original.run, reconnected: original.run, nextLoad: fresh.run, originalExecution: original.executionId })
})
