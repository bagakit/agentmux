import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { AgentMuxFileAgentSessionStore, connectAgentMuxRpc, parseTerminalInspection, type AgentMuxStoredAgentSession } from '@agentmux/core'
import { startAgentMuxHost } from '../src/host.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
// Use Core's pinned SDK, not another daemon/protocol implementation.
import { activateRuntime } from '../../../packages/core/node_modules/@ctxmux/sdk/dist/index.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) try { await close() } catch (error) { failures.push(error) }
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (failures.length) throw new AggregateError(failures, 'Private native fixture cleanup failed.')
})
async function fixture() {
  const root = await mkdtemp('/tmp/to-'); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const env = objectCliEnvironment(root)
  for (const [name, value] of Object.entries(env)) if (name.startsWith('AGENTMUX_')) vi.stubEnv(name, value!)
  await mkdir(join(root, 'state/ctxmux'), { recursive: true, mode: 0o700 })
  const native = await activateRuntime({ executable: resolve('packages/core/vendor/ctxmux', `${process.platform}-${process.arch}`, 'bin/ctxmuxd'),
    socketPath: join(root, 'ctxmux.sock'), stateDir: join(root, 'state/ctxmux'),
    resourceLimits: { hot_output_bytes: 65536, run_output_bytes: 65536, durable_run_output_bytes: 65536, durable_replay_bytes: 131072 },
    childDisposition: { mode: 'detached', stderr: 'pipe' } }).catch(error => { throw new Error(String(error) + ': ' + error.stderr, { cause: error }) })
  expect(native.spawned).toBe(true); cleanup.push(() => native.dispose({ shutdown: true }))
  const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
  const host = await startAgentMuxHost({ store, socketPath: join(root, 'control.sock'), desktopSocketPath: join(root, 'desktop.sock'), mobileBuildDirectory: join(root, 'absent-mobile') })
  cleanup.push(() => host.dispose()); await host.client.connect()
  const run = await host.client.createTerminal({ command: process.execPath, args: ['-e',
    "process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write(Buffer.from([82,69,65,68,89,58,255,195,169]));process.stdin.on('data',d=>{if(d[0]===33)process.stdout.write(Buffer.alloc(262144,120));else process.stdout.write(Buffer.concat([Buffer.from('<'),d,Buffer.from('>')]))})"],
    workspacePath: root, createOperationId: 'private-terminal' })
  cleanup.push(() => host.client.stopTerminal({ runId: run.runId }))
  await vi.waitFor(async () => expect((await host.client.inspectTerminal({ runtimeId: host.client.terminalCreationRuntimeIdentity().runtimeId, run: { runId: run.runId } })).run.latestOutputBytes).toBeGreaterThanOrEqual(9))
  const target = { hostId: 'local', runtimeId: host.client.terminalCreationRuntimeIdentity().runtimeId, run: { runId: run.runId } }
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(root, 'control.sock') } }); cleanup.push(() => rpc.dispose())
  const cliEnv = objectCliEnvironment(root, { AGENTMUX_RPC_ENDPOINT: `unix:${join(root, 'control.sock')}` })
  const args = ['--host', 'local', '--runtime', target.runtimeId, '--run', run.runId]
  return { root, native, host, store, run, target, rpc, cliEnv, args, cli: (action: string, extra: string[] = []) => runCompiledObjectCli(['terminal', action, ...args, ...extra], cliEnv) }
}
const frames = (value: string) => value.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
const output = (rows: ReturnType<typeof frames>) => rows.flatMap(row => row.params?.event?.type === 'output' ? [row.params.event.data] : [])

it('compiled CLI reads exact native bytes through actual Host and preserves another reader and input after cancellation', async () => {
  const f = await fixture()
  const discovered = await runCompiledObjectCli(['terminal', 'ls', '--host', 'local', '--limit', '1'], f.cliEnv)
  expect(discovered.code, discovered.stderr).toBe(0)
  expect(JSON.parse(discovered.stdout).result.items[0].target).toEqual(f.target)
  const inspected = await f.cli('inspect'); expect(inspected.code, inspected.stderr).toBe(0)
  expect(JSON.parse(inspected.stdout).result).toMatchObject({ target: f.target, run: { kind: 'terminal', runId: f.run.runId, pid: f.run.pid } })
  const replay = await f.cli('output'); expect(replay.code, replay.stderr).toBe(0)
  const original = output(frames(replay.stdout))
  expect(original.length).toBeGreaterThan(0)
  expect(Buffer.concat(original.map(p => Buffer.from(p.dataBase64, 'base64')))).toEqual(Buffer.from([82,69,65,68,89,58,255,195,169]))
  const visible: Buffer[] = []
  await f.host.client.attachTerminal(f.run.runId, 9)
  const off = f.host.client.onRunEvent(f.run.runId, event => { if (event.type === 'terminal-output') visible.push(Buffer.from(event.dataBytes)) })
  cleanup.push(async () => { off(); await f.host.client.releaseRunAttachment(f.target.run) })
  const independent: Buffer[] = []
  const observer = await f.host.client.observeTerminalOutput(f.target, 9, event => { if (event.type === 'data') independent.push(Buffer.from(event.dataBytes)) })
  cleanup.push(() => observer.close())
  const load = vi.spyOn(f.store, 'loadRetiredAgentSessions')
  const cli = spawn(process.execPath, [resolve('packages/core/bin/amux'), 'terminal', 'output', ...f.args, '--after-byte', '9', '--follow'], { env: f.cliEnv, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams
  let text = '', errors = ''; cli.stdout.on('data', chunk => { text += chunk }); cli.stderr.on('data', chunk => { errors += chunk })
  cleanup.push(async () => { if (cli.exitCode === null && cli.signalCode === null) { cli.kill('SIGINT'); await new Promise(resolve => cli.once('exit', resolve)) } })
  await vi.waitFor(() => expect(text, errors).toContain('subscriptionId'))
  const readsAtOpen = load.mock.calls.length
  await f.host.client.writeTerminalBytes(f.target.run, 'first')
  await vi.waitFor(() => expect(text).toContain(Buffer.from('<first>').toString('base64')))
  const exited = new Promise(resolve => cli.once('exit', resolve)); cli.kill('SIGINT'); await exited
  await f.host.client.writeTerminalBytes(f.target.run, 'second')
  await vi.waitFor(() => expect(Buffer.concat(independent).toString()).toContain('<second>'))
  await vi.waitFor(() => expect(Buffer.concat(visible).toString()).toContain('<second>'))
  expect(load.mock.calls.length).toBe(readsAtOpen) // No retained Session reads per output chunk.
  expect((await f.host.client.inspectTerminal(f.target)).run.state).toBe('running')
})

it('reports a real retained-output Gap and rejects wrong Host/Runtime and active/retired Agent Runs without touching the process', async () => {
  const f = await fixture()
  await f.host.client.writeTerminalBytes(f.target.run, '!')
  await vi.waitFor(async () => expect((await f.host.client.inspectTerminal(f.target)).firstAvailableByte).toBeGreaterThan(0))
  const replay = await f.cli('output'); expect(replay.code, replay.stderr).toBe(0)
  const opening = frames(replay.stdout)[0].result.initial
  expect(opening.gap).toMatchObject({ requestedAfterByte: 0, firstAvailableByte: opening.firstAvailableByte })
  expect(output(frames(replay.stdout))[0].startByte).toBe(opening.firstAvailableByte)
  await expect(f.rpc.call('terminal.inspect', { target: { ...f.target, hostId: 'another-host' } })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  await expect(f.rpc.call('terminal.inspect', { target: { ...f.target, runtimeId: 'another-runtime' } })).rejects.toMatchObject({ code: 'TERMINAL_RUNTIME_MISMATCH' })
  const stored: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'retained-agent', providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: f.root,
    run: f.target.run, retiredRuns: [], hookBindingId: 'private-hook', hookToken: 'private-token', createdAt: 1, updatedAt: 1 }
  await f.store.compareAndSwap(null, stored)
  await expect(f.rpc.call('terminal.inspect', { target: f.target })).rejects.toMatchObject({ code: 'RUN_KIND_MISMATCH' })
  await f.store.compareAndSwap(stored, null)
  await f.store.retireRuns([f.target.run])
  // Original retirement survives metadata disappearance and a reader is still not an Agent grant.
  const denied = await f.cli('output'); expect(denied.code).not.toBe(0); expect(denied.stderr).toContain('RUN_KIND_MISMATCH')
  expect((await f.native.client.status(f.run.runId)).state.type).toBe('running')
})

it('pages discovery on the original Native owner and never leaks active or retired Agent targets', async () => {
  const f = await fixture()
  const second = await f.host.client.createTerminal({ command: process.execPath, args: ['-e', 'process.stdin.resume()'], workspacePath: f.root, createOperationId: 'second-private-terminal' })
  cleanup.push(() => f.host.client.stopTerminal({ runId: second.runId }))
  const page = await f.rpc.call('terminal.ls', { hostId: 'local', limit: 1 })
  expect(page.items).toHaveLength(1); expect(page.nextCursor).not.toBeNull()
  const next = await f.rpc.call('terminal.ls', { hostId: 'local', limit: 1, cursor: page.nextCursor! })
  expect(next.items).toHaveLength(1); expect(next.nextCursor).toBeNull()
  expect(new Set([...page.items, ...next.items].map(item => item.run.runId))).toEqual(new Set([f.run.runId, second.runId]))
  await expect(f.rpc.call('terminal.ls', { hostId: 'local', cursor: { ...page.nextCursor!, ownerInstanceId: 'another-owner' } })).rejects.toMatchObject({ code: 'TERMINAL_CURSOR_EXPIRED' })
  await f.store.retireRuns([{ runId: second.runId }])
  const retained = await f.rpc.call('terminal.ls', { hostId: 'local' })
  expect(retained.items.map(item => item.run.runId)).toEqual([f.run.runId])
})

it('does not treat an unavailable persisted ownership read as raw permission or stop the healthy process', async () => {
  const f = await fixture()
  const ownership = vi.spyOn(f.store, 'hasAgentRun').mockRejectedValue(new Error('private original Run ownership unavailable'))
  await expect(f.rpc.call('terminal.inspect', { target: f.target })).rejects.toThrow('private original Run ownership unavailable')
  await expect(f.rpc.subscribe('terminal.output', { target: f.target }, { onInitial() {}, onEvent() {} })).rejects.toThrow('private original Run ownership unavailable')
  expect((await f.native.client.status(f.run.runId)).state.type).toBe('running')
  await f.host.client.writeTerminalBytes(f.target.run, 'still-healthy')
  ownership.mockRestore()
  expect((await f.rpc.call('terminal.inspect', { target: f.target })).run.runId).toBe(f.run.runId)
})

it('binds opening and ordered bytes to the original raw identity and byte cursor', async () => {
  const f = await fixture(), original = await f.rpc.call('terminal.inspect', { target: f.target })
  expect(() => parseTerminalInspection({ ...original, target: { ...f.target, runtimeId: 'wrong' } }, f.target)).toThrow()
  expect(() => parseTerminalInspection({ ...original, run: { ...original.run, runId: 'wrong' } }, f.target)).toThrow()
  const read = await f.cli('output', ['--after-byte', '6']); expect(read.code, read.stderr).toBe(0)
  expect(Buffer.concat(output(frames(read.stdout)).map(p => Buffer.from(p.dataBase64, 'base64')))).toEqual(Buffer.from([255,195,169]))
})
