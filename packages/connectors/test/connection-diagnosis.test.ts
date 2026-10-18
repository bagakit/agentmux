import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { AgentMuxControlServer } from '../../core/dist/public-rpc-server.js'
import { AgentMuxRpcService } from '../../core/dist/public-rpc-service.js'
import { connectAgentMuxRpc } from '../../core/dist/public-rpc-client.js'
import { parseConnectionParams, parseConnectionResult, formatGroupDiagnosis } from '../../core/dist/connections.js'
import { runCompiledObjectCli, objectCliEnvironment } from '../../core/test/helpers/object-cli-rpc.js'
import { ingressFixture } from './fixtures/ingress.js'
import { config, context } from './fixtures/room-binding.js'
import type { AgentMuxStoredAgentSession } from '../../core/src/types.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture() {
  const f = await ingressFixture(); cleanup.push(() => f.close())
  const original = (await f.store.load())[0] as AgentMuxStoredAgentSession
  const { nativeHandle: _nativeHandle, nativeBinding: _nativeBinding, ...callerRecord } = original
  await f.store.compareAndSwap(null, { ...callerRecord, agentSessionId: 'diagnosing-agent', run: { runId: 'diagnosing-run' } })
  await f.inner.registry.load('local')
  const credentials = { agentSessionId: 'diagnosing-agent', capability: f.capability }
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'diagnosis.sock'), connections: f.connections, coreClients: f.coreClients })
  await server.start(); cleanup.push(() => server.stop())
  const sdk = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path }, credentials }); cleanup.push(() => sdk.dispose())
  const target = { executionHostId: 'local', agentSessionId: 'original-agent' }
  const env = objectCliEnvironment(f.root, { AGENTMUX_AGENT_SESSION_ID: credentials.agentSessionId, AGENTMUX_AGENT_CAPABILITY: credentials.capability, AGENTMUX_AGENT_SESSION_STORE: join(f.root, 'sessions.json') })
  const cli = (args: string[], overrides = {}) => runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'connection', ...args], { ...env, ...overrides })
  return { ...f, credentials, server, sdk, cli, target }
}
const output = (value: { code: number | null; stdout: string; stderr: string }) => { expect(value.code, value.stdout + value.stderr).toBe(0); return JSON.parse(value.stdout).result }

it('compiled CLI and SDK expose only the safe cross-Session diagnosis while keeping the authenticated caller and old private guards', async () => {
  const f = await fixture(), author = vi.spyOn(f.client, 'authorizeRetainedAgentCaller')
  expect(await f.sdk.call('connection.binding.ls', { agentSessionId: 'diagnosing-agent' })).toEqual({ bindings: [] })
  for (const [method, input] of [
    ['connection.service.get', {}], ['connection.binding.ls', f.target], ['connection.inspect', { connectionId: config.connectionId }],
    ['connection.binding.inspect', { bindingId: f.input.bindingId }], ['connection.configure', { operationId: 'forbidden-configure', expectedRevision: 1, connection: config }],
    ['connection.ingress.ls', { connectionId: config.connectionId }]
  ] as const) await expect(f.sdk.call(method, input)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  const configure = vi.spyOn(f.connections, 'configure'), submit = vi.spyOn(f.client, 'submitAgentMessage'), rejoin = vi.spyOn(f.client, 'rejoinAgentInputWaiting')
  const report = await f.sdk.call('connection.diagnose', f.target)
  expect(report.groups.value?.items).toHaveLength(1)
  expect(report.groups.value?.items[0]).toMatchObject({ target: { bindingId: f.input.bindingId, connectionId: config.connectionId, ...f.target }, binding: { value: { state: 'active', activeInputGrants: 1, activeAnswerGrants: 0, activePermissionGrants: 0, scope: f.input.scope } } })
  expect(output(await f.cli(['diagnose', '--host', 'local', '--session', 'original-agent']))).toEqual(report)
  expect(author.mock.calls.length).toBeGreaterThan(1)
  expect(author.mock.calls.every(call => call[0] === f.capability && call[1] === 'diagnosing-agent')).toBe(true)
  const encoded = JSON.stringify(report)
  for (const secret of [config.credentialRef, f.actor.userId, 'authorizedBy', 'sourceCheckpoints', 'body', 'raw_payload', f.root]) expect(encoded).not.toContain(secret)
  expect(configure).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled(); expect(rejoin).not.toHaveBeenCalled()
  const invalid = await f.cli(['diagnose', '--host', 'local', '--session', 'original-agent'], { AGENTMUX_AGENT_CAPABILITY: 'forged' })
  expect(invalid.code).not.toBe(0); expect(invalid.stdout + invalid.stderr).not.toContain(f.input.bindingId)
  const help = await f.cli(['diagnose', '--help']); expect(help.code).toBe(0); expect(help.stdout).toContain('original caller identity'); expect(help.stdout).toContain('newest bounded intake')
  const skill = await f.cli(['--skill']); expect(skill.stdout).toContain('connection diagnose')
}, 30_000)

it('reads the newest exact audience across aliases, keeps refused events, and follows the original older cursor without replay', async () => {
  const f = await fixture()
  await f.connections.configure({ operationId: 'alias-configure', expectedRevision: null, connection: { ...config, connectionId: 'receiver-alias' } })
  const received = []
  for (let index = 0; index < 8; index++) {
    const event = f.event({ eventId: 'group-event-' + index, messageId: 'group-message-' + index, body: 'PRIVATE message ' + index })
    const result = await f.ingress.receive({ connectionId: index % 2 ? 'receiver-alias' : config.connectionId, raw: JSON.stringify({ proof: 'adapter-private-witness', event }) }, () => {})
    received.push(result.ingress)
  }
  const foreign = await f.receive({ eventId: 'foreign-group-event', messageId: 'foreign-group-message', externalConversationId: 'different-room' })
  const refused = await f.receive({ eventId: 'refused-event', messageId: 'refused-message', actor: { ...f.actor, userId: 'unapproved-private-member' } })
  await f.ingress.dispatch(refused.ingress.ingressId)
  const dispatch = vi.spyOn(f.ingress, 'dispatch'), writes = vi.spyOn(f.client, 'submitAgentMessage')
  const request = { ...f.target, bindingId: f.input.bindingId }
  const report = await f.sdk.call('connection.diagnose', request), page = report.groups.value!.items[0]!.incoming.value!
  expect(page.rows.map(row => row.ingressId)).toEqual([refused.ingress.ingressId, ...received.slice(-4).reverse().map(row => row.ingressId)])
  expect(page.rows[0]).toMatchObject({ state: 'refused', code: 'INGRESS_ACTOR_NOT_AUTHORIZED', scope: 'group-event', coreStatus: null })
  expect(page.rows.some(row => row.sourceConnectionId === 'receiver-alias')).toBe(true)
  expect(page.rows.some(row => row.ingressId === foreign.ingress.ingressId)).toBe(false)
  const older = await f.sdk.call('connection.diagnose', { ...request, beforeIngressId: page.next! })
  expect(older.groups.value!.items[0]!.incoming.value!.rows.map(row => row.ingressId)).toEqual(received.slice(0, 4).reverse().map(row => row.ingressId))
  expect(older.groups.value!.items[0]!.incoming.value!.next).toBeNull()
  const wrongCursor = await f.sdk.call('connection.diagnose', { ...request, beforeIngressId: foreign.ingress.ingressId })
  expect(wrongCursor.groups.value!.items[0]!.incoming).toEqual({ value: null, issue: 'read-unavailable' })
  expect(dispatch).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled()
  expect(JSON.stringify(report)).not.toMatch(/PRIVATE|unapproved-private-member|different-room/)
}, 30_000)

it('projects the original Core waiting reason and aliases separately without waking or replaying the input', async () => {
  const f = await fixture()
  await f.connections.configure({ operationId: 'alias-configure', expectedRevision: null, connection: { ...config, connectionId: 'receiver-alias' } })
  const received = await f.ingress.receive({ connectionId: 'receiver-alias', raw: JSON.stringify({ proof: 'adapter-private-witness', event: f.event() }) }, () => {})
  const original = await f.ingress.dispatch(received.ingress.ingressId)
  expect(original.inputReceipt?.status).toBe('waiting')
  await vi.waitFor(async () => expect((await f.ingress.inspect({ ingressId: received.ingress.ingressId })).inputReceipt?.control.waiting).toMatchObject({ phase: 'runtime', reason: 'runtime-unavailable' }))
  const submit = vi.spyOn(f.client, 'submitAgentMessage'), rejoin = vi.spyOn(f.client, 'rejoinAgentInputWaiting')
  const report = await f.sdk.call('connection.diagnose', f.target), group = report.groups.value!.items[0]!
  expect(group.incoming.value!.rows[0]).toMatchObject({ sourceConnectionId: 'receiver-alias', targetConnectionId: config.connectionId, scope: 'current-binding', coreStatus: 'waiting', inputOperationId: original.ingress!.input!.operationId, waiting: { phase: 'runtime', reason: 'runtime-unavailable', wake: 'runtime-restored' } })
  expect(formatGroupDiagnosis({ ...group, service: report.service })).toContain('waiting runtime / runtime-unavailable / runtime-restored')
  expect(submit).not.toHaveBeenCalled(); expect(rejoin).not.toHaveBeenCalled()
}, 30_000)

it('keeps partial owner failures and mismatched targets explicit without leaking raw errors or guessing no groups', async () => {
  const f = await fixture()
  vi.spyOn(f.ingress, 'listAudience').mockRejectedValue(new Error('PRIVATE failure ' + f.root))
  const report = await f.sdk.call('connection.diagnose', f.target), group = report.groups.value!.items[0]!
  expect(group.incoming).toEqual({ value: null, issue: 'read-unavailable' }); expect(group.binding.value?.activeInputGrants).toBe(1)
  expect(report.service.value?.enabled).toBe(true)
  expect(JSON.stringify(report)).not.toMatch(/PRIVATE|failure/)
  const wrong = await f.sdk.call('connection.diagnose', { ...f.target, agentSessionId: 'another-agent', bindingId: f.input.bindingId })
  expect(wrong.groups).toEqual({ value: null, issue: 'target-unconfirmed' }); expect(JSON.stringify(wrong)).not.toContain(config.application.appId)
  vi.spyOn(f.bindings, 'list').mockRejectedValue(new Error('PRIVATE binding error'))
  expect((await f.sdk.call('connection.diagnose', f.target)).groups).toEqual({ value: null, issue: 'read-unavailable' })
}, 30_000)

it('strict diagnosis DTO rejects foreign targets and private fields at every exposed section', async () => {
  const f = await fixture(), report = await f.sdk.call('connection.diagnose', f.target)
  const corruptions = [
    (r: any) => { r.target.agentSessionId = 'another-agent' }, (r: any) => { r.body = 'private' },
    (r: any) => { r.service.value.credential = 'private' }, (r: any) => { r.groups.value.items[0].target.executionHostId = 'another-host' },
    (r: any) => { r.groups.value.items[0].binding.value.members = [f.actor] }, (r: any) => { r.groups.value.items[0].connection.value.credentialRef = config.credentialRef }
  ]
  for (const change of corruptions) { const altered = structuredClone(report); change(altered); expect(() => parseConnectionResult('connection.diagnose', altered, f.target)).toThrow() }
  expect(() => parseConnectionParams('connection.diagnose', { agentSessionId: 'original-agent' })).toThrow()
  expect(() => parseConnectionParams('connection.diagnose', { ...f.target, caller: f.credentials })).toThrow()
  expect(() => parseConnectionParams('connection.diagnose', { ...f.target, beforeIngressId: 'unscoped-cursor' })).toThrow()
}, 30_000)

it('forwards the original managed caller to the safe projection without granting an admin identity', async () => {
  const f = await fixture(), inner = new AgentMuxRpcService({ connections: f.connections, coreClients: f.coreClients }), contexts: unknown[] = []
  const outer = new AgentMuxRpcService({ coreClients: f.coreClients, forwardControl: async (method, input, context) => { contexts.push(context.caller); return await inner.call(method, input, context) as never } })
  const report = await outer.call('connection.diagnose', f.target, { caller: f.credentials })
  expect(report.groups.value?.items[0]?.target.bindingId).toBe(f.input.bindingId)
  expect(contexts).toEqual([f.credentials])
  await expect(outer.call('connection.service.get', {}, { caller: f.credentials })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(contexts).toEqual([f.credentials, f.credentials])
}, 30_000)

it('bounds large original coverage pages without hiding the remaining gaps or unrelated diagnosis sections', async () => {
  const f = await fixture()
  // Controlled local delivery read boundary; the diagnosis must respect the original unbounded gap contract.
  f.connections.delivery = { inspect: async () => ({ delivery: null }), retry: async () => { throw new Error('Unexpected retry') }, list: async () => ({ deliveries: [], next: null, coverage: { state: 'incomplete', nextContent: null, origins: [], gaps: Array.from({ length: 105 }, (_, index) => ({ gapId: 'original-gap-' + index, reason: 'source-gap' })) } }) }
  const report = await f.sdk.call('connection.diagnose', f.target), group = report.groups.value!.items[0]!
  expect(group.outgoing.value?.coverage).toMatchObject({ state: 'incomplete', omittedGapCount: 100 })
  expect(group.outgoing.value?.coverage?.gaps.map(gap => gap.gapId)).toEqual(['original-gap-0', 'original-gap-1', 'original-gap-2', 'original-gap-3', 'original-gap-4'])
  expect(group.binding.value?.activeInputGrants).toBe(1); expect(group.incoming.issue).toBeNull()
  expect(formatGroupDiagnosis({ ...group, service: report.service })).toContain('Additional gaps in this owner page: 100')
}, 30_000)

it('keeps the original legal room metadata limit through the real binding owner and public diagnosis codec', async () => {
  const f = await fixture(), externalConversationId = 'g'.repeat(16_384)
  expect(await f.bindings.relink({ ...f.input, operationId: 'long-group-metadata', expectedRevision: 1, externalConversationId }, context)).toMatchObject({ state: 'applied' })
  const report = await f.sdk.call('connection.diagnose', f.target)
  expect(report.groups.value!.items[0]!.target.externalConversationId).toBe(externalConversationId)
  expect(parseConnectionResult('connection.diagnose', report, f.target)).toEqual(report)
  const oversized = structuredClone(report)
  oversized.groups.value!.items[0]!.target.externalConversationId += 'g'
  expect(() => parseConnectionResult('connection.diagnose', oversized, f.target)).toThrow()
}, 30_000)
