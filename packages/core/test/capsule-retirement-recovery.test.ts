import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { capsuleRecoveryFixture } from './helpers/capsule-recovery-fixture.js'
import { CapsuleRunManager } from '../src/capsule-run-manager.js'
import { AgentMuxError } from '../src/errors.js'
import * as durable from '../src/durable-write.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { parseCapsuleRuntimeParams, parseCapsuleRuntimeResult, type CapsuleRuntimeRecoveryTarget } from '../src/capsule-runtime.js'

const closes: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of closes.splice(0).reverse()) await close(); vi.unstubAllEnvs() })
const identity = { runtimeId: 'original-native-lineage', instanceId: 'original-native-owner', buildIdentity: 'original-build', protocolVersion: 1 }
async function fixture(retained = false) {
  const f = await capsuleRecoveryFixture(); closes.push(f.close)
  let retireCalls = 0, reads = 0, outcome: 'retired' | 'not_retired' = 'not_retired', loseReply = false
  f.client.terminalCreationRuntimeIdentity = () => ({ ...identity })
  f.client.retirePreparedTerminalCreation = async (prepared, runtime) => {
    retireCalls++
    expect(runtime).toEqual(identity)
    const record = JSON.parse(await readFile(join(f.state, 'capsule-service-operations/recover.json'), 'utf8'))
    expect(['intent', 'unknown'], 'Retirement intent must be durable before its effect').toContain(record.recovery.phase)
    expect(record.recoveryLaunch).toEqual(prepared)
    if (retained) {
      const run = await f.client.inspectPreparedTerminal(prepared)
      if (!run) throw new Error('Missing fixture Run')
      return { runtime: { ...identity }, outcome: 'retained', run }
    }
    outcome = 'retired'
    if (loseReply) throw new AgentMuxError('Retirement acknowledgment lost', 'CTXMUX_io')
    f.failStart(undefined)
    return { runtime: { ...identity }, outcome: 'retired' }
  }
  f.client.observePreparedTerminalCreationRetirement = async () => { reads++; return { runtime: { ...identity }, outcome } }
  if (retained) {
    const create = f.client.createPreparedTerminal.bind(f.client)
    vi.spyOn(f.client, 'createPreparedTerminal').mockImplementation(async prepared => { await create(prepared); throw new AgentMuxError('Original Start ACK lost', 'CTXMUX_io') })
  } else f.failStart(() => new AgentMuxError('Original Start result unknown', 'CTXMUX_io'))
  const original = await f.manager.runtime.call('capsule.runtime.start', { operationId: 'original-start', expectedRevision: 0 })
  expect(original.operation?.phase).toBe('unknown')
  const observed = await f.manager.runtime.call('capsule.runtime.inspect', { operationId: 'original-start' })
  expect(observed.recoveryTarget).toBeTruthy()
  const command = { operationId: 'recover', expectedRevision: 1, recovery: observed.recoveryTarget! as CapsuleRuntimeRecoveryTarget }
  const oldPath = join(f.state, 'capsule-service-operations/original-start.json'), oldRecord = await readFile(oldPath, 'utf8')
  return { ...f, command, oldPath, oldRecord, count: () => ({ retireCalls, reads }),
    loseReply: () => { loseReply = true }, notRetired: () => { outcome = 'not_retired' }, retired: () => { outcome = 'retired'; f.failStart(undefined) } }
}

it('recovers only after a durable exact retirement and preserves the original unknown launch history', async () => {
  const f = await fixture(), source = f.calls.creates[0]!, write = durable.durableWriteFile
  vi.spyOn(durable, 'durableWriteFile').mockImplementation(async (path, data, options) => {
    const value = JSON.parse(String(data))
    if (path.endsWith('capsule-service.json') && value.command?.params.operationId === 'recover') {
      const record = JSON.parse(await readFile(join(f.state, 'capsule-service-operations/recover.json'), 'utf8'))
      expect(record.recovery.phase, 'Retired receipt must precede the replacement binding').toBe('retired')
    }
    await write(path, data, options)
  })
  const result = await f.manager.runtime.call('capsule.runtime.start', f.command)
  expect(result, 'Confirmed retirement must reopen the same namespace').toMatchObject({ phase: 'running', revision: 2, stateDirectory: f.manager.stateDirectory, recovery: { phase: 'retired', target: f.command.recovery }, operation: { phase: 'confirmed' } })
  expect(f.calls.creates).toHaveLength(2)
  expect(f.calls.creates[1]!.createOperationId, 'Confirmed retirement must use a fresh creation key').not.toBe(source.createOperationId)
  expect(f.calls.stops).toHaveLength(0)
  expect(await readFile(f.oldPath, 'utf8'), 'Old unknown history must remain unchanged').toBe(f.oldRecord)
  const record = JSON.parse(await readFile(join(f.state, 'capsule-service-operations/recover.json'), 'utf8'))
  expect(record.recoveryLaunch, 'Original full frozen launch must remain retained').toEqual(source)
  expect((await f.manager.runtime.call('capsule.runtime.inspect', { operationId: 'original-start' })).operation?.phase).toBe('unknown')
  expect(parseCapsuleRuntimeResult(result)).toEqual(result)
})

it('reconnects a retained original Run without Stop or another Start', async () => {
  const f = await fixture(true)
  const result = await f.manager.runtime.call('capsule.runtime.start', f.command)
  expect(result, 'Retained creation must reconnect its original Run').toMatchObject({ phase: 'running', run: { runId: 'run-1' }, recovery: { phase: 'retained', run: { runId: 'run-1' } } })
  expect(f.calls.creates, 'Retained creation must not Start another Run').toHaveLength(1)
  expect(f.calls.stops).toHaveLength(0)
  expect(await readFile(f.oldPath, 'utf8')).toBe(f.oldRecord)
})

it('refuses every foreign recovery target before invoking Native', async () => {
  const f = await fixture(), target = f.command.recovery
  for (const changes of [{ revision: 2 }, { managementOperationId: 'foreign-management' }, { createOperationId: 'foreign-creation' }, { launchDigest: 'a'.repeat(64) }, { runtime: { ...identity, runtimeId: 'foreign-lineage' } }, { runtime: { ...identity, instanceId: 'foreign-owner' } }]) {
    const error = await f.manager.runtime.call('capsule.runtime.start', { ...f.command, recovery: { ...target, ...changes } }).then(() => null, error => error)
    expect(error, 'Foreign target must be refused before Native retirement').toMatchObject({ code: 'CAPSULE_RUNTIME_RECOVERY_CONFLICT' })
  }
  expect(f.count().retireCalls).toBe(0)
  expect(f.calls.creates).toHaveLength(1)
})

it('continues only the original retirement intent after unknown across manager replacement without repeating Start', async () => {
  const f = await fixture(); f.loseReply()
  const first = await f.manager.runtime.call('capsule.runtime.start', f.command)
  expect(first.recovery?.phase).toBe('unknown')
  const repeated = await f.manager.runtime.call('capsule.runtime.start', { ...f.command, operationId: 'replacement-recovery' }).then(() => null, error => error)
  expect(repeated, 'A fresh command ID cannot repeat the original retirement').toMatchObject({ code: 'CAPSULE_RUNTIME_RECOVERY_CONFLICT' })
  expect((await f.manager.runtime.call('capsule.runtime.inspect', {})).recovery?.operationId).toBe('recover')
  f.notRetired()
  const binding = await readFile(join(f.state, 'capsule-service.json')), journal = await readFile(join(f.state, 'capsule-service-operations/recover.json'))
  const reads = vi.spyOn(durable, 'durableWriteFile')
  await f.manager.runtime.call('capsule.runtime.inspect', { operationId: 'recover' })
  expect(reads, 'Inspection cannot dispatch or save lifecycle work').not.toHaveBeenCalled()
  reads.mockRestore()
  expect(await readFile(join(f.state, 'capsule-service.json')), 'Inspection cannot save or retire').toEqual(binding)
  expect(await readFile(join(f.state, 'capsule-service-operations/recover.json'))).toEqual(journal)
  expect(f.count()).toEqual({ retireCalls: 1, reads: 0 })
  await f.manager.dispose()
  const next = new CapsuleRunManager(f.client, f.state); closes.push(() => next.dispose())
  const unknown = await next.runtime.call('capsule.runtime.start', f.command)
  expect(unknown.recovery?.phase, 'not_retired must remain unknown').toBe('unknown')
  expect(f.count(), 'The same retirement intent can be redriven without repeating original Start').toEqual({ retireCalls: 2, reads: 1 })
  expect(f.calls.creates).toHaveLength(1)
  f.retired()
  const recovered = await next.runtime.call('capsule.runtime.start', f.command)
  expect(recovered.phase, 'Confirmed original fence must allow recovery after replacement').toBe('running')
  expect(f.count()).toEqual({ retireCalls: 2, reads: 2 })
  expect(f.calls.creates).toHaveLength(2)
  expect(await readFile(f.oldPath, 'utf8')).toBe(f.oldRecord)
})

it('continues the exact durable retirement intent after a crash before Native dispatch', async () => {
  const f = await fixture()
  const retire = f.client.retirePreparedTerminalCreation.bind(f.client)
  const lost = vi.spyOn(f.client, 'retirePreparedTerminalCreation').mockRejectedValueOnce(new AgentMuxError('Core transport disappeared before dispatch', 'CTXMUX_io'))
  const first = await f.manager.runtime.call('capsule.runtime.start', f.command)
  expect(first.recovery?.phase).toBe('unknown')
  lost.mockRestore(); f.client.retirePreparedTerminalCreation = retire
  await f.manager.dispose()
  const next = new CapsuleRunManager(f.client, f.state); closes.push(() => next.dispose())
  const recovered = await next.runtime.call('capsule.runtime.start', f.command)
  expect(recovered.phase, 'A durable predispatch intent must retain a reachable explicit continuation').toBe('running')
  expect(f.count()).toEqual({ retireCalls: 1, reads: 1 })
  expect(f.calls.creates, 'One original Start and one successor launch are sufficient').toHaveLength(2)
  await next.runtime.call('capsule.runtime.start', f.command)
  expect(f.calls.creates).toHaveLength(2)
  expect(f.count()).toEqual({ retireCalls: 1, reads: 1 })
})

it('requires receipt file and directory reconfirmation before a new generation', async () => {
  const f = await fixture()
  const owner = f.manager as unknown as { confirmDurable(path: string): Promise<void> }, confirm = owner.confirmDurable.bind(owner)
  const spy = vi.spyOn(owner, 'confirmDurable').mockImplementation(async path => {
    if (path.endsWith('recover.json')) throw new Error('Receipt directory confirmation unavailable')
    await confirm(path)
  })
  await f.manager.runtime.call('capsule.runtime.start', f.command)
  expect(f.calls.creates, 'Receipt durability must gate the fresh launch').toHaveLength(1)
  spy.mockRestore()
  expect((await f.manager.runtime.call('capsule.runtime.start', f.command)).phase).toBe('running')
  expect(f.count()).toEqual({ retireCalls: 1, reads: 0 })
})

it('retains a live uncalled retirement refusal without locking out a fresh explicit recovery', async () => {
  const f = await fixture(), write = durable.durableWriteFile
  const spy = vi.spyOn(durable, 'durableWriteFile').mockImplementation(async (path, data, options) => {
    if (path.endsWith('capsule-service.json') && JSON.parse(String(data)).recoveryOperationId === 'recover') throw new Error('Recovery reference not committed')
    await write(path, data, options)
  })
  const refused = await f.manager.runtime.call('capsule.runtime.start', f.command)
  expect(refused.recovery?.phase, 'A live owner must preserve its exact uncalled retirement fact').toBe('not_applied')
  expect(refused.operation?.phase).toBe('not_applied')
  expect(f.count().retireCalls).toBe(0)
  spy.mockRestore()
  const next = { ...f.command, operationId: 'new-recovery' }
  const retire = f.client.retirePreparedTerminalCreation
  f.client.retirePreparedTerminalCreation = async (prepared, runtime) => {
    // The fixture's first callback asserted its original ID; this explicit new command owns this call.
    const record = JSON.parse(await readFile(join(f.state, 'capsule-service-operations/new-recovery.json'), 'utf8'))
    expect(record.recovery.phase).toBe('intent')
    f.retired()
    return { runtime, outcome: 'retired' }
  }
  expect((await f.manager.runtime.call('capsule.runtime.start', next)).phase).toBe('running')
  expect(await readFile(f.oldPath, 'utf8')).toBe(f.oldRecord)
})

it('does not launch before a retirement receipt is durably confirmed', async () => {
  const f = await fixture(), write = durable.durableWriteFile
  const spy = vi.spyOn(durable, 'durableWriteFile').mockImplementation(async (path, data, options) => {
    if (path.endsWith('recover.json') && JSON.parse(String(data)).recovery.phase === 'retired') throw new Error('Retirement receipt storage unavailable')
    await write(path, data, options)
  })
  const result = await f.manager.runtime.call('capsule.runtime.start', f.command)
  expect(result.phase).toBe('unknown')
  expect(f.calls.creates, 'Undurable retirement cannot authorize a replacement launch').toHaveLength(1)
  expect(JSON.parse(await readFile(join(f.state, 'capsule-service.json'), 'utf8')).launch.createOperationId).toBe(f.command.recovery.createOperationId)
  spy.mockRestore()
  f.retired()
  expect((await f.manager.runtime.call('capsule.runtime.start', f.command)).phase).toBe('running')
  expect(f.count()).toEqual({ retireCalls: 1, reads: 1 })
})

it('reconciles a committed recovery binding after the following journal acknowledgment is lost', async () => {
  const f = await fixture(), write = durable.durableWriteFile
  const spy = vi.spyOn(durable, 'durableWriteFile').mockImplementation(async (path, data, options) => {
    if (path.endsWith('recover.json') && JSON.parse(String(data)).phase === 'committed') throw new Error('Journal acknowledgment unavailable')
    await write(path, data, options)
  })
  await f.manager.runtime.call('capsule.runtime.start', f.command)
  spy.mockRestore(); await f.manager.dispose()
  const next = new CapsuleRunManager(f.client, f.state); closes.push(() => next.dispose())
  await next.runtime.call('capsule.runtime.start', f.command)
  expect(f.count(), 'Committed binding must not repeat retirement').toEqual({ retireCalls: 1, reads: 0 })
  await next.call('capsule.config.update', { operationId: '23456789ABCD', expectedRevision: 1, changes: { defaultTheme: 'none' } })
  expect((await next.runtime.call('capsule.runtime.inspect', {})).phase).toBe('running')
  expect(f.calls.creates).toHaveLength(2)
})

it('strictly carries exact recovery through original public Unix RPC and source compiled CLI', async () => {
  const f = await fixture()
  const server = new AgentMuxControlServer({ coreClients: () => [], capsules: f.manager, capsuleRuntime: f.manager.runtime }, join(f.directory, 'r.sock'))
  await server.start(); closes.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); closes.push(() => rpc.dispose())
  const inspected = await rpc.call('capsule.runtime.inspect', {})
  expect(inspected.recoveryTarget).toEqual(f.command.recovery)
  const cli = process.env.CAPSULE_RETIREMENT_CLI
  expect(cli, 'Actual source compiled CLI is required').toBeTruthy()
  const result = await new Promise<string>((yes, no) => {
    const child = spawn(process.execPath, [cli!, '--endpoint', 'unix:' + server.path, 'capsule', 'runtime', 'start', '--input', '-'], { env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_'))), stdio: ['pipe', 'pipe', 'pipe'] })
    child.stdin.end(JSON.stringify(f.command)); let out = '', error = ''
    child.stdout.on('data', x => { out += x }); child.stderr.on('data', x => { error += x }); child.on('error', no)
    child.on('close', code => code === 0 ? yes(out) : no(new Error(error || out)))
  })
  expect(JSON.parse(result).result, 'Public CLI must consume the same retirement manager').toMatchObject({ phase: 'running', recovery: { phase: 'retired' }, operation: { operationId: 'recover' } })
  expect(f.count().retireCalls).toBe(1)
  expect((await rpc.call('capsule.runtime.inspect', { operationId: 'original-start' })).operation?.phase).toBe('unknown')
  for (const recovery of [{ ...f.command.recovery, surprise: true }, { ...f.command.recovery, runtime: { ...identity, extra: true } }, { ...f.command.recovery, launchDigest: 'guessed' }])
    expect(() => parseCapsuleRuntimeParams('capsule.runtime.start', { ...f.command, recovery })).toThrow()
})

it('keeps a missing historical Native lineage unknown rather than substituting the current listener', async () => {
  const f = await fixture(), path = join(f.state, 'capsule-service.json')
  const binding = JSON.parse(await readFile(path, 'utf8')); delete binding.launchRuntime; await writeFile(path, JSON.stringify(binding) + '\n')
  const value = await f.manager.runtime.call('capsule.runtime.inspect', { operationId: 'original-start' })
  expect(value.recoveryTarget?.runtime, 'Current listener identity cannot certify the original missing lineage').toBeNull()
  expect(parseCapsuleRuntimeResult(value)).toEqual(value)
  expect(() => parseCapsuleRuntimeParams('capsule.runtime.start', { ...f.command, recovery: value.recoveryTarget })).toThrow()
  expect(f.count().retireCalls).toBe(0)
})

it('refuses a valid-shaped durable retirement receipt from another persistent Runtime', async () => {
  const f = await fixture(), path = join(f.state, 'capsule-service-operations/recover.json')
  const owner = f.manager as unknown as { confirmDurable(path: string): Promise<void> }, confirm = owner.confirmDurable.bind(owner)
  const spy = vi.spyOn(owner, 'confirmDurable').mockImplementation(async path => {
    if (path.endsWith('recover.json')) throw new Error('Receipt observation lost before binding commitment')
    await confirm(path)
  })
  await f.manager.runtime.call('capsule.runtime.start', f.command)
  spy.mockRestore()
  const retained = JSON.parse(await readFile(path, 'utf8')), binding = await readFile(join(f.state, 'capsule-service.json'))
  for (const phase of ['retired', 'retained']) {
    const record = structuredClone(retained)
    record.recovery.phase = phase; record.recovery.runtime.runtimeId = 'foreign-persistent-runtime'
    if (phase === 'retained') record.recovery.run = { runId: 'foreign-run' }
    await writeFile(path, JSON.stringify(record) + '\n')
    const error = await f.manager.runtime.call('capsule.runtime.start', f.command).then(() => null, error => error)
    expect(error, 'Foreign durable runtime receipt must not authorize a successor').toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
    expect(await readFile(join(f.state, 'capsule-service.json'))).toEqual(binding)
    expect(f.calls.creates).toHaveLength(1)
    expect(f.count()).toEqual({ retireCalls: 1, reads: 0 })
  }
})
