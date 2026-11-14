import { parseHostSettingsResult } from '../src/public-rpc-host-settings.js'
import { parseHostExecutorInventory } from '../src/executor-contract.js'
import { afterEach, expect, test, vi } from 'vitest'
import { runSourceObjectCli } from './helpers/source-object-cli.js'
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'
import { executionRouteRpc } from '../src/host-route-rpc.js'
import { hostRouteExecutorOperation, parseHostRouteParams, parseHostRouteResult, type AdoptedHostRoute } from '../src/host-route.js'
import { createHostRouteInventoryFixture, hostRouteInventoryPrincipal as principal } from './helpers/host-route-inventory-fixture.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const fixture = () => createHostRouteInventoryFixture(cleanups)

test('the original viewer gets safe saved choices and the real D inventory despite a same-name B direct Host', async () => {
  const f = await fixture()
  const direct = await f.b.rpc.call('settings.executors.discover', { hostId: 'collision', refresh: false })
  expect(direct).toMatchObject({ runtimeId: 'runtime-C', executors: expect.arrayContaining([expect.objectContaining({ executorId: 'same-executor', command: '/private/runtime-C/original-command' })]) })
  const choices = await f.rpc.call('route.choices', {})
  expect(choices.identity).toEqual(f.b.identity); expect(choices.actor).toEqual(f.actor)
  expect(choices.routes).toEqual([{ id: 'collision', agentTarget: { hostId: 'collision', runtimeId: 'runtime-D', adoptedRoute: f.route } }])
  expect(JSON.stringify(choices)).not.toMatch(/grants|delegator|SECRET|private-environment|hostname|socketPath/)
  const read = await f.rpc.call('route.executors', { agentTarget: choices.routes[0]!.agentTarget, executorId: 'same-executor' })
  expect(read.agentTarget).toEqual(choices.routes[0]!.agentTarget)
  expect(read.inventory).toMatchObject({ runtimeId: 'runtime-D', executors: [{ executorId: 'same-executor', command: '/private/runtime-D/original-command', availability: 'unknown' }] })
  expect(read.inventory.executors[0]!.launchOptions).toEqual(f.original.client.catalog().find(provider => provider.id === 'claude')!.launchOptions)
  expect(read.inventory.executors[0]!.creationContract).toEqual({ ordinaryLaunch: 1 })
  expect(read.observation).toMatchObject({ route: f.route, logicalHops: 2, actor: f.actor, complete: true })
  expect(JSON.stringify(read.inventory)).not.toMatch(/private-argument|private-environment|"env"|"args"/)
  expect(f.inventory).toHaveBeenCalledExactlyOnceWith({ refresh: false, executorId: 'same-executor' })
  expect(f.arrivals).toEqual([{ method: 'runtime.owner.identity', actor: f.actor }, { method: 'runtime.invoke', actor: f.actor }])
  expect(f.connect).not.toHaveBeenCalled(); expect(f.native).not.toHaveBeenCalled(); expect(f.creation).not.toHaveBeenCalled()
  expect(f.original.inner.kernel.stop).not.toHaveBeenCalled()
})

test('an absent receiver grant and an actual managed caller cannot borrow another transport user for inventory', async () => {
  const f = await fixture()
  await f.configure(f.d, [], [])
  await expect(f.rpc.call('route.executors', { agentTarget: { hostId: 'collision', runtimeId: 'runtime-D', adoptedRoute: f.route } })).rejects.toMatchObject({ code: 'HOST_ROUTE_NOT_DELEGATED' })
  expect(f.inventory).not.toHaveBeenCalled()
  await expect(f.a.rpc.call('route.choices', {}, { credentials: f.original.credentials })).rejects.toMatchObject({ code: 'HOST_ROUTE_ACTOR_REQUIRED' })
  expect(f.original.inner.kernel.stop).not.toHaveBeenCalled()
})

test('inventory binds the actual route and semantic owner rather than an unconfirmed direct replacement', async () => {
  const f = await fixture()
  await expect(f.rpc.call('route.executors', { agentTarget: { hostId: 'collision', runtimeId: 'runtime-C', adoptedRoute: { ...f.route, hops: [f.route.hops[0]!] } } })).rejects.toMatchObject({ code: 'HOST_ROUTE_CHANGED' })
  expect(f.arrivals).toEqual([])
  // Keeping the same chain under another saved ID cannot silently retarget the
  // original selected route ID. The generic chain reader alone cannot prove it.
  await f.configure(f.b, [{ id: 'collision', route: { ...f.route, hops: [f.route.hops[0]!] } }, { id: 'other-saved-route', route: f.route }],
    [f.grant('original-A', f.a.identity, f.b.identity, ['route.choices','route.executors'])])
  await expect(f.rpc.call('route.executors', { agentTarget: { hostId: 'collision', runtimeId: 'runtime-D', adoptedRoute: f.route } })).rejects.toMatchObject({ code: 'HOST_ROUTE_CHANGED' })
  expect(f.arrivals).toEqual([])
  await f.configure(f.b, [{ id: 'collision', route: f.route }], [f.grant('original-A', f.a.identity, f.b.identity, ['route.choices','route.executors'])])
  f.wrongRuntime()
  await expect(f.rpc.call('route.executors', { agentTarget: { hostId: 'collision', runtimeId: 'runtime-D', adoptedRoute: f.route } })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' })
  expect(f.inventory).not.toHaveBeenCalled()
})

test('the signed inventory child cannot widen its exact selector or become a cold input grant', async () => {
  const f = await fixture(), input = { agentTarget: { hostId: 'collision', runtimeId: 'runtime-D', adoptedRoute: f.route }, executorId: 'same-executor' }
  await f.rpc.call('route.executors', input)
  // Even an independent receiver input grant cannot turn this readonly parent
  // into an input authorization. Only the child's exact purpose restricts it.
  const scopes = [...f.reads, 'runtime.invoke/writeAgent']
  await f.configure(f.c, [], [f.grant('original-B', f.b.identity, f.d.identity, scopes)])
  await f.configure(f.d, [], [f.grant('original-C', f.c.identity, f.d.identity, scopes)])
  const authorization = await f.b.authority.attestHostRouteExecution({ schema: 'agentmux.host-route-execution.v1', purpose: 'host-route-execution', actor: f.actor,
    parent: f.parents[0]!, scope: { kind: 'executor-inventory', operation: hostRouteExecutorOperation(input) } })
  const changedSelector = await f.b.authority.attestHostRouteExecution({ schema: 'agentmux.host-route-execution.v1', purpose: 'host-route-execution', actor: f.actor,
    parent: f.parents[0]!, scope: { kind: 'executor-inventory', operation: { ...hostRouteExecutorOperation(input), executorId: 'different-executor' } } })
    .then(() => null, error => ({ code: error.code }))
  expect(changedSelector).toEqual({ code: 'HOST_ROUTE_DERIVATION_MISMATCH' })
  const rpc = executionRouteRpc(f.b.gateway, f.route, authorization, undefined, { principal })
  const { owner } = await rpc.call('runtime.owner.identity', { expectedRuntimeId: 'runtime-D' }), before = f.inventory.mock.calls.length
  const fence = { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId }
  await expect(rpc.call('runtime.invoke', { consumerId: 'original-read', fence, invocation: { method: 'listHostExecutors', args: [{ refresh: false }] } })).rejects.toMatchObject({ code: 'HOST_ROUTE_DERIVATION_MISMATCH' })
  await expect(rpc.call('runtime.invoke', { consumerId: 'original-read', fence, invocation: { method: 'writeAgent', args: [{ agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, data: 'not authorized by inventory', source: 'user' }] } })).rejects.toMatchObject({ code: 'HOST_ROUTE_DERIVATION_MISMATCH' })
  expect(f.inventory).toHaveBeenCalledTimes(before)
  expect(f.original.rawInput).not.toHaveBeenCalled()
})

test('strict public readers reject fabricated Agent targets and executable availability is not a qualification field', () => {
  const identity = (runtimeId: string) => ({ runtimeId, publicKey: runtimeId + '-public-key', fingerprint: runtimeId + '-fingerprint' })
  const b = identity('B'), d = identity('D'), route: AdoptedHostRoute = { source: b, hops: [{ edgeId: 'D', target: d }] }
  const agentTarget = { hostId: 'original-route', runtimeId: 'D', adoptedRoute: route }, actor = { source: b, ...principal }
  const choices = { identity: b, actor, routes: [{ id: 'original-route', agentTarget }], observedAt: 1 }
  expect(parseHostRouteResult('route.choices', choices)).toEqual(choices)
  expect(() => parseHostRouteParams('route.executors', { agentTarget, principal })).toThrow()
  expect(() => parseHostRouteResult('route.choices', { ...choices, routes: [{ id: 'original-route', agentTarget: { ...agentTarget, hostId: 'route:original-route' } }] })).toThrow()
  const descriptor = { executorId: 'original', label: 'Original', providerId: 'claude', command: '/original/command', source: 'registered', configRevision: 'revision', availability: 'unknown' }
  const result = { routeId: 'original-route', agentTarget, inventory: { runtimeId: 'D', executors: [descriptor] },
    observation: { route, actor, requestId: 'original-read', logicalHops: 1, observedAt: 1, complete: true } }
  expect(parseHostRouteResult('route.executors', result)).toEqual(result)
  expect(() => parseHostRouteResult('route.executors', { ...result, inventory: { runtimeId: 'D', executors: [{ ...descriptor, outpostQualified: true }] } })).toThrow()
})


test('the actual CLI reads the same original route choices and executor owner', async () => {
  const f = await fixture(), env = objectCliEnvironment(f.original.root)
  const endpoint = 'unix:' + f.original.root + '/B.sock'
  const choicesReply = await runSourceObjectCli(['--endpoint', endpoint, 'route', 'choices'], env)
  expect(choicesReply.stderr).not.toMatch(/Error:|ERR_/)
  expect(choicesReply.code).toBe(0)
  const choices = JSON.parse(choicesReply.stdout).result
  expect(choices.routes[0].agentTarget).toEqual({ hostId: 'collision', runtimeId: 'runtime-D', adoptedRoute: f.route })
  // This CLI is the actual B user, not A's source-qualified actor. Each receiver
  // independently grants B's exact metadata calls for this separate public read.
  const actor = { source: f.b.identity, ...principal }
  await f.configure(f.c, [], [{ id: 'B-user', delegator: f.b.identity, destination: f.d.identity, actor, scopes: f.reads }])
  await f.configure(f.d, [], [{ id: 'C-for-B-user', delegator: f.c.identity, destination: f.d.identity, actor, scopes: f.reads }])
  const read = await runSourceObjectCli(['--endpoint', endpoint, 'route', 'executors', '--input', '-'], env,
    JSON.stringify({ agentTarget: choices.routes[0].agentTarget, executorId: 'same-executor' }))
  expect(read.code, read.stderr).toBe(0)
  expect(JSON.parse(read.stdout).result).toMatchObject({ agentTarget: choices.routes[0].agentTarget,
    inventory: { runtimeId: 'runtime-D', executors: [{ executorId: 'same-executor', availability: 'unknown' }] } })
  expect(JSON.parse(read.stdout).result.inventory.executors[0].launchOptions).toEqual(f.original.client.catalog().find(provider => provider.id === 'claude')!.launchOptions)
  expect(f.inventory).toHaveBeenCalledExactlyOnceWith({ refresh: false, executorId: 'same-executor' })
  expect(f.native).not.toHaveBeenCalled(); expect(f.creation).not.toHaveBeenCalled()
})

test('Settings and route inventory share the same exact registered publication witness codec', () => {
  const descriptor = { executorId: 'original', label: 'Original', providerId: 'claude', command: '/original/command', source: 'registered', configRevision: 'content-revision', registrationRevision: 'original-publication', availability: 'unknown' }
  const read = (executor: unknown) => parseHostSettingsResult('settings.executors.discover', { routeHostId: 'local', runtimeId: 'original-runtime', executors: [executor] }, { hostId: 'local' })
  expect(read(descriptor).executors[0]).toEqual(descriptor)
  expect(parseHostExecutorInventory({ runtimeId: 'original-runtime', executors: [descriptor] }).executors[0]).toEqual(descriptor)
  for (const registrationRevision of [null, '', 'wrong\npublication', 1, {}]) {
    expect(() => read({ ...descriptor, registrationRevision })).toThrow()
    expect(() => parseHostExecutorInventory({ runtimeId: 'original-runtime', executors: [{ ...descriptor, registrationRevision }] })).toThrow()
  }
  expect(() => read({ ...descriptor, source: 'provider-default' })).toThrow()
  const { registrationRevision: _generation, ...unconfirmed } = descriptor
  expect(read(unconfirmed).executors[0]).toEqual(unconfirmed)
})
