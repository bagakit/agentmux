import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'
import * as core from '@agentmux/core'
import { RuntimeController } from '../../desktop/src/main/runtime-controller.js'
import { connectDesktopAgentMuxHost } from '../../desktop/src/main/desktop-host.js'
import type { AppConfig } from '../../desktop/src/shared/contracts.js'
import { startAgentMuxHost } from '../src/host.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { activateRuntime } from '../../../packages/core/node_modules/@ctxmux/sdk/dist/index.js'

const directoryAckFault = vi.hoisted(() => ({ directory: '', operationPath: '', armed: false }))
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args)
    if (String(args[0]) === directoryAckFault.directory && args[1] === 'r') {
      const sync = handle.sync.bind(handle)
      handle.sync = async () => {
        if (directoryAckFault.armed && JSON.parse(await fs.readFile(directoryAckFault.operationPath, 'utf8')).receipt.phase === 'settled') {
          directoryAckFault.armed = false
          throw Object.assign(new Error('Private post-rename directory ACK lost'), { code: 'EIO' })
        }
        await sync()
      }
    }
    return handle
  } }
})

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) try { await close() } catch (error) { failures.push(error) }
  directoryAckFault.armed = false; directoryAckFault.directory = ''; directoryAckFault.operationPath = ''
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (failures.length) throw new AggregateError(failures, 'Private posture fixture cleanup failed.')
})
async function fixture() {
  const root = await mkdtemp('/tmp/ap-'); cleanup.push(() => rm(root, { recursive: true, force: true }))
  for (const [name, value] of Object.entries(objectCliEnvironment(root))) if (name.startsWith('AGENTMUX_')) vi.stubEnv(name, value!)
  await mkdir(join(root, 'state/ctxmux'), { recursive: true, mode: 0o700 })
  const native = await activateRuntime({ executable: resolve('packages/core/vendor/ctxmux', `${process.platform}-${process.arch}`, 'bin/ctxmuxd'),
    socketPath: join(root, 'ctxmux.sock'), stateDir: join(root, 'state/ctxmux'), childDisposition: { mode: 'detached', stderr: 'pipe' } })
  expect(native.spawned).toBe(true); cleanup.push(() => native.dispose({ shutdown: true }))
  const protocols = [
    core.createPostureControl({ id: 'access', label: 'Access', modes: [{ id: 'review', label: 'Review', input: '/access review\r' }, { id: 'allow', label: 'Allow', input: '/access allow\r' }] }),
    core.createPostureControl({ id: 'policy', label: 'Policy', modes: [{ id: 'narrow', label: 'Narrow', input: '\x1b[101~' }, { id: 'wide', label: 'Wide', input: '\x1b[102~' }] })
  ]
  const providers = protocols.map((p, i) => ({ ...core.BUILT_IN_AGENT_PROVIDERS[0]!, id: 'private-provider-' + i, catalog: { ...core.BUILT_IN_AGENT_PROVIDERS[0]!.catalog,
    id: 'private-provider-' + i, postureControl: p.control }, planPostureSet: p.planSet }))
  const store = new core.AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
  const options = { store, providers, socketPath: join(root, 'control.sock'), desktopSocketPath: join(root, 'desktop.sock'), mobileBuildDirectory: join(root, 'absent-mobile') }
  let host = await startAgentMuxHost(options); cleanup.push(() => host.dispose()); await host.client.connect()
  const capability = core.issueAgentCapability(), sessions: core.AgentMuxStoredAgentSession[] = []
  for (let i = 0; i < providers.length; i++) {
    const run = await host.client.createTerminal({ command: process.execPath, args: ['-e', "process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write('READY');process.stdin.on('data',d=>process.stdout.write(d))"],
      workspacePath: root, createOperationId: 'private-posture-' + i })
    const record: core.AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'private-agent-' + i, providerId: providers[i]!.catalog.id,
      executorId: providers[i]!.id, hostId: 'local', workspacePath: root, run: { runId: run.runId }, retiredRuns: [],
      hookBindingId: 'private-hook', hookToken: 'private-token', capabilityHash: core.hashAgentCapability(capability), createdAt: 1, updatedAt: 1 }
    await store.compareAndSwap(null, record); sessions.push(record)
  }
  type Inner = { registry: { load(host: string): Promise<void> }; kernel: { input: (...args: any[]) => Promise<any> } }
  await (host.client as unknown as Inner).registry.load('local')
  const originalInput = (host.client as unknown as Inner).kernel.input.bind((host.client as unknown as Inner).kernel)
  let input = vi.spyOn((host.client as unknown as Inner).kernel, 'input')
  const endpoint = { transport: 'unix' as const, path: options.socketPath }
  const rpc = await core.connectAgentMuxRpc({ endpoint }); cleanup.push(() => rpc.dispose())
  const managed = await core.connectAgentMuxRpc({ endpoint, credentials: { agentSessionId: sessions[0]!.agentSessionId, capability } }); cleanup.push(() => managed.dispose())
  const cliEnv = objectCliEnvironment(root, { AGENTMUX_RPC_ENDPOINT: `unix:${options.socketPath}` })
  const cli = (action: string, args: string[] = [], body = '') => runCompiledObjectCli(['agent', 'posture', action, ...args], cliEnv, body)
  const declaration = async (i = 0) => {
    const session = sessions[i]!, result = await cli('inspect', ['--host', 'local', '--session', session.agentSessionId, '--run', session.run.runId])
    expect(result.code, result.stderr).toBe(0)
    const value = JSON.parse(result.stdout).result as Extract<core.PostureInspection, { kind: 'declaration' }>
    expect(value).toMatchObject({ kind: 'declaration', currentMode: { status: 'unknown' }, control: protocols[i]!.control })
    return value
  }
  const request = async (operationId: string, i = 0): Promise<core.PostureSet> => {
    const observed = await declaration(i)
    return { target: observed.target, operationId, controlId: observed.control!.id, modeId: observed.control!.modes[1]!.id, expectedControlDigest: observed.controlDigest! }
  }
  return { root, native, store, sessions, providers, originalInput, rpc, managed, cli, declaration, request, get host() { return host }, get input() { return input },
    reopen: async () => { input.mockRestore(); await host.dispose(); host = await startAgentMuxHost(options); await host.client.connect(); input = vi.spyOn((host.client as unknown as Inner).kernel, 'input') } }
}
const parsed = (result: { code: number | null; stdout: string; stderr: string }, code = 0) => { expect(result.code, result.stderr || result.stdout).toBe(code); return JSON.parse(result.stdout).result as core.PostureReceipt }

it('compiled CLI resolves two original Provider protocols and retains exact byte ACK without claiming current mode', async () => {
  const f = await fixture(), originalStore = await readFile(f.store.path)
  for (let i = 0; i < 2; i++) {
    const request = await f.request('intent-' + i, i), before = f.input.mock.calls.length
    const receipt = parsed(await f.cli('set', ['--input', '-'], JSON.stringify(request)))
    expect(receipt).toMatchObject({ action: 'agent-posture', operationId: request.operationId, target: request.target, phase: 'settled', outcome: 'applied', diskDurability: 'confirmed', actor: { kind: 'user' } })
    expect(receipt.acknowledgement!.runId).toBe(request.target.expectedRun.runId)
    expect(f.input).toHaveBeenCalledTimes(before + 1)
    expect(f.input.mock.calls.at(-1)![1]).toMatchObject({ operationId: receipt.nativeOperationId, data: f.providers[i]!.planPostureSet(request.modeId).data })
    expect(parsed(await f.cli('set', ['--input', '-'], JSON.stringify(request)))).toEqual(receipt)
    expect(f.input).toHaveBeenCalledTimes(before + 1)
    const inspected = await f.cli('inspect', ['--host', 'local', '--session', request.target.agentSessionId, '--operation-id', request.operationId])
    expect(inspected.code, inspected.stderr).toBe(0); expect(JSON.parse(inspected.stdout).result.operation).toEqual(receipt)
    expect((await f.declaration(i)).currentMode).toEqual({ status: 'unknown' })
  }
  expect(await readFile(f.store.path)).toEqual(originalStore)
})

it('rejects managed self-grants, stale exact objects and changed declarations without disturbing native input', async () => {
  const f = await fixture(), request = await f.request('guard-intent')
  await expect(f.managed.call('agent.posture.set', request)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await expect(core.connectHostedAgentMux({ rpc: f.managed })).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
  const cases = [
    { ...request, target: { ...request.target, expectedRun: { runId: 'different-run' } } },
    { ...request, target: { ...request.target, providerId: 'different-provider' } },
    { ...request, target: { ...request.target, runtimeId: 'different-runtime' } },
    { ...request, expectedControlDigest: 'sha256:' + '0'.repeat(64) },
    { ...request, controlId: 'different-control' }, { ...request, modeId: 'undefined-mode' }
  ]
  for (const value of cases) await expect(f.rpc.call('agent.posture.set', value)).rejects.toThrow()
  expect(f.input).not.toHaveBeenCalled()
  const receipt = await f.rpc.call('agent.posture.set', request)
  expect(receipt.outcome).toBe('applied')
  await expect(f.host.client.setAgentPosture(request, { actor: { kind: 'device', id: 'different-original-actor' } })).rejects.toMatchObject({ code: 'RUN_CONTROL_OPERATION_CONFLICT' })
  expect(f.input).toHaveBeenCalledTimes(1)
  const hosted = await core.connectHostedAgentMux({ rpc: f.rpc }); cleanup.push(() => hosted.dispose())
  expect(await hosted.setAgentPosture({ ...request, operationId: 'hosted-original-intent' })).toMatchObject({ outcome: 'applied', actor: receipt.actor })
  expect(f.input).toHaveBeenCalledTimes(2)
  await f.host.client.writeAgent({ agentSessionId: request.target.agentSessionId, expectedRun: request.target.expectedRun, data: 'healthy-user', source: 'user' })
  expect((await f.native.client.status(request.target.expectedRun.runId)).state.type).toBe('running')
})

it('keeps a lost native ACK unknown across original Core reopen and never replays during same-ID inspect or set', async () => {
  const f = await fixture(), request = await f.request('lost-ack')
  // Call the actual Native owner, then lose only that ACK at the Core boundary.
  const original = f.originalInput
  f.input.mockImplementationOnce(async (...args) => { await original(...args); throw new core.AgentMuxError('Private ACK reader lost', 'PRIVATE_ACK_LOST') })
  const receipt = parsed(await f.cli('set', ['--input', '-'], JSON.stringify(request)), 1)
  expect(receipt).toMatchObject({ phase: 'settled', outcome: 'unknown', acknowledgement: null, diskDurability: 'confirmed' })
  expect(f.input).toHaveBeenCalledTimes(1)
  for (let n = 0; n < 2; n++) {
    expect(parsed(await f.cli('set', ['--input', '-'], JSON.stringify(request)), 1)).toEqual(receipt)
    const view = await f.cli('inspect', ['--host', 'local', '--session', request.target.agentSessionId, '--operation-id', request.operationId])
    expect(view.code, view.stderr).toBe(0); expect(JSON.parse(view.stdout).result.operation).toEqual(receipt)
  }
  expect(f.input).toHaveBeenCalledTimes(1)
  const query = { hostId: 'local', agentSessionId: request.target.agentSessionId, operationId: request.operationId }
  const script = `const core = await import(${JSON.stringify(pathToFileURL(resolve('packages/core/dist/index.js')).href)}); const client = new core.AgentMuxClient({store:new core.AgentMuxFileAgentSessionStore(process.argv[1])}); console.log(JSON.stringify(await client.inspectAgentPosture(JSON.parse(process.argv[2])))); await client.dispose()`
  const reopened = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, f.store.path, JSON.stringify(query)], { env: objectCliEnvironment(f.root) })
  expect(JSON.parse(reopened.stdout).operation).toEqual({ ...receipt, diskDurability: 'unconfirmed' }) // New OS process, no Native connect/input.
  await f.reopen()
  expect(parsed(await f.cli('set', ['--input', '-'], JSON.stringify(request)), 1)).toEqual({ ...receipt, diskDurability: 'unconfirmed' })
  expect(f.input).not.toHaveBeenCalled()
  expect((await f.native.client.status(request.target.expectedRun.runId)).state.type).toBe('running')
})

it('strictly binds forwarded receipt identity and refuses JSON actor claims before any effect', async () => {
  const f = await fixture(), request = await f.request('strict-intent')
  const receipt = await f.rpc.call('agent.posture.set', request)
  expect(() => core.parsePostureSetResult({ ...receipt, target: { ...receipt.target, expectedRun: { runId: 'different-run' } } }, request)).toThrow()
  expect(() => core.parsePostureSetResult({ ...receipt, operationId: 'different-intent' }, request)).toThrow()
  await expect(f.rpc.call('agent.posture.set', { ...request, actor: { kind: 'user', id: 'claimed' } } as never)).rejects.toThrow()
  expect(f.input).toHaveBeenCalledTimes(1)
})

it('claims one dispatcher before Native waits and keeps unrelated original input usable', async () => {
  const f = await fixture(), request = await f.request('pending-original')
  let release!: () => void, entered!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  cleanup.push(async () => release())
  f.input.mockImplementationOnce(async (...args) => { const ack = await f.originalInput(...args); entered(); await held; return ack })
  const pending = f.rpc.call('agent.posture.set', request)
  await started
  const duplicate = await f.rpc.call('agent.posture.set', request)
  expect(duplicate).toMatchObject({ phase: 'dispatching', outcome: 'unknown', acknowledgement: null })
  const read = await f.rpc.call('agent.posture.inspect', { hostId: 'local', agentSessionId: request.target.agentSessionId, operationId: request.operationId })
  expect(read.kind === 'operation' && read.operation).toMatchObject({ phase: 'dispatching', nativeOperationId: duplicate.nativeOperationId })
  expect(f.input).toHaveBeenCalledTimes(1)
  const other = f.sessions[1]!
  await f.host.client.writeAgent({ agentSessionId: other.agentSessionId, expectedRun: other.run, data: 'unrelated-user', source: 'user' })
  release()
  expect(await pending).toMatchObject({ phase: 'settled', outcome: 'applied' })
  expect(f.input).toHaveBeenCalledTimes(1) // Ordinary raw user input uses its original separate channel.
})

it('the actual Desktop posture consumer uses the same original Host effect and exact operation readback', async () => {
  const f = await fixture(), session = f.sessions[0]!
  expect(core.defaultAgentMuxControlSocketPath()).toBe(join(f.root, 'control.sock'))
  const runtime = new RuntimeController(f.store, connectDesktopAgentMuxHost)
  cleanup.push(() => runtime.dispose())
  runtime.commit(await runtime.prepare({ hosts: [{ id: 'local', kind: 'local', label: 'Private local' }], workspaces: [] } as AppConfig))
  const control = { kind: 'agent' as const, hostId: 'local', agentSessionId: session.agentSessionId, run: session.run }
  const receipt = await runtime.setPosture(control, 'allow', 'desktop-original-intent')
  expect(receipt).toMatchObject({ outcome: 'applied', operationId: 'desktop-original-intent', target: { agentSessionId: session.agentSessionId } })
  expect(await runtime.setPosture(control, 'allow', 'desktop-original-intent')).toEqual(receipt)
  expect(f.input).toHaveBeenCalledTimes(1)
})

it('does not normalize another native Run ACK into confirmed original posture bytes', async () => {
  const f = await fixture(), request = await f.request('wrong-native-ack')
  f.input.mockImplementationOnce(async (...args) => { const ack = await f.originalInput(...args); return { ...ack, run: { ...ack.run, runId: 'different-native-run' } } })
  const receipt = parsed(await f.cli('set', ['--input', '-'], JSON.stringify(request)), 1)
  expect(receipt).toMatchObject({ outcome: 'unknown', acknowledgement: null, operationId: 'wrong-native-ack' })
  expect(f.input).toHaveBeenCalledTimes(1)
  await f.host.client.writeAgent({ agentSessionId: request.target.agentSessionId, expectedRun: request.target.expectedRun, data: 'still-healthy', source: 'user' })
  expect((await f.native.client.status(request.target.expectedRun.runId)).state.type).toBe('running')
})

it('retains the actual ACK when its receipt writer is unavailable and preserves independent healthy input', async () => {
  const f = await fixture(), request = await f.request('receipt-save-unconfirmed')
  type Operations = { locked(id: string, action: () => Promise<unknown>): Promise<unknown> }
  const operations = (f.host.client as unknown as { runControlOperations(): Operations }).runControlOperations()
  const locked = operations.locked.bind(operations)
  let admissions = 0
  vi.spyOn(operations, 'locked').mockImplementation(async (id, action) => {
    if (++admissions === 3) throw new Error('Private receipt lock unavailable after Native ACK')
    return await locked(id, action)
  })
  const receipt = await f.rpc.call('agent.posture.set', request)
  expect(receipt).toMatchObject({ outcome: 'applied', diskDurability: 'unconfirmed', acknowledgement: { runId: request.target.expectedRun.runId } })
  const view = await f.rpc.call('agent.posture.inspect', { hostId: 'local', agentSessionId: request.target.agentSessionId, operationId: request.operationId })
  expect(view.kind === 'operation' && view.operation).toEqual(receipt)
  await f.host.client.writeAgent({ agentSessionId: request.target.agentSessionId, expectedRun: request.target.expectedRun, data: 'healthy-after-store-failure', source: 'user' })
  expect(f.input).toHaveBeenCalledTimes(1)
  await f.reopen()
  const retained = await f.rpc.call('agent.posture.inspect', { hostId: 'local', agentSessionId: request.target.agentSessionId, operationId: request.operationId })
  expect(retained.kind === 'operation' && retained.operation).toMatchObject({ phase: 'dispatching', outcome: 'unknown' })
  expect(f.input).not.toHaveBeenCalled()
})

it('a new process reads post-rename receipt facts without certifying the lost original directory ACK', async () => {
  const f = await fixture(), request = await f.request('post-rename-ack-lost')
  const operations = (f.host.client as unknown as { runControlOperations(): { path(id: string): string } }).runControlOperations()
  directoryAckFault.directory = join(f.root, 'run-control-operations')
  directoryAckFault.operationPath = operations.path(request.operationId); directoryAckFault.armed = true
  const receipt = await f.rpc.call('agent.posture.set', request)
  expect(directoryAckFault.armed).toBe(false)
  expect(receipt).toMatchObject({ phase: 'settled', outcome: 'applied', diskDurability: 'unconfirmed', acknowledgement: { runId: request.target.expectedRun.runId } })
  expect(parsed(await f.cli('set', ['--input', '-'], JSON.stringify(request)), 1)).toEqual(receipt)
  const published = JSON.parse(await readFile(directoryAckFault.operationPath, 'utf8'))
  expect(published.receipt).toMatchObject({ phase: 'settled', outcome: 'applied', diskDurability: 'confirmed' }) // rename really published before failed fsync.
  const query = { hostId: 'local', agentSessionId: request.target.agentSessionId, operationId: request.operationId }
  const script = `const core = await import(${JSON.stringify(pathToFileURL(resolve('packages/core/dist/index.js')).href)}); const client = new core.AgentMuxClient({store:new core.AgentMuxFileAgentSessionStore(process.argv[1])}); console.log(JSON.stringify(await client.inspectAgentPosture(JSON.parse(process.argv[2])))); await client.dispose()`
  const read = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, f.store.path, JSON.stringify(query)], { env: objectCliEnvironment(f.root) })
  expect(JSON.parse(read.stdout).operation).toMatchObject({ phase: 'settled', outcome: 'applied', diskDurability: 'unconfirmed', acknowledgement: receipt.acknowledgement })
  expect(f.input).toHaveBeenCalledTimes(1)
  await f.host.client.writeAgent({ agentSessionId: request.target.agentSessionId, expectedRun: request.target.expectedRun, data: 'healthy-after-directory-ack-loss', source: 'user' })
  expect((await f.native.client.status(request.target.expectedRun.runId)).state.type).toBe('running')
})

it('keeps posture declarations and result codecs portable for original Hosted browser consumers', async () => {
  const root = await mkdtemp('/tmp/apb-'); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const bundle = join(root, 'posture.mjs')
  await promisify(execFile)('pnpm', ['--filter', '@agentmux/core', 'exec', 'esbuild', 'src/agent-posture.ts', '--bundle', '--platform=browser', '--format=esm', '--outfile=' + bundle])
  const control = { id: 'policy', label: '原模式', modes: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two', tier: 'safe' as const }] }
  const expected = core.postureControlDigest(control)
  const script = `const codec=await import(${JSON.stringify(pathToFileURL(bundle).href)}); console.log(codec.postureControlDigest(JSON.parse(process.argv[1])))`
  const read = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(control)])
  expect(read.stdout.trim()).toBe(expected)
})

it('never turns a missing admitted record into another native input after original Host reopen', async () => {
  const f = await fixture(), request = await f.request('admitted-member-missing')
  const receipt = await f.rpc.call('agent.posture.set', request)
  expect(receipt.outcome).toBe('applied'); expect(f.input).toHaveBeenCalledTimes(1)
  const operations = (f.host.client as unknown as { runControlOperations(): { path(id: string): string } }).runControlOperations()
  const path = operations.path(request.operationId)
  expect((await readFile(path + '.lock')).byteLength).toBe(0) // Original admitted marker remains.
  await rm(path)
  await f.reopen()
  const repeated = await f.rpc.call('agent.posture.set', request).then(value => ({ value, error: null }), error => ({ value: null, error }))
  expect(f.input).not.toHaveBeenCalled() // Do not mint a new native key for the missing original member.
  expect(repeated.error).toMatchObject({ code: 'RUN_CONTROL_RECORD_UNCONFIRMED' })
  await expect(f.rpc.call('agent.posture.inspect', { hostId: 'local', agentSessionId: request.target.agentSessionId, operationId: request.operationId })).rejects.toMatchObject({ code: 'RUN_CONTROL_RECORD_UNCONFIRMED' })
  await f.host.client.writeAgent({ agentSessionId: request.target.agentSessionId, expectedRun: request.target.expectedRun, data: 'healthy-with-missing-receipt', source: 'user' })
  expect((await f.native.client.status(request.target.expectedRun.runId)).state.type).toBe('running')
})
