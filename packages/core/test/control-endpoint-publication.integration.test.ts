import { afterEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer, createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'
import { lstat, rm, writeFile, readFile, symlink, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { headlessFixture, until } from './helpers/headless-runtime-fixture.js'
import type { AgentMuxClientEvent } from '../src/types.js'
import { AgentMuxHostedTransferReader, decodeHostedValue } from '../src/hosted-value.js'

const scopes: Array<Awaited<ReturnType<typeof headlessFixture>>> = []
afterEach(async () => { for (const scope of scopes.splice(0)) await scope.cleanup() })
async function fixture() {
  const previous = process.env.AGENTMUX_TEST_OWNER_ENTRY
  process.env.AGENTMUX_TEST_OWNER_ENTRY = process.env.AGENTMUX_TEST_ENDPOINT_OWNER_ENTRY ?? resolve(import.meta.dirname, 'fixtures/control-endpoint-publication-worker.mjs')
  try { const scope = await headlessFixture(); scopes.push(scope); return scope }
  finally { if (previous === undefined) delete process.env.AGENTMUX_TEST_OWNER_ENTRY; else process.env.AGENTMUX_TEST_OWNER_ENTRY = previous }
}
describe('Original semantic control endpoint publication', () => {
  it('republishes a missing socket and parent without replacing two live Runs, accepted streams or the owner', async () => {
    const scope = await fixture(), client = await scope.client(), events: AgentMuxClientEvent[] = []
    client.onEvent(event => events.push(event))
    const runs = await Promise.all(['first', 'second'].map(id => client.createTerminal({ createOperationId: 'publication-' + id,
      workspacePath: scope.root, command: process.execPath,
      args: ['-e', `process.stdin.setRawMode(true);process.stdout.write('${id}:ready');process.stdin.on('data',b=>process.stdout.write(b));setInterval(()=>{},1000)`] })))
    for (const run of runs) await client.attachTerminal(run.runId, 0, 'raw')
    await until(async () => (await Promise.all(runs.map(run => client.readRunReplay(run, 0, 'raw')))).flatMap(value => value.replay).filter(value => value.type === 'data').map(value => value.data).join(''), data => data.includes('first:ready') && data.includes('second:ready'), 'two actual private Run prefixes')
    const original = await client.listRuns(), owner = scope.owner
    const persistent = await acceptedRpc(scope.socketPath)
    const consumerId = randomUUID(), fence = { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId }
    await persistent.call('runtime.events', { consumerId, fence })
    try {
    for (const target of [scope.socketPath, dirname(scope.socketPath)]) {
      await rm(target, { recursive: true })
      for (const [index, run] of runs.entries()) {
        const list = decodeHostedValue((await persistent.call('runtime.invoke', { consumerId, fence, invocation: { method: 'listRuns', args: [] } })).value) as Awaited<ReturnType<typeof client.listRuns>>
        const before = list.find(value => value.runId === run.runId)!
        await persistent.call('runtime.invoke', { consumerId, fence, invocation: { method: 'writeTerminal', args: [run,
          { ownerInstanceId: client.runtimeIdentity().instanceId, operationId: 'publication-tail-' + index + '-' + basenameFor(target), expectedByte: before.acceptedInputBytes!, data: 'continuous-' + index + '-' + basenameFor(target) }] } })
      }
      await until(async () => { try { return (await lstat(scope.socketPath)).isSocket() } catch { return false } }, value => value, 'original canonical endpoint automatically republished')
      const fresh = await scope.client()
      expect(fresh.runtimeOwnerIdentity()).toEqual(owner)
      for (const run of runs) {
        const before = original.find(value => value.runId === run.runId)!, after = (await fresh.listRuns()).find(value => value.runId === run.runId)!
        expect(after).toMatchObject({ runId: before.runId, pid: before.pid, state: 'running' })
      }
    }
    const inspected = await promisify(execFile)(process.execPath, [resolve(import.meta.dirname, '../dist/agentmux.js'), '--endpoint', 'unix:' + scope.socketPath, 'system', 'endpoint', '--inspect'], { env: scope.env })
    expect(JSON.parse(inspected.stdout)).toMatchObject({ ok: true, result: { connection: 'responded', publication: { state: 'available' } } })
    const tails = events.filter(e => e.type === 'terminal-output').map(e => e.data).join('')
    expect(tails).toContain('continuous-0-headless.sock'); expect(tails).toContain('continuous-1-c')
    expect(events.some(e => e.type === 'connection-state' && e.state === 'lost')).toBe(false)
    for (const run of runs) await client.stopTerminal(run)
    } finally { persistent.close() }
  }, 60_000)
  it('reports real controlled ENOSPC, replays the current fact to late subscribers and recovers without retrying input', async () => {
    const scope = await fixture(), client = await scope.client(), events: AgentMuxClientEvent[] = []
    client.onEvent(event => events.push(event))
    const rpc = await acceptedRpc(scope.socketPath)
    try {
      const pressure = join(scope.env.AGENTMUX_STATE_DIRECTORY!, 'publication-pressure')
      await writeFile(pressure, 'held')
      await rm(scope.socketPath)
      await until(() => events, values => values.some(e => e.type === 'control-endpoint-state' && e.state === 'unavailable' && e.diagnostic.code === 'ENOSPC'), 'typed ENOSPC publication state on original accepted stream')
      expect(await readFile(join(scope.env.AGENTMUX_STATE_DIRECTORY!, 'publication-pressure-attempts'), 'utf8')).toContain('link')
      await rpc.call('runtime.events', { consumerId: randomUUID(), fence: { runtimeId: scope.owner.runtimeId, ownerInstanceId: scope.owner.ownerInstanceId } })
      await until(() => rpc.events, values => values.some(e => e.type === 'control-endpoint-state' && e.state === 'unavailable' && e.diagnostic.code === 'ENOSPC'), 'late subscription receives current persistent publication failure')
      const current = await rpc.call('system.endpoint', {})
      expect(current.publication).toMatchObject({ state: 'unavailable', diagnostic: { code: 'ENOSPC' } })
      const failedAt = events.map(e => e.type === 'control-endpoint-state' && e.state === 'unavailable').lastIndexOf(true)
      await rm(pressure)
      await until(() => events.slice(failedAt + 1), values => values.some(e => e.type === 'control-endpoint-state' && e.state === 'available'), 'original publication recovers after actual pressure is released')
      await until(() => rpc.events, values => values.some(e => e.type === 'control-endpoint-state' && e.state === 'available'), 'late subscriber receives recovery')
      expect((await rpc.call('system.endpoint', {})).publication).toEqual({ state: 'available' })
      expect((await scope.client()).runtimeOwnerIdentity()).toEqual(scope.owner)
    } finally { rpc.close() }
  }, 60_000)
  it('retains a foreign live socket, file and symlink until its original owner clears them', async () => {
    const scope = await fixture(), client = await scope.client(), events: AgentMuxClientEvent[] = []
    client.onEvent(e => events.push(e))
    await rm(scope.socketPath)
    const foreign = createServer(socket => { socket.end('foreign') })
    await new Promise<void>(resolve => foreign.listen(scope.socketPath, resolve))
    const original = await lstat(scope.socketPath)
    await until(() => events, values => values.some(e => e.type === 'control-endpoint-state' && e.state === 'unavailable'), 'foreign owner prevents original publication')
    expect((await lstat(scope.socketPath)).ino).toBe(original.ino)
    await new Promise<void>(resolve => foreign.close(() => resolve()))
    for (const kind of ['file', 'symlink']) {
      if (kind === 'file') await writeFile(scope.socketPath, 'foreign data')
      else await symlink(join(scope.root, 'missing-target'), scope.socketPath)
      const before = await lstat(scope.socketPath)
      await new Promise(resolve => setTimeout(resolve, 1200))
      expect((await lstat(scope.socketPath)).ino).toBe(before.ino)
      await rm(scope.socketPath)
    }
    await until(async () => { try { return (await lstat(scope.socketPath)).isSocket() } catch { return false } }, value => value, 'publication resumes only after foreign entry is cleared')
    expect((await scope.client()).runtimeOwnerIdentity()).toEqual(scope.owner)
  }, 60_000)
  it('does not unlink a foreign replacement of its private listener when retiring or stopping', async () => {
    const scope = await fixture(), client = await scope.client()
    const directory = dirname(scope.socketPath)
    const anchor = (await readdir(directory)).find(value => value !== 'headless.sock' && value !== 'headless.sock.owner.lock')!
    expect(anchor).toBeTruthy()
    const path = join(directory, anchor)
    await rm(path)
    const foreign = createServer(socket => socket.end('still-foreign'))
    await new Promise<void>(resolve => foreign.listen(path, resolve))
    try {
      const identity = await lstat(path)
      await rm(scope.socketPath)
      await until(async () => { try { return (await lstat(scope.socketPath)).isSocket() } catch { return false } }, value => value, 'new listener publication while private alias has a foreign owner')
      expect((await lstat(path)).ino).toBe(identity.ino)
      expect(client.runtimeOwnerIdentity()).toEqual(scope.owner)
      await scope.stopOwner()
      expect((await lstat(path)).ino).toBe(identity.ino)
      const received = await new Promise<string>((resolve, reject) => { const socket = createConnection(path); let bytes = ''
        socket.on('data', data => { bytes += String(data) }); socket.once('end', () => resolve(bytes)); socket.once('error', reject) })
      expect(received).toBe('still-foreign')
    } finally { await new Promise<void>(resolve => foreign.close(() => resolve())) }
  }, 60_000)
  it('settles an actual worker spawn error and stops without hanging or resurrecting the endpoint', async () => {
    const scope = await fixture(), client = await scope.client(), events: AgentMuxClientEvent[] = []
    client.onEvent(e => events.push(e))
    await writeFile(join(scope.env.AGENTMUX_STATE_DIRECTORY!, 'listener-spawn-failure'), 'held')
    await rm(dirname(scope.socketPath), { recursive: true })
    await until(() => events, values => values.some(e => e.type === 'control-endpoint-state' && e.state === 'unavailable' && e.diagnostic.code === 'ENOENT'), 'actual Node fork spawn error is observable')
    expect(events.some(e => e.type === 'connection-state' && e.state === 'lost')).toBe(false)
    await scope.stopOwner()
    await new Promise(resolve => setTimeout(resolve, 1200))
    await expect(lstat(scope.socketPath)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 60_000)
  it('retains the first ENOSPC cause and one exact candidate through cleanup failure until resources recover', async () => {
    const scope = await fixture(), client = await scope.client(), events: AgentMuxClientEvent[] = []
    client.onEvent(e => events.push(e))
    const state = scope.env.AGENTMUX_STATE_DIRECTORY!, pressure = join(state, 'publication-pressure'), cleanup = join(state, 'publication-cleanup-failure')
    await Promise.all([writeFile(pressure, 'held'), writeFile(cleanup, 'held')])
    await rm(dirname(scope.socketPath), { recursive: true })
    await until(() => events, values => values.some(e => e.type === 'control-endpoint-state' && e.state === 'unavailable' && e.diagnostic.code === 'ENOSPC' && e.diagnostic.message.includes('EIO')), 'first publication error preserves secondary cleanup error')
    const anchors = await readdir(dirname(scope.socketPath))
    expect(anchors).toHaveLength(1)
    await new Promise(resolve => setTimeout(resolve, 2300))
    expect(await readdir(dirname(scope.socketPath))).toEqual(anchors)
    expect((await readFile(join(state, 'publication-pressure-attempts'), 'utf8')).trim().split('\n')).toHaveLength(1)
    expect(events.filter(e => e.type === 'control-endpoint-state' && e.state === 'unavailable').every(e => e.type === 'control-endpoint-state' && e.state === 'unavailable' && e.diagnostic.code === 'ENOSPC')).toBe(true)
    const failedAt = events.map(e => e.type === 'control-endpoint-state' && e.state === 'unavailable').lastIndexOf(true)
    await Promise.all([rm(pressure), rm(cleanup)])
    await until(() => events.slice(failedAt + 1), values => values.some(e => e.type === 'control-endpoint-state' && e.state === 'available'), 'same original owner recovers after cleanup and publication resources return')
    expect((await scope.client()).runtimeOwnerIdentity()).toEqual(scope.owner)
  }, 60_000)
})
function basenameFor(path: string) { return path.split('/').at(-1)! }
async function acceptedRpc(path: string) {
  const socket = createConnection(path)
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
  const pending = new Map<string, { resolve(value: Record<string, unknown>): void; reject(error: unknown): void }>()
  const events: AgentMuxClientEvent[] = [], transfer = new AgentMuxHostedTransferReader()
  let bytes = ''
  socket.on('data', chunk => {
    bytes += String(chunk)
    while (bytes.includes('\n')) {
      const line = bytes.slice(0, bytes.indexOf('\n')); bytes = bytes.slice(bytes.indexOf('\n') + 1)
      const frame = JSON.parse(line)
      if (frame.id !== undefined) {
        const request = pending.get(frame.id); pending.delete(frame.id)
        if (frame.error) request?.reject(new Error(frame.error.message)); else request?.resolve(frame.result)
      } else if (frame.method === 'system.subscription.event' && frame.params.event.type === 'snapshot') {
        const value = transfer.accept(frame.params.event.data) as { kind: string; event?: AgentMuxClientEvent } | undefined
        if (value?.kind === 'event' && value.event) events.push(value.event)
      }
    }
  })
  socket.on('error', error => { for (const request of pending.values()) request.reject(error); pending.clear() })
  socket.on('close', () => { for (const request of pending.values()) request.reject(new Error('Accepted fixture transport closed.')); pending.clear() })
  return { events, call: async (method: string, params: unknown): Promise<Record<string, unknown>> => {
    const id = randomUUID()
    return await new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n') })
  }, close: () => socket.destroy() }
}
