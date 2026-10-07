import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentMuxError } from '../src/errors.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import type { ConnectionDelivery, ConnectionDeliveryPort, ConnectionDeliveryObservation, ConnectionPort, RoomBindingCallContext } from '../src/connections.js'
import { ObjectCliProbe, objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import { deliveryFact } from './fixtures/connection-delivery.js'

const close: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const dispose of close.splice(0).reverse()) await dispose() })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'delivery-consumer-')); close.push(() => rm(root, { recursive: true, force: true }))
  const first: ConnectionDelivery = { ...deliveryFact('z-original'), state: 'not-applied', reason: 'platform-rejected', receipt: { state: 'not-applied', reason: 'platform-rejected' } }
  const unknown: ConnectionDelivery = { ...deliveryFact('a-unknown'), state: 'unknown', reason: 'effect-unconfirmed', receipt: { state: 'unknown', reason: 'effect-unconfirmed' } }
  const facts = new Map([first, unknown].map(fact => [fact.operationId, fact])), calls: Array<{ method: string; operationId?: string; actor?: RoomBindingCallContext['actor'] }> = []
  let authorized = true, observation: ConnectionDeliveryObservation | undefined
  const delivery: ConnectionDeliveryPort = {
    inspect: async input => { calls.push({ method: 'inspect', ...input }); return { delivery: structuredClone(facts.get(input.operationId) ?? null) } },
    list: async input => {
      calls.push({ method: 'list' }); const all = [...facts.values()]
      const start = input.after === undefined ? 0 : all.findIndex(fact => fact.operationId === input.after) + 1
      const page = all.slice(start, start + (input.limit ?? 30))
      return { deliveries: structuredClone(page), next: start + page.length < all.length ? page.at(-1)!.operationId : null, ...(observation ? { observation } : {}) }
    },
    retry: async (input, context) => {
      await context.assertCurrent?.(); calls.push({ method: 'retry', ...input, actor: context.actor })
      const original = facts.get(input.operationId)
      if (!authorized) throw new AgentMuxError('The exact original audience is no longer authorized.', 'PUBLICATION_NOT_AUTHORIZED')
      if (!original || original.state !== 'not-applied') throw new AgentMuxError('Inspect the original operation; non-application is not confirmed.', 'PUBLICATION_RETRY_UNCONFIRMED')
      const { reason: _reason, ...retained } = original
      const pending: ConnectionDelivery = { ...retained, state: 'pending' }; facts.set(input.operationId, pending)
      return { delivery: structuredClone(pending) }
    }
  }
  const connections: ConnectionPort = { delivery, list: async () => ({ connections: [] }), inspect: async () => ({ connection: null, operation: null }), configure: async () => { throw new Error('Outside this finite fixture') }, test: async () => { throw new Error('Outside this finite fixture') } }
  const socketPath = join(root, 'public.sock'), server = new AgentMuxControlServer({ socketPath, connections, coreClients: () => { throw new Error('Delivery inspection must not create or borrow another Runtime') } })
  await server.start(); close.push(() => server.stop())
  const env = objectCliEnvironment(root), cli = (args: string[]) => runCompiledObjectCli(['--endpoint', 'unix:' + socketPath, 'connection', 'delivery', ...args], env)
  return { first, unknown, facts, calls, delivery, connections, root, env, socketPath, cli, revoke: () => { authorized = false }, observe: (value: ConnectionDeliveryObservation) => { observation = value } }
}
function result(output: { code: number; stdout: string; stderr: string }) { expect(output.code, output.stdout + output.stderr).toBe(0); return JSON.parse(output.stdout).result }

describe('compiled public delivery consumers', () => {
  it('reads exact original facts and bounded continuations through CLI and SDK, then requests only an explicit same-ID retry', async () => {
    const f = await fixture()
    expect(result(await f.cli(['inspect', '--operation-id', f.first.operationId])).delivery).toEqual(f.first)
    const args = ['ls', '--connection', f.first.target.connectionId, '--binding', f.first.bindingId, '--binding-revision', String(f.first.bindingRevision), '--limit', '1']
    const firstPage = result(await f.cli(args)); expect(firstPage).toEqual({ deliveries: [f.first], next: f.first.operationId })
    expect(result(await f.cli([...args, '--after', firstPage.next]))).toEqual({ deliveries: [f.unknown], next: null })
    expect(f.calls.filter(call => call.method === 'retry')).toEqual([])
    const sdk = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: f.socketPath } }); close.push(() => sdk.dispose())
    expect(await sdk.call('connection.delivery.inspect', { operationId: 'missing' })).toEqual({ delivery: null })
    const retried = result(await f.cli(['retry', '--operation-id', f.first.operationId])).delivery
    expect(retried).toEqual({ ...f.first, state: 'pending', reason: undefined })
    expect(retried.receipt).toEqual(f.first.receipt)
    expect(f.calls.filter(call => call.method === 'retry')).toEqual([{ method: 'retry', operationId: f.first.operationId, actor: expect.objectContaining({ kind: 'user' }) }])
    expect([...f.facts.keys()]).toEqual([f.first.operationId, f.unknown.operationId])
  }, 20_000)
  it('preserves unknown and revoked original deliveries while forwarding only transport-approved retry authority', async () => {
    const f = await fixture(), service = new AgentMuxRpcService({ connections: f.connections }); close.push(() => service.dispose())
    expect((await f.cli(['retry', '--operation-id', f.unknown.operationId])).code).not.toBe(0)
    expect(result(await f.cli(['inspect', '--operation-id', f.unknown.operationId])).delivery).toEqual(f.unknown)
    f.revoke(); expect((await f.cli(['retry', '--operation-id', f.first.operationId])).code).not.toBe(0)
    expect(result(await f.cli(['inspect', '--operation-id', f.first.operationId])).delivery).toEqual(f.first)
    await expect(service.call('connection.delivery.retry', { operationId: f.first.operationId }, {})).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    const principal = { principal: { kind: 'device' as const, id: 'approved-device' } }
    await expect(service.call('connection.delivery.retry', { operationId: f.first.operationId }, principal)).rejects.toMatchObject({ code: 'PUBLICATION_NOT_AUTHORIZED' })
    expect(f.calls.at(-1)).toEqual({ method: 'retry', operationId: f.first.operationId, actor: principal.principal })
    let authorityChecks = 0
    await expect(service.call('connection.delivery.retry', { operationId: f.first.operationId }, { ...principal, assertCurrent: () => { if (++authorityChecks === 2) throw new AgentMuxError('The original authority changed.', 'CONTROL_PERMISSION_DENIED') } })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    expect(authorityChecks).toBe(2)
    expect(f.facts.get(f.first.operationId)).toEqual(f.first)
    await expect(service.call('connection.delivery.retry', { operationId: f.first.operationId, actor: { kind: 'user', id: 'forged' } } as never, principal)).rejects.toMatchObject({ code: 'INVALID_CONNECTION_DELIVERY_DATA' })
    delete f.connections.delivery
    await expect(service.call('connection.delivery.inspect', { operationId: f.first.operationId }, principal)).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
    expect(await service.call('connection.ls', {}, principal)).toEqual({ connections: [] })
  }, 20_000)
  it('reads a scoped source Gap before any effect exists, then reports current worker recovery without inventing delivery facts', async () => {
    const f = await fixture(); f.facts.clear(); f.observe({ state: 'unknown', reason: 'source-gap' })
    const args = ['ls', '--connection', f.first.target.connectionId, '--binding', f.first.bindingId, '--binding-revision', String(f.first.bindingRevision)]
    expect(result(await f.cli(args))).toEqual({ deliveries: [], next: null, observation: { state: 'unknown', reason: 'source-gap' } })
    f.observe({ state: 'ready' })
    expect(result(await f.cli(args))).toEqual({ deliveries: [], next: null, observation: { state: 'ready' } })
    expect(f.facts.size).toBe(0); expect(f.calls.every(call => call.method === 'list')).toBe(true)
  }, 20_000)
  it('generates complete usable help and rejects malformed original identities before consuming a wire response', async () => {
    const f = await fixture()
    const help = await runCompiledObjectCli(['connection', 'delivery', 'ls', '--help'], f.env)
    expect(help.code).toBe(0); expect(help.stdout).toContain('--binding-revision'); expect(help.stdout).toContain('--after'); expect(help.stdout).toContain('--limit')
    const retryHelp = await runCompiledObjectCli(['connection', 'delivery', 'retry', '--help'], f.env)
    expect(retryHelp.code).toBe(0); expect(retryHelp.stdout).toContain('Unknown operations cannot be retried'); expect(retryHelp.stdout).toContain('same operation')
    const skill = await runCompiledObjectCli(['connection', '--help'], f.env)
    expect(skill.code).toBe(0); expect(skill.stdout).toContain('connection delivery inspect'); expect(skill.stdout).toContain('connection delivery retry')
    expect((await f.cli(['ls', '--connection', f.first.target.connectionId, '--binding', f.first.bindingId, '--binding-revision', '3', '--limit', '101'])).code).not.toBe(0)
    const probe = new ObjectCliProbe(() => ({ delivery: { ...f.first, operationId: 'foreign', prepared: 'private-wire', payload: 'private-body' } })); await probe.start(); close.push(() => probe.stop())
    const bad = await runCompiledObjectCli(['--endpoint', 'unix:' + probe.socketPath, 'connection', 'delivery', 'inspect', '--operation-id', f.first.operationId], probe.environment())
    expect(bad.code).not.toBe(0); expect(bad.stdout + bad.stderr).not.toContain('private-wire'); expect(bad.stdout + bad.stderr).not.toContain('private-body')
  }, 20_000)
})
