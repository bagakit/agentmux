import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as core from '../dist/index.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { headlessFixture, until } from './helpers/headless-runtime-fixture.js'
import { runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import { parseRpcAgentSession } from '../src/rpc-native-codec.js'

const fault = vi.hoisted(() => ({ directory: '', active: false, calls: 0 }))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, open: async (path: string, flags: string, mode?: number) => {
    const handle = await actual.open(path, flags, mode)
    if (path === fault.directory && flags === 'r') {
      const sync = handle.sync.bind(handle)
      handle.sync = async () => {
        if (fault.active) { fault.calls++; throw Object.assign(new Error('Private directory flush exhausted its storage.'), { code: 'ENOSPC' }) }
        return await sync()
      }
    }
    return handle
  } }
})

const close: Array<() => Promise<void>> = []
afterEach(async () => {
  fault.active = false; fault.directory = ''; fault.calls = 0
  for (const cleanup of close.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks(); vi.unstubAllEnvs()
})

it('retains the actual original Run and unknown receipt when the auxiliary marker directory flush fails', async () => {
  const f = await fixture()
  f.input.mockRejectedValueOnce(new core.AgentMuxError('Private reply did not dispatch.', 'CTXMUX_io', undefined,
    { disposition: 'not_applied', confirmedInputBytes: 0 }))
  const original = await f.create(), claim = (await f.store.readMetadata(original.agentSessionId))!.terminalHandshake!
  await f.owner.writeAgent({ agentSessionId: original.agentSessionId, expectedRun: original.run, source: 'terminal-protocol', data: 'original-protocol-input' })
  const before = await f.owner.statusAgent(original.agentSessionId)
  await f.owner.dispose()
  const next = new core.AgentMuxClient({ store: new core.AgentMuxFileAgentSessionStore(f.store.path) }); close.push(() => next.dispose())
  const events: core.AgentMuxClientEvent[] = []; next.onEvent(event => { events.push(event) })
  fault.directory = f.scope.env.AGENTMUX_STATE_DIRECTORY!; fault.active = true
  await next.connect()
  expect(fault.calls, 'actual FileStore directory fsync fault must be reached').toBeGreaterThan(0)
  expect(events).toContainEqual(expect.objectContaining({ type: 'agent-error', code: 'AGENT_TERMINAL_CAPABILITY_PERSIST_FAILED' }))
  expect((next as any).registry.isDurabilityUnconfirmed(original.agentSessionId)).toBe(true)
  expect(next.agentSession(original.agentSessionId).terminalHandshake).toEqual(claim)
  const ack = await next.writeAgent({ agentSessionId: original.agentSessionId, expectedRun: original.run, source: 'user', data: 'authorized-during-pressure' })
  expect(ack.appliedByteRange!.startByte).toBe(before.run.acceptedInputBytes)
  expect((await next.statusAgent(original.agentSessionId)).run).toMatchObject({ runId: original.run.runId, pid: before.run.pid, state: 'running' })
  fault.active = false
  const disk = new core.AgentMuxFileAgentSessionStore(f.store.path), retained = (await disk.readMetadata(original.agentSessionId))!
  expect(retained.terminalHandshake).toEqual(claim)
  expect(retained.terminalCapability?.reason).toBe('handshake-unconfirmed')
  await disk.confirmDurability(retained.agentSessionId, retained.run, retained)
  expect((await disk.readMetadata(original.agentSessionId))!.terminalHandshake).toEqual(claim)
  expect(f.start).toHaveBeenCalledOnce()
})

async function fixture() {
  vi.stubEnv('AGENTMUX_TEST_OWNER_ENTRY', resolve(import.meta.dirname, 'fixtures/handshake-recovery-owner.mjs'))
  const scope = await headlessFixture(); close.push(scope.cleanup); await scope.stopOwner()
  for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key)) vi.stubEnv(key, undefined)
  for (const [key, value] of Object.entries(scope.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key)) vi.stubEnv(key, value)
  const output = join(scope.root, 'original-output'), program = join(scope.root, 'original-cli.mjs')
  await writeFile(output, 'original-private-output')
  await writeFile(program, `#!/usr/bin/env node
    import {readFileSync} from 'node:fs'
    if(process.argv.includes('--version')) { console.log('codex 1.0.0');process.exit(0) }
    if(process.argv.includes('--help')) { console.log('codex --help --version resume');process.exit(0) }
    process.stdin.setRawMode(true);process.stdin.on('data',data=>console.log('INPUT:'+data.toString('hex')))
    process.stdout.write('\\x1b[?u')
    let last='';setInterval(()=>{const text=readFileSync(${JSON.stringify(output)},'utf8');if(text!==last){last=text;console.log(text)}},10)
  `, { mode: 0o700 })
  const store = new core.AgentMuxFileAgentSessionStore(scope.env.AGENTMUX_AGENT_SESSION_STORE!)
  const owner = new core.AgentMuxClient({ store }); close.push(() => owner.dispose())
  Object.defineProperty((owner as any).hookServer, 'port', { value: 0 })
  await owner.connect()
  const kernel = (owner as any).kernel
  const start = vi.spyOn(kernel, 'start'), input = vi.spyOn(kernel, 'input')
  const create = () => owner.createAgent({ providerId: 'codex', executorId: 'codex', agentSessionId: 'original-handshake-agent',
    createOperationId: 'original-create', workspacePath: scope.root, commandOverride: program,
    args: [], env: {}, injectAgentMuxGuide: false })
  return { scope, store, owner, kernel, start, input, create, output }
}

it('cold original semantic process preserves the unacknowledged reply while public consumers attach and input the same live Run', async () => {
  const f = await fixture()
  f.input.mockRejectedValueOnce(new core.AgentMuxError('Private reply was not dispatched.', 'CTXMUX_io', undefined,
    { disposition: 'not_applied', confirmedInputBytes: 0 }))
  const original = await f.create(), claim = (await f.store.readMetadata(original.agentSessionId))!.terminalHandshake!
  expect(claim.acknowledged).toBe(false)
  expect(claim.inputByteRange.startByte).toBe(0)
  const known = await f.owner.statusAgent(original.agentSessionId), native = f.owner.runtimeIdentity(), nativePid = f.scope.nativeProcessId
  await f.owner.writeAgent({ agentSessionId: original.agentSessionId, expectedRun: original.run,
    source: 'terminal-protocol', data: 'original-protocol-response' })
  const before = await f.owner.statusAgent(original.agentSessionId)
  expect(before.run.acceptedInputBytes).toBeGreaterThan(claim.inputByteRange.endByte)
  await until(() => f.owner.readRunReplay(original.run), value => value.replay.some(chunk => chunk.data.includes('original-private-output')), 'original output')
  await f.owner.dispose()
  const restarted = await f.scope.restart() // An actual new semantic process; Native and original PTY survive.
  const observation = await until(async () => JSON.parse(await readFile(join(f.scope.env.AGENTMUX_STATE_DIRECTORY!, 'original-observation.json'), 'utf8').catch(() => 'null')),
    value => value?.pid === restarted.owner.processId, 'original semantic connection outcome')
  expect(observation.state, 'the auxiliary reply cannot fail original Runtime connection').toBe('observed')
  const sdk = await f.scope.client()
  const observed = await until(() => sdk.readAgentSession(original.agentSessionId), value => value?.terminalCapability?.reason === 'handshake-unconfirmed', 'durable exact unknown capability')
  expect(observed!.terminalHandshake, 'original handshake receipt cannot be invented').toEqual(claim)
  const originalAttempts = (await readFile(join(f.scope.env.AGENTMUX_STATE_DIRECTORY!, 'observed-inputs.ndjson'), 'utf8').catch(() => ''))
    .split('\n').filter(Boolean).map(line => JSON.parse(line))
  expect(originalAttempts.filter(input => input.runId === original.run.runId), 'a stale handshake cannot be automatically resent').toEqual([])
  expect(observed!.terminalCapability!.diagnostic).toMatchObject({ code: 'AGENT_TERMINAL_HANDSHAKE_UNCONFIRMED' })
  expect(parseRpcAgentSession(observed).terminalCapability).toEqual(observed!.terminalCapability)
  for (const invalid of [
    { ...observed!.terminalCapability!, reason: 'unknown-capability-reason' },
    { ...observed!.terminalCapability!, run: { runId: 'another-original-run' } },
    { ...observed!.terminalCapability!, diagnostic: { code: {}, message: 'original observation' } },
    { ...observed!.terminalCapability!, diagnostic: { code: 'ORIGINAL', message: '\0' } }
  ]) expect(() => parseRpcAgentSession({ ...observed, terminalCapability: invalid })).toThrow()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: restarted.socketPath } }); close.push(() => rpc.dispose())
  const inspected = await rpc.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: original.agentSessionId } })
  expect(inspected.session.terminalCapability).toEqual(observed!.terminalCapability)
  const cli = await runCompiledObjectCli(['--endpoint', `unix:${restarted.socketPath}`, 'agent', 'inspect', '--session', original.agentSessionId], f.scope.env)
  expect(cli.code, cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout).result.session.terminalHandshake).toEqual(claim)
  expect(JSON.parse(cli.stdout).result.session.terminalCapability.reason).toBe('handshake-unconfirmed')
  const attached = await sdk.reattachAgent(original.agentSessionId)
  expect(attached.attachment.replay.map(chunk => chunk.data).join('')).toContain('original-private-output')
  const output: core.AgentMuxClientEvent[] = []; const off = sdk.onEvent(event => { output.push(event) }); close.push(async () => off())
  await writeFile(f.output, 'later-private-output')
  await until(() => output, events => events.some(event => event.type === 'terminal-output' && event.run.runId === original.run.runId && event.data.includes('later-private-output')), 'original ordered live output')
  const ack = await sdk.writeAgent({ agentSessionId: original.agentSessionId, expectedRun: original.run, source: 'user', data: 'new-authorized-input' })
  expect(ack.appliedByteRange!.startByte).toBe(before.run.acceptedInputBytes)
  const after = await sdk.statusAgent(original.agentSessionId)
  expect(after.run).toMatchObject({ runId: original.run.runId, pid: known.run.pid, state: 'running' })
  expect(after.session.terminalHandshake).toEqual(claim)
  expect(sdk.runtimeIdentity()).toEqual(native); expect(f.scope.nativeProcessId).toBe(nativePid)
  await expect(sdk.writeAgent({ agentSessionId: original.agentSessionId, expectedRun: { runId: 'changed-original-run' }, source: 'user', data: 'wrong-target' }))
    .rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
  console.info('PRIVATE_HANDSHAKE_RECOVERY=' + JSON.stringify({ nativePid, semanticPid: restarted.owner.processId,
    originalRun: original.run.runId, originalPid: known.run.pid, beforeInput: before.run.acceptedInputBytes,
    afterInput: after.run.acceptedInputBytes, originalClaim: claim, runCount: (await sdk.listRuns()).length }))
})

it('serializes a fresh handshake claim and receipt with actual authorized protocol input', async () => {
  const f = await fixture(), save = f.store.compareAndSwapMetadata.bind(f.store)
  let release!: () => void, arrive!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), entered = new Promise<void>(resolve => { arrive = resolve })
  close.push(async () => release())
  vi.spyOn(f.store, 'compareAndSwapMetadata').mockImplementation(async (...args) => {
    const next = args[1]
    await save(...args)
    if (next?.terminalHandshake && !next.terminalHandshake.acknowledged) { arrive(); await held }
  })
  const creating = f.create(); await entered
  const current = f.owner.agentSession('original-handshake-agent')
  let inputSettled = false
  const writing = f.owner.writeAgent({ agentSessionId: current.agentSessionId, expectedRun: current.run,
    source: 'terminal-protocol', data: 'new-protocol-input' }).then(value => { inputSettled = true; return value })
  await new Promise(resolve => setTimeout(resolve, 40))
  expect(inputSettled, 'protocol input cannot interleave the original claim/write/receipt').toBe(false)
  release()
  const original = await creating, ack = await writing
  expect(original.terminalHandshake?.acknowledged, 'fresh handshake must retain its actual first receipt').toBe(true)
  expect(ack.appliedByteRange!.startByte).toBe(original.terminalHandshake!.inputByteRange.endByte)
  expect(f.start).toHaveBeenCalledOnce()
  expect(f.input.mock.calls.map((call: any[]) => call[1].data)).toEqual(['\u001b[?0u', 'new-protocol-input'])
})
