import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { AgentMuxControlServer } from '../../core/dist/public-rpc-server.js'
import { AgentMuxRpcService } from '../../core/dist/public-rpc-service.js'
import { connectAgentMuxRpc } from '../../core/dist/public-rpc-client.js'
import { parseConnectionParams, parseConnectionResult, formatGroupDiagnosis, connectionDiagnosisRecordKey, connectionDiagnosisSourceKey, connectionDiagnosisPartKey, connectionDiagnosisEventKey, connectionDiagnosisGapKey } from '../../core/dist/connections.js'
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
  expect(group.outgoing.value?.coverage?.gaps.map(gap => gap.gapKey)).toEqual(Array.from({ length: 5 }, (_, index) => connectionDiagnosisGapKey(group.target, 'original-gap-' + index)))
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


it('explains source gaps through the real public diagnosis without exposing source errors or records', async () => {
  const f = await fixture()
  f.connections.delivery = { inspect: async () => ({ delivery: null }), retry: async () => { throw new Error('Unexpected retry') }, list: async () => ({ deliveries: [], next: null, coverage: {
    state: 'incomplete', nextContent: null, origins: [], gaps: [
      { gapId: 'cut-gap', reason: 'source-gap', code: 'AGENT_CONVERSATION_READ_CUT_UNAVAILABLE', source: { kind: 'native', providerId: 'fixture', nativeSessionId: 'private-native-session' } },
      { gapId: 'private-gap', reason: 'source-gap', code: 'PRIVATE adapter error', record: { hostId: 'local', agentSessionId: 'original-agent', source: { kind: 'captured', recordId: 'private-epoch' } } },
      { gapId: 'unrecorded-gap', reason: 'source-gap' }
    ]
  } }) }
  const request = { ...f.target, bindingId: f.input.bindingId }
  const report = await f.sdk.call('connection.diagnose', request), group = report.groups.value!.items[0]!
  expect(group.outgoing.value!.coverage!.gaps.map(({ association: _association, ...gap }) => gap)).toEqual([
    { gapKey: connectionDiagnosisGapKey(group.target, 'cut-gap'), reason: 'source-gap', code: 'AGENT_CONVERSATION_READ_CUT_UNAVAILABLE', codeRecorded: true, sourceKind: 'native' },
    { gapKey: connectionDiagnosisGapKey(group.target, 'private-gap'), reason: 'source-gap', code: null, codeRecorded: true, sourceKind: null },
    { gapKey: connectionDiagnosisGapKey(group.target, 'unrecorded-gap'), reason: 'source-gap', code: null, codeRecorded: false, sourceKind: null }
  ])
  expect(output(await f.cli(['diagnose', '--host', 'local', '--session', 'original-agent', '--binding', f.input.bindingId]))).toEqual(report)
  expect(formatGroupDiagnosis({ ...group, service: report.service })).toContain('source native · code AGENT_CONVERSATION_READ_CUT_UNAVAILABLE')
  const encoded = JSON.stringify(report)
  for (const secret of ['PRIVATE', 'private-native-session', 'private-epoch', 'recordId']) expect(encoded).not.toContain(secret)
  const invalid = structuredClone(report)
  invalid.groups.value!.items[0]!.outgoing.value!.coverage!.gaps[0]!.code = 'PRIVATE adapter error' as never
  expect(() => parseConnectionResult('connection.diagnose', invalid, request)).toThrow()
}, 30_000)

it('SDK and compiled CLI correlate original source records and effects using safe keys and finite source evidence', async () => {
  const f = await fixture(), reference = { hostId: 'local', agentSessionId: 'original-agent', source: { kind: 'native' as const, providerId: 'fixture', nativeSessionId: 'PRIVATE native identity', recordId: 'same-physical-id' } }
  const part = { record: reference, recordRevision: 'a'.repeat(64), selector: { kind: 'native-part' as const, partIndex: 0 } }
  const event = { id: 'PRIVATE event identity', revision: 'b'.repeat(64) }, checkpointKey = 'c'.repeat(64)
  const delivery = { operationId: 'original-outgoing', projectionId: 'original-projection', sourceRevision: 'a'.repeat(64), bindingId: f.input.bindingId, bindingRevision: 1,
    reference, target: { connectionId: config.connectionId, application: config.application, externalConversationId: f.input.externalConversationId }, effect: 'upsert' as const, fragment: { ordinal: 0, count: 1 }, state: 'unknown' as const, reason: 'effect-unconfirmed' as const, receipt: { state: 'unknown' as const, reason: 'effect-unconfirmed' as const }, event }
  const sourceObservation = { state: 'unavailable' as const, reason: 'source-gap' as const, code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' as const, codeRecorded: true, checkpointKey }
  const owner = { deliveries: [delivery], next: null, sourceObservation, effectObservation: { state: 'unknown' as const, reason: 'effect-unconfirmed' as const }, coverage: { state: 'incomplete' as const, origins: [], nextContent: null,
    gaps: [{ gapId: 'original-source-gap', reason: 'source-gap' as const, code: sourceObservation.code, source: { kind: 'native' as const, providerId: reference.source.providerId, nativeSessionId: reference.source.nativeSessionId }, record: reference, part, event }] } }
  f.connections.delivery = { list: async () => owner, inspect: vi.fn(async () => ({ delivery: null })), retry: vi.fn(async () => ({ delivery })) }
  const report = await f.sdk.call('connection.diagnose', f.target), group = report.groups.value!.items[0]!, outgoing = group.outgoing.value!
  const association = { sourceKey: connectionDiagnosisSourceKey(reference, reference.source), recordKey: connectionDiagnosisRecordKey(reference), eventKey: connectionDiagnosisEventKey(reference, event), partKey: connectionDiagnosisPartKey(part) }
  expect(outgoing).toMatchObject({ sourceObservation, effectObservation: owner.effectObservation, deliveries: [{ operationId: delivery.operationId, receipt: 'unknown', association: { ...association, partKey: null } }], coverage: { gaps: [{ gapKey: connectionDiagnosisGapKey(group.target, 'original-source-gap'), code: sourceObservation.code, association }] } })
  expect(output(await f.cli(['diagnose', '--host', 'local', '--session', 'original-agent']))).toEqual(report)
  const exported = formatGroupDiagnosis({ ...group, service: report.service })
  expect(exported).toContain('Source read: unavailable · source-gap · code AGENT_SESSION_HISTORY_SOURCE_CHANGED')
  expect(exported).toContain('Unresolved effects: unknown · effect-unconfirmed')
  for (const key of Object.values(association)) expect(exported).toContain(key)
  expect(JSON.stringify(report) + exported).not.toMatch(/PRIVATE|same-physical-id|recordId|nativeSessionId|opaque/)
  expect(connectionDiagnosisRecordKey({ ...reference, hostId: 'another-host' })).not.toBe(association.recordKey)
  expect(connectionDiagnosisRecordKey({ ...reference, agentSessionId: 'another-session' })).not.toBe(association.recordKey)
  expect(connectionDiagnosisRecordKey({ ...reference, source: { ...reference.source, nativeSessionId: 'another-native' } })).not.toBe(association.recordKey)
  expect(connectionDiagnosisSourceKey(reference, { ...reference.source, nativeSessionId: 'another-native' })).not.toBe(association.sourceKey)
  expect(connectionDiagnosisEventKey({ ...reference, agentSessionId: 'another-session' }, event)).not.toBe(association.eventKey)
  expect(connectionDiagnosisEventKey({ ...reference, source: { ...reference.source, nativeSessionId: 'another-native' } }, event)).not.toBe(association.eventKey)
  for (const change of [
    (r: any) => { r.sourceObservation.code = 'PRIVATE code' },
    (r: any) => { r.sourceObservation.checkpointKey = 'PRIVATE cursor' },
    (r: any) => { r.sourceObservation.codeRecorded = false },
    (r: any) => { r.sourceObservation.body = 'PRIVATE' },
    (r: any) => { r.deliveries[0].association.recordKey = reference.source.recordId },
    (r: any) => { r.coverage.gaps[0].association.record = reference },
    (r: any) => { r.effectObservation.state = 'ready' }
  ]) { const altered = structuredClone(report); change(altered.groups.value!.items[0]!.outgoing.value!); expect(() => parseConnectionResult('connection.diagnose', altered, f.target)).toThrow() }
  for (const foreign of [{ ...reference, hostId: 'another-host' }, { ...reference, agentSessionId: 'another-session' }]) {
    owner.deliveries[0] = { ...delivery, reference: foreign }
    expect((await f.sdk.call('connection.diagnose', f.target)).groups.value!.items[0]!.outgoing).toEqual({ value: null, issue: 'target-unconfirmed' })
  }
  owner.deliveries[0] = delivery; owner.coverage.gaps[0]!.record = { ...reference, agentSessionId: 'another-session' }
  expect((await f.sdk.call('connection.diagnose', f.target)).groups.value!.items[0]!.outgoing).toEqual({ value: null, issue: 'target-unconfirmed' })
  expect(f.connections.delivery.retry).not.toHaveBeenCalled(); expect(f.connections.delivery.inspect).not.toHaveBeenCalled()
}, 30_000)

it('diagnosis keeps raw JSON gap identities private and separates the same original gap across binding revisions', async () => {
  const f = await fixture(), originalGapId = JSON.stringify(['local', 'original-agent', 'native', 'fixture', 'PRIVATE native/path', 'PRIVATE record'])
  const originalGap = { gapId: originalGapId, reason: 'source-gap' as const, code: 'AGENT_SESSION_HISTORY_INVALID_CURSOR' }
  const list = vi.fn(async () => ({ deliveries: [], next: null, coverage: { state: 'incomplete' as const, gaps: [originalGap], nextContent: null, origins: [] } }))
  f.connections.delivery = { inspect: async () => ({ delivery: null }), retry: vi.fn(), list }
  const request = { ...f.target, bindingId: f.input.bindingId }, report = await f.sdk.call('connection.diagnose', request)
  const group = report.groups.value!.items[0]!, gap = group.outgoing.value!.coverage!.gaps[0]!
  expect(gap).toMatchObject({ gapKey: connectionDiagnosisGapKey(group.target, originalGapId), code: 'AGENT_SESSION_HISTORY_INVALID_CURSOR' })
  expect(gap.gapKey).toMatch(/^[a-f0-9]{64}$/u)
  expect(group.binding.value?.state).toBe('active'); expect(group.incoming.issue).toBeNull()
  expect(output(await f.cli(['diagnose', '--host', 'local', '--session', 'original-agent', '--binding', f.input.bindingId]))).toEqual(report)
  const exported = formatGroupDiagnosis({ ...group, service: report.service })
  expect(exported).toContain('Content gap ' + gap.gapKey)
  expect(JSON.stringify(report) + exported).not.toMatch(/PRIVATE|native\/path|gapId/)
  expect(originalGap.gapId).toBe(originalGapId)
  const altered = structuredClone(report), changed = altered.groups.value!.items[0]!.outgoing.value!.coverage!.gaps[0]!
  changed.gapKey = originalGapId
  expect(() => parseConnectionResult('connection.diagnose', altered, request)).toThrow()
  expect(await f.bindings.relink({ ...f.input, operationId: 'same-gap-next-binding', expectedRevision: 1 }, context)).toMatchObject({ state: 'applied' })
  const next = await f.sdk.call('connection.diagnose', request), nextGroup = next.groups.value!.items[0]!
  expect(nextGroup.target.bindingRevision).toBe(2)
  expect(nextGroup.outgoing.value!.coverage!.gaps[0]!.gapKey).not.toBe(gap.gapKey)
  expect(connectionDiagnosisGapKey({ ...group.target, executionHostId: 'foreign-host' }, originalGapId)).not.toBe(gap.gapKey)
  expect(connectionDiagnosisGapKey({ ...group.target, agentSessionId: 'foreign-session' }, originalGapId)).not.toBe(gap.gapKey)
  expect(f.connections.delivery.retry).not.toHaveBeenCalled()
}, 30_000)
