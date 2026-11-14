import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import * as core from '@agentmux/core'
import { startAgentMuxHost } from '../src/host.js'
import { RuntimeController } from '../../desktop/src/main/runtime-controller.js'
import { connectDesktopAgentMuxHost } from '../../desktop/src/main/desktop-host.js'
import { sessionStopReply, unwrapSessionStopReply } from '../../desktop/src/shared/session-stop-result.js'
import type { AppConfig } from '../../desktop/src/shared/contracts.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { activateRuntime } from '../../../packages/core/node_modules/@ctxmux/sdk/dist/index.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) try { await close() } catch (error) { failures.push(error) }
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (failures.length) throw new AggregateError(failures, 'Private raw control fixture cleanup failed.')
})
async function fixture() {
  const root = await mkdtemp('/tmp/tc-'); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const environment = objectCliEnvironment(root)
  for (const [name, value] of Object.entries(environment)) if (name.startsWith('AGENTMUX_')) vi.stubEnv(name, value!)
  await mkdir(join(root, 'state/ctxmux'), { recursive: true, mode: 0o700 })
  const native = await activateRuntime({ executable: resolve('packages/core/vendor/ctxmux', `${process.platform}-${process.arch}`, 'bin/ctxmuxd'),
    socketPath: join(root, 'ctxmux.sock'), stateDir: join(root, 'state/ctxmux'), childDisposition: { mode: 'detached', stderr: 'pipe' } })
  expect(native.spawned).toBe(true); cleanup.push(() => native.dispose({ shutdown: true }))
  const store = new core.AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
  const options = { store, socketPath: join(root, 'control.sock'), desktopSocketPath: join(root, 'desktop.sock'), mobileBuildDirectory: join(root, 'absent-mobile') }
  let host = await startAgentMuxHost(options); cleanup.push(() => host.dispose()); await host.client.connect()
  const program = "process.stdin.setRawMode(true);process.stdin.resume();process.on('SIGINT',()=>process.stdout.write('NATIVE_SIGINT'));process.stdin.on('data',d=>process.stdout.write(Buffer.concat([Buffer.from('DATA:'),d,Buffer.from(':END')])));process.stdout.write('READY')"
  const run = await host.client.createTerminal({ command: process.execPath, args: ['-e', program], workspacePath: root, createOperationId: 'private-raw-run' })
  const other = await host.client.createTerminal({ command: process.execPath, args: ['-e', program], workspacePath: root, createOperationId: 'private-original-agent' })
  const capability = core.issueAgentCapability(), agent: core.AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'private-original-agent', providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: root,
    run: { runId: other.runId }, retiredRuns: [], hookBindingId: 'private-hook', hookToken: 'private-token', capabilityHash: core.hashAgentCapability(capability), createdAt: 1, updatedAt: 1 }
  await store.compareAndSwap(null, agent)
  type Inner = { registry: { load(host: string): Promise<void> }; kernel: { input: (...args: any[]) => Promise<any>; interrupt: (...args: any[]) => Promise<any>; stop: (...args: any[]) => Promise<any>; status: (...args: any[]) => Promise<any>; client: { attachRecoverableStop: (...args: any[]) => Promise<any> } } }
  const inner = () => host.client as unknown as Inner
  await inner().registry.load('local')
  const runtime = host.client.terminalCreationRuntimeIdentity(), target = { hostId: 'local', runtimeId: runtime.runtimeId, run: { runId: run.runId } }
  await vi.waitFor(async () => expect((await host.client.inspectTerminal(target)).run.latestOutputBytes).toBeGreaterThanOrEqual(5), { timeout: 5000 })
  let rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: options.socketPath } }); cleanup.push(() => rpc.dispose())
  const managed = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: options.socketPath }, credentials: { agentSessionId: agent.agentSessionId, capability } }); cleanup.push(() => managed.dispose())
  const spies = () => ({ input: vi.spyOn(inner().kernel, 'input'), interrupt: vi.spyOn(inner().kernel, 'interrupt'), stop: vi.spyOn(inner().kernel, 'stop'), status: vi.spyOn(inner().kernel, 'status') })
  const originalInput = inner().kernel.input.bind(inner().kernel), originalInterrupt = inner().kernel.interrupt.bind(inner().kernel)
  let calls = spies()
  const env = objectCliEnvironment(root, { AGENTMUX_RPC_ENDPOINT: `unix:${options.socketPath}` })
  const wire = (operationId: string) => ({ target, ownerInstanceId: runtime.instanceId, operationId })
  const cli = (action: 'input' | 'interrupt' | 'stop', input: unknown) => runCompiledObjectCli(['terminal', action, '--input', '-'], env, JSON.stringify(input))
  const inspect = (operationId: string) => rpc.call('terminal.operation.inspect', { hostId: 'local', run: target.run, operationId })
  return { root, store, native, run, other, agent, target, runtime, env, managed, wire, cli, inspect, inner, originalInput, originalInterrupt, get host() { return host }, get rpc() { return rpc }, get calls() { return calls },
    reopen: async () => { for (const spy of Object.values(calls)) spy.mockRestore(); await rpc.dispose(); await managed.dispose(); await host.dispose(); host = await startAgentMuxHost(options); await host.client.connect(); rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: options.socketPath } }); calls = spies() } }
}
const receipt = (result: { code: number | null; stdout: string; stderr: string }, exit = 0) => { expect(result.code, result.stderr || result.stdout).toBe(exit); return JSON.parse(result.stdout).result as core.TerminalControlReceipt }
async function observe(f: Awaited<ReturnType<typeof fixture>>) {
  const chunks: Buffer[] = [], reader = await f.host.client.observeTerminalOutput(f.target, 5, event => { if (event.type === 'data') chunks.push(Buffer.from(event.dataBytes)) })
  cleanup.push(() => reader.close())
  return { chunks, bytes: () => Buffer.concat(chunks) }
}

it('compiled input preserves exact binary bytes, cursor and Native ACK while empty bytes stay an explicit no-op', async () => {
  const f = await fixture(), before = await readFile(f.store.path), out = await observe(f)
  const bytes = Buffer.from([0, 255, 27, 97]), input = { ...f.wire('binary-original'), expectedByte: 0, dataBase64: bytes.toString('base64') }
  const applied = receipt(await f.cli('input', input))
  expect(applied).toMatchObject({ action: 'terminal-input', outcome: 'applied', actor: { kind: 'user' }, target: f.target, acknowledgement: { kind: 'input', runId: f.run.runId, appliedByteRange: { startByte: 0, endByte: 4 }, acceptedThroughByte: 4 }, input: { expectedByte: 0, bytes: 4 } })
  await vi.waitFor(() => expect(out.bytes().includes(Buffer.concat([Buffer.from('DATA:'), bytes, Buffer.from(':END')]))).toBe(true))
  expect(f.calls.input).toHaveBeenCalledTimes(1)
  expect(receipt(await f.cli('input', input))).toEqual(applied)
  // Same JSON meaning, different property order is the same original intent.
  expect(receipt(await f.cli('input', { ...input, target: { run: f.target.run, runtimeId: f.target.runtimeId, hostId: 'local' } }))).toEqual(applied)
  const reads = f.calls.status.mock.calls.length
  expect((await f.inspect(input.operationId)).operation).toEqual(applied)
  expect(f.calls.status).toHaveBeenCalledTimes(reads); expect(f.calls.input).toHaveBeenCalledTimes(1)
  const noop = receipt(await f.cli('input', { ...f.wire('empty-original'), expectedByte: 4, dataBase64: '' }))
  expect(noop).toMatchObject({ outcome: 'no-op', nativeOperationId: null, acknowledgement: { kind: 'input-noop', inputByte: 4 } })
  expect(f.calls.input).toHaveBeenCalledTimes(1)
  const stale = await f.cli('input', { ...input, operationId: 'stale-input' })
  expect(stale.code, stale.stdout).toBe(1)
  expect((await f.native.client.status(f.run.runId)).applied_input_bytes).toBe(4)
  expect(await readFile(f.store.path)).toEqual(before)
})

it('native SIGINT is distinct from a Ctrl-C byte and one original Interrupt is never resubmitted by inspect or same-ID calls', async () => {
  const f = await fixture(), out = await observe(f)
  receipt(await f.cli('input', { ...f.wire('literal-control-c'), expectedByte: 0, dataBase64: Buffer.from([3]).toString('base64') }))
  await vi.waitFor(() => expect(out.bytes().includes(Buffer.from([3]))).toBe(true))
  expect(out.bytes().toString()).not.toContain('NATIVE_SIGINT')
  const input = f.wire('native-interrupt'), accepted = receipt(await f.cli('interrupt', input))
  expect(accepted).toMatchObject({ action: 'terminal-interrupt', nativeOperationId: null, outcome: 'applied', acknowledgement: { kind: 'interrupt', signal: 'SIGINT', runId: f.run.runId } })
  await vi.waitFor(() => expect(out.bytes().toString()).toContain('NATIVE_SIGINT'))
  expect(f.calls.interrupt).toHaveBeenCalledTimes(1); expect(f.calls.input).toHaveBeenCalledTimes(1)
  expect(receipt(await f.cli('interrupt', input))).toEqual(accepted)
  expect((await f.inspect(input.operationId)).operation).toEqual(accepted)
  expect(f.calls.interrupt).toHaveBeenCalledTimes(1)
  expect((await f.native.client.status(f.run.runId)).state.type).toBe('running')
})

it('Stop preserves the prepared native token and acknowledged quiescence without touching another healthy Agent', async () => {
  const f = await fixture(), input = f.wire('original-stop'), before = await readFile(f.store.path)
  const stopped = receipt(await f.cli('stop', input))
  expect(stopped).toMatchObject({ action: 'terminal-stop', outcome: 'applied', target: f.target, acknowledgement: { kind: 'stop', runId: f.run.runId, state: expect.stringMatching(/^(exited|interrupted)$/u), disposition: expect.stringMatching(/^(graceful|forced)$/u) } })
  expect(f.calls.stop).toHaveBeenCalledTimes(1)
  expect(f.calls.stop.mock.calls[0]![0]).toMatchObject({ operationKey: stopped.nativeOperationId, daemonInstance: f.runtime.instanceId, runId: f.run.runId })
  expect((await f.native.client.status(f.run.runId)).state.type).toBe('exited')
  expect(receipt(await f.cli('stop', input))).toEqual(stopped)
  expect((await f.inspect(input.operationId)).operation).toEqual(stopped)
  expect(f.calls.stop).toHaveBeenCalledTimes(1)
  await f.host.client.writeAgent({ agentSessionId: f.agent.agentSessionId, expectedRun: f.agent.run, data: 'healthy-original-agent', source: 'user' })
  expect((await f.native.client.status(f.other.runId)).state.type).toBe('running')
  expect(await readFile(f.store.path)).toEqual(before)
})

it('refuses wrong Native owner, stale cursor, managed actors and active/retired Agent targets while the original Run remains usable', async () => {
  const f = await fixture(), input = f.wire('guard-original')
  await expect(f.managed.call('terminal.stop', input)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await expect(f.managed.call('terminal.operation.inspect', { hostId: 'local', run: f.target.run, operationId: input.operationId })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  for (const bad of [{ ...input, ownerInstanceId: 'different-incarnation' }, { ...input, target: { ...input.target, runtimeId: 'different-runtime' } }])
    await expect(f.rpc.call('terminal.stop', bad)).rejects.toMatchObject({ code: 'TERMINAL_RUNTIME_MISMATCH' })
  await expect(f.rpc.call('terminal.stop', { ...input, target: { ...input.target, run: f.agent.run } })).rejects.toMatchObject({ code: 'RUN_KIND_MISMATCH' })
  await f.store.retireRuns([f.target.run])
  for (const action of ['terminal.stop', 'terminal.interrupt', 'terminal.input'] as const) await expect(f.rpc.call(action, { ...input, ...(action === 'terminal.input' ? { expectedByte: 0, dataBase64: 'YQ==' } : {}) })).rejects.toMatchObject({ code: 'RUN_KIND_MISMATCH' })
  expect(f.calls.input).not.toHaveBeenCalled(); expect(f.calls.interrupt).not.toHaveBeenCalled(); expect(f.calls.stop).not.toHaveBeenCalled()
  await f.host.client.writeTerminalBytes(f.target.run, 'still-healthy')
  expect((await f.native.client.status(f.run.runId)).state.type).toBe('running')
})

it('lost Input and Interrupt ACKs remain unknown across original Host reopen and never replay', async () => {
  const f = await fixture(), actualInput = f.originalInput, actualInterrupt = f.originalInterrupt
  f.calls.input.mockImplementationOnce(async (...args) => { await actualInput(...args); throw new core.AgentMuxError('Private input ACK lost', 'PRIVATE_ACK_LOST') })
  const input = { ...f.wire('lost-input'), expectedByte: 0, dataBase64: 'eA==' }, unknownInput = receipt(await f.cli('input', input), 1)
  expect(unknownInput).toMatchObject({ outcome: 'unknown', acknowledgement: null })
  f.calls.interrupt.mockImplementationOnce(async (...args) => { await actualInterrupt(...args); throw new core.AgentMuxError('Private signal ACK lost', 'PRIVATE_ACK_LOST') })
  const signal = f.wire('lost-interrupt'), unknownSignal = receipt(await f.cli('interrupt', signal), 1)
  expect(unknownSignal).toMatchObject({ outcome: 'unknown', acknowledgement: null })
  expect(receipt(await f.cli('interrupt', signal), 1)).toEqual(unknownSignal)
  expect(receipt(await f.cli('input', input), 1)).toEqual(unknownInput)
  expect((await f.inspect(input.operationId)).operation).toEqual(unknownInput); expect((await f.inspect(signal.operationId)).operation).toEqual(unknownSignal)
  expect(f.calls.input).toHaveBeenCalledTimes(1); expect(f.calls.interrupt).toHaveBeenCalledTimes(1)
  await f.reopen()
  expect(receipt(await f.cli('input', input), 1)).toEqual({ ...unknownInput, diskDurability: 'unconfirmed' })
  expect(receipt(await f.cli('interrupt', signal), 1)).toEqual({ ...unknownSignal, diskDurability: 'unconfirmed' })
  expect(f.calls.input).not.toHaveBeenCalled(); expect(f.calls.interrupt).not.toHaveBeenCalled(); expect(f.calls.stop).not.toHaveBeenCalled()
  expect((await f.native.client.status(f.run.runId)).state.type).toBe('running')
  receipt(await f.cli('input', { ...f.wire('new-explicit-input'), expectedByte: 1, dataBase64: 'eQ==' }))
  receipt(await f.cli('interrupt', f.wire('new-explicit-interrupt')))
  expect((await f.inspect(input.operationId)).operation).toMatchObject({ outcome: 'unknown' })
  expect((await f.inspect(signal.operationId)).operation).toMatchObject({ outcome: 'unknown' })
})

it('retains an obtained Native ACK when the admitted record disappears before receipt settlement, without replay after reopen', async () => {
  const f = await fixture(), input = { ...f.wire('ack-before-metadata-loss'), expectedByte: 0, dataBase64: 'eA==' }
  const operations = (f.host.client as unknown as { runControlOperations(): { path(id: string): string } }).runControlOperations()
  f.calls.input.mockImplementationOnce(async (...args) => {
    const ack = await f.originalInput(...args)
    await rm(operations.path(input.operationId))
    return ack
  })
  const response = await f.cli('input', input)
  expect(response.stdout, response.stderr).toContain('acknowledgement')
  const acknowledged = receipt(response, 1)
  expect(acknowledged).toMatchObject({ outcome: 'applied', diskDurability: 'unconfirmed', acknowledgement: {
    kind: 'input', runId: f.run.runId, appliedByteRange: { startByte: 0, endByte: 1 }, acceptedThroughByte: 1 } })
  expect((await f.inspect(input.operationId)).operation).toEqual(acknowledged)
  expect(receipt(await f.cli('input', input), 1)).toEqual(acknowledged)
  expect(f.calls.input).toHaveBeenCalledTimes(1)
  await f.reopen()
  await expect(f.inspect(input.operationId)).rejects.toMatchObject({ code: 'RUN_CONTROL_RECORD_UNCONFIRMED' })
  expect((await f.cli('input', input)).code).toBe(1)
  expect(f.calls.input).not.toHaveBeenCalled()
  await f.host.client.writeTerminalBytes(f.target.run, 'healthy-after-metadata-loss')
  expect((await f.native.client.status(f.run.runId)).state.type).toBe('running')
})

it('a failed Native Stop keeps the original visible Attachment and healthy input, and inspect does not retry Stop', async () => {
  const f = await fixture(), visible: Buffer[] = []
  await f.host.client.attachTerminal(f.run.runId, 5)
  const off = f.host.client.onRunEvent(f.run.runId, event => { if (event.type === 'terminal-output') visible.push(Buffer.from(event.dataBytes)) }); cleanup.push(async () => off())
  const nativeStop = vi.spyOn(f.inner().kernel.client, 'attachRecoverableStop').mockRejectedValueOnce(new Error('Private Stop transport unavailable before effect'))
  const input = f.wire('unknown-stop'), stopped = receipt(await f.cli('stop', input), 1)
  expect(stopped).toMatchObject({ outcome: 'unknown', acknowledgement: null })
  expect(receipt(await f.cli('stop', input), 1)).toEqual(stopped)
  expect((await f.inspect(input.operationId)).operation).toEqual(stopped)
  expect(nativeStop).toHaveBeenCalledTimes(1); expect(f.calls.stop).toHaveBeenCalledTimes(1)
  await f.host.client.writeTerminalBytes(f.target.run, 'reader-survives')
  await vi.waitFor(() => expect(Buffer.concat(visible).toString()).toContain('reader-survives'))
  expect((await f.native.client.status(f.run.runId)).state.type).toBe('running')
  await f.reopen()
  expect(receipt(await f.cli('stop', input), 1)).toEqual({ ...stopped, diskDurability: 'unconfirmed' })
  expect((await f.inspect(input.operationId)).operation).toMatchObject({ outcome: 'unknown' })
  expect(f.calls.stop).not.toHaveBeenCalled()
})

it('the actual Desktop raw Stop consumer uses the same original Core receipt and preserves same-ID readback', async () => {
  const f = await fixture(), runtime = new RuntimeController(f.store, connectDesktopAgentMuxHost)
  cleanup.push(() => runtime.dispose())
  runtime.commit(await runtime.prepare({ hosts: [{ id: 'local', kind: 'local', label: 'Private' }], workspaces: [] } as AppConfig))
  const control = { kind: 'terminal' as const, hostId: 'local', runId: f.run.runId, run: f.target.run }
  const value = await runtime.stopSession(control, 'desktop-raw-stop')
  expect(value).toMatchObject({ action: 'terminal-stop', outcome: 'applied', operationId: 'desktop-raw-stop', acknowledgement: { kind: 'stop' } })
  expect(await runtime.stopSession(control, 'desktop-raw-stop')).toEqual(value)
  expect(f.calls.stop).toHaveBeenCalledTimes(1)
  const reply = await sessionStopReply(async () => ({ ...(value as core.TerminalControlReceipt), outcome: 'unknown', acknowledgement: null }))
  expect(() => unwrapSessionStopReply(reply)).toThrow('desktop-raw-stop')
})

it('settles a late original Input ACK after caller cancellation without replay or blocking unrelated Agent input', async () => {
  const f = await fixture(), input = { ...f.wire('late-original-input'), expectedByte: 0, dataBase64: 'eg==' }
  let release!: () => void, enter!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), entered = new Promise<void>(resolve => { enter = resolve })
  cleanup.push(async () => release())
  f.calls.input.mockImplementationOnce(async (...args) => { const ack = await f.originalInput(...args); enter(); await held; return ack })
  const caller = new AbortController(), sent = f.rpc.call('terminal.input', input, { signal: caller.signal }).catch(error => error)
  await entered; caller.abort(new Error('Private CLI reader cancelled'))
  expect(await sent).toBeInstanceOf(Error)
  expect((await f.inspect(input.operationId)).operation).toMatchObject({ phase: 'dispatching', outcome: 'unknown' })
  await f.host.client.writeAgent({ agentSessionId: f.agent.agentSessionId, expectedRun: f.agent.run, data: 'unrelated-still-healthy', source: 'user' })
  release()
  await vi.waitFor(async () => expect((await f.inspect(input.operationId)).operation).toMatchObject({ phase: 'settled', outcome: 'applied', acknowledgement: { appliedByteRange: { startByte: 0, endByte: 1 } } }), { timeout: 5000 })
  expect(f.calls.input).toHaveBeenCalledTimes(1)
})

it('rechecks original Host authority before Native dispatch without latching healthy terminal input', async () => {
  const f = await fixture(), request: core.TerminalControlRequest = { ...f.wire('revoked-before-dispatch'), action: 'terminal-input', expectedByte: 0, dataBase64: 'YQ==' }
  let checks = 0
  await expect(f.host.client.controlTerminal(request, { actor: { kind: 'user', id: 'original-host-user' }, assertCurrent: () => {
    if (++checks === 3) throw new core.AgentMuxError('Private author revoked after intent save', 'CONTROL_PERMISSION_DENIED')
  } })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect((await f.inspect(request.operationId)).operation).toMatchObject({ phase: 'prepared', outcome: 'not-dispatched' })
  expect(f.calls.input).not.toHaveBeenCalled()
  await f.host.client.writeTerminalBytes(f.target.run, 'healthy-after-author-refusal')
  expect((await f.native.client.status(f.run.runId)).state.type).toBe('running')
})

it('rejects another Native Run ACK before the original target can be normalized into an applied receipt', async () => {
  const f = await fixture(), input = { ...f.wire('wrong-native-input-ack'), expectedByte: 0, dataBase64: 'YQ==' }
  f.calls.input.mockImplementationOnce(async (...args) => { const ack = await f.originalInput(...args); return { ...ack, run: { ...ack.run, runId: 'another-native-run' } } })
  expect(receipt(await f.cli('input', input), 1)).toMatchObject({ outcome: 'unknown', acknowledgement: null })
  expect(f.calls.input).toHaveBeenCalledTimes(1)
  await f.host.client.writeTerminalBytes(f.target.run, 'healthy-after-wrong-ack')
  expect((await f.native.client.status(f.run.runId)).state.type).toBe('running')
})

it('actual Hosted control preserves original actor and refuses forged context or coercible action data before effects', async () => {
  const f = await fixture(), hosted = await core.connectHostedAgentMux({ rpc: f.rpc }); cleanup.push(() => hosted.dispose())
  const input: core.TerminalControlRequest = { ...f.wire('hosted-input'), action: 'terminal-input', expectedByte: 0, dataBase64: 'YQ==' }
  await expect(hosted.controlTerminal({ ...input, action: ['terminal-interrupt'] } as never)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  await expect((hosted.controlTerminal as (...args: unknown[]) => Promise<unknown>)(input, { actor: { kind: 'device', id: 'forged-device' } })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(f.calls.input).not.toHaveBeenCalled(); expect(f.calls.interrupt).not.toHaveBeenCalled(); expect(f.calls.stop).not.toHaveBeenCalled()
  expect(await hosted.controlTerminal(input)).toMatchObject({ outcome: 'applied', actor: { kind: 'user' }, acknowledgement: { kind: 'input', appliedByteRange: { startByte: 0, endByte: 1 } } })
  expect(f.calls.input).toHaveBeenCalledTimes(1)
})
