// @vitest-environment happy-dom
import { isObjectId } from '@agentmux/core'
import { afterEach, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { agentInteractionIntentDigest, agentInteractionRequestDigest } from '../../core/dist/index.js'
import { permissionActionsFixture } from './fixtures/permission-actions.js'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
async function fixture(initialCoreAvailable = true) { const value = await permissionActionsFixture(initialCoreAvailable); cleanup.push(() => value.close()); return value }
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

it('authenticates the SDK callback, commits before ACK, restores real execution-Host authority and writes the original Hook once', async () => {
  const f = await fixture()
  const grant = await f.grant(); expect(grant.state).toBe('applied')
  const original = await f.open()
  await vi.waitFor(() => expect(f.buttons().length).toBeGreaterThan(0), { timeout: 8_000 })
  expect(f.effects.filter(effect => effect.method === 'POST')).toHaveLength(1)
  expect(JSON.stringify(f.card())).toContain('original command')
  const button = f.buttons().find(value => /deny|reject/i.test(value.text.content))!
  expect(button, 'Actual original deny option must be rendered').toBeDefined()
  expect(isObjectId(button.value.actionRef)).toBe(true)
  const ingress = f.services.ingress!, receive = ingress.receive.bind(ingress)
  const respond = vi.spyOn(f.original.client, 'respondAgentInteraction')
  const receiveSpy = vi.spyOn(ingress, 'receive').mockImplementation(async (input, ack) => await receive(input, async () => {
    const database = new DatabaseSync(join(f.original.root, 'connectors', 'connections.sqlite'))
    try {
      const row = database.prepare('SELECT record_json,raw_payload FROM connection_ingress_event WHERE event_id=?').get(JSON.parse(input.raw).header.event_id)!
      expect(row.raw_payload).toBe(input.raw); expect(JSON.parse(String(row.record_json))).toMatchObject({ kind: 'action', state: 'received' })
      expect(respond).not.toHaveBeenCalled()
    } finally { database.close() }
    await ack()
  }))
  await f.sdk.receive(f.action(button.value.actionRef))
  expect(f.sdk.ack().at(-1).code).toBe(200)
  receiveSpy.mockRestore()
  await expect(original.callback).resolves.toMatchObject({ hookSpecificOutput: { decision: { behavior: 'deny' } } })
  await vi.waitFor(() => expect(respond).toHaveBeenCalledOnce())
  const list = await f.cli(['connection', 'ingress', 'ls', '--connection', 'feishu-connection'])
  expect(list.ingresses).toHaveLength(1)
  const record = list.ingresses[0]
  expect(isObjectId(record.ingressId)).toBe(true); expect(isObjectId(record.input.operationId)).toBe(true)
  expect(record).toMatchObject({ kind: 'action', state: 'claimed', input: { hostId: 'local', agentSessionId: 'original-agent', expectedRun: { runId: 'run-original-agent' }, author: { actor: f.actor, grantRevision: 1 } } })
  const inspected = await f.cli(['connection', 'ingress', 'inspect', '--ingress', record.ingressId])
  expect(inspected.interactionReceipt).toMatchObject({ operationId: record.input.operationId, delivery: 'hook-written', nativeAdoption: 'unknown' })
  expect(inspected.inputReceipt).toBeNull()
  const authority = await f.cli(['connection', 'ingress', 'authority', '--operation-id', record.input.operationId])
  expect(authority.authority).toBe('current')
  expect(JSON.stringify(authority)).not.toMatch(/original command|toolInput|arbitrary|fixture-credential|expectedRequest|decision/)
  await vi.waitFor(() => expect(f.effects.filter(effect => effect.method === 'PATCH').length).toBeGreaterThan(0))
  expect(f.buttons()).toEqual([])
  await f.sdk.receive(f.action(button.value.actionRef))
  await f.sdk.receive(f.action(button.value.actionRef, 'same-choice-another-event'))
  await tick(); await tick()
  expect(respond).toHaveBeenCalledOnce()
  const after = await f.cli(['connection', 'ingress', 'ls', '--connection', 'feishu-connection'])
  expect(after.ingresses).toHaveLength(2)
  expect(after.ingresses.map((value: typeof record) => value.input?.operationId)).toEqual([record.input.operationId, record.input.operationId])
  expect(f.original.inner.kernel.input).not.toHaveBeenCalled(); expect(f.original.inner.kernel.stop).not.toHaveBeenCalled()
}, 25_000)

it('updates the original card after a local abstention without claiming a permission decision', async () => {
  const f = await fixture(); await f.grant(); const original = await f.open()
  await vi.waitFor(() => expect(f.buttons().length).toBeGreaterThan(0), { timeout: 8_000 })
  const result = await f.hosted.respondAgentInteraction({ agentSessionId: 'original-agent', expectedRun: { runId: 'run-original-agent' }, operationId: 'local-abstention', expectedRequest: original.request,
    response: { kind: 'permission', requestId: original.request.id, decision: { outcome: 'cancelled' } } })
  expect(result.delivery).toBe('hook-written'); await expect(original.callback).resolves.toEqual({})
  await vi.waitFor(() => { const observed = f.hosted.agentSession('original-agent').pendingInteraction?.request; expect(observed?.kind === 'permission' && observed.permissionHook?.response?.delivery).toBe('connection-written') })
  await vi.waitFor(async () => { const lane = Reflect.get(f.services.publication!, 'lanes').get(f.binding.bindingId); expect(lane).toBeDefined(); await lane!.work; expect(lane!.work).toBeUndefined() })
  expect(f.effects.some(value => value.method === 'PATCH')).toBe(true)
  const card = JSON.stringify(f.card())
  expect(card).toContain('Response returned. Native adoption and completion are not confirmed.')
  expect(card).not.toContain('Decision returned')
  expect(f.buttons()).toEqual([]); expect(f.original.inner.kernel.input).not.toHaveBeenCalled()
}, 20_000)

it('keeps permission off for chat/answer grants and never exposes original tool context before explicit consent', async () => {
  const f = await fixture(); await f.grant(['input', 'answer'])
  const original = await f.open()
  f.services.publication!.refresh()
  await vi.waitFor(async () => { const lane = Reflect.get(f.services.publication!, 'lanes').get(f.binding.bindingId); expect(lane, 'The exact original Binding lane is present').toBeDefined(); await lane!.work; expect(lane!.work, 'The original publication cycle has settled before checking absence').toBeUndefined() })
  expect(f.effects).toEqual([])
  const ack = vi.fn()
  await expect(f.services.ingress!.receive({ connectionId: 'feishu-connection', raw: JSON.stringify(f.action('forged-reference')), transportProof: { authenticated: true } }, ack)).rejects.toMatchObject({ code: 'INGRESS_AUTHENTICATION_FAILED' })
  expect(ack).not.toHaveBeenCalled()
  const local = await f.hosted.respondAgentInteraction({ agentSessionId: 'original-agent', expectedRun: { runId: 'run-original-agent' }, operationId: 'original-local-decision', expectedRequest: original.request,
    response: { kind: 'permission', requestId: original.request.id, decision: { outcome: 'selected', optionId: 'reject-once' } } })
  expect(local.delivery).toBe('hook-written'); await original.callback
  expect(f.effects).toEqual([])
}, 20_000)

it('refuses a stale named grant or source mapping while retaining the original local callback', async () => {
  const f = await fixture(); await f.grant(); const original = await f.open()
  await vi.waitFor(() => expect(f.buttons().length).toBeGreaterThan(0), { timeout: 8_000 })
  const ref = f.buttons()[0]!.value.actionRef
  const wrong = f.action(ref, 'wrong-source', { context: { open_chat_id: 'original-room', open_message_id: 'foreign-card' } })
  await f.sdk.receive(wrong)
  await vi.waitFor(async () => expect((await f.cli(['connection', 'ingress', 'ls', '--connection', 'feishu-connection'])).ingresses[0].state).toBe('refused'))
  await f.grant(['input', 'permission'], 1)
  await f.sdk.receive(f.action(ref, 'revised-grant-action'))
  await vi.waitFor(async () => expect((await f.cli(['connection', 'ingress', 'ls', '--connection', 'feishu-connection'])).ingresses[1]).toMatchObject({ state: 'refused', code: 'INGRESS_ACTOR_NOT_AUTHORIZED' }))
  await f.grant(['input'], 2)
  await f.sdk.receive(f.action(ref, 'revoked-action'))
  await vi.waitFor(async () => expect((await f.cli(['connection', 'ingress', 'ls', '--connection', 'feishu-connection'])).ingresses[2]).toMatchObject({ state: 'refused', code: 'INGRESS_ACTOR_NOT_AUTHORIZED' }))
  expect(f.original.client.agentSession('original-agent').pendingInteraction?.request.id).toBe(original.request.id)
  expect(f.original.client.agentSession('original-agent').pendingInteraction?.request).not.toHaveProperty('permissionHook.response')
  const local = await f.hosted.respondAgentInteraction({ agentSessionId: 'original-agent', expectedRun: { runId: 'run-original-agent' }, operationId: 'local-after-revoke', expectedRequest: original.request,
    response: { kind: 'permission', requestId: original.request.id, decision: { outcome: 'selected', optionId: 'reject-once' } } })
  expect(local.delivery).toBe('hook-written'); await original.callback
  expect(f.original.inner.kernel.input).not.toHaveBeenCalled()
}, 25_000)

it('canonicalizes the full typed target independently from actor authority and preserves request generations', () => {
  const request = { agentSessionId: 'original-agent', evidence: { source: 'native-hook' as const, observedAt: _historyFixtureEpoch(0, 0, 1), run: { runId: 'original-run' } }, id: 'request', kind: 'permission' as const, title: 'Original target', toolName: 'Bash', toolInput: '{"a":1}', options: [{ id: 'deny', label: 'Deny', description: 'Once', kind: 'reject-once' as const }] }
  const input = { agentSessionId: 'original-agent', expectedRun: { runId: 'original-run' }, operationId: 'original-op', expectedRequest: request, response: { kind: 'permission' as const, requestId: request.id, decision: { outcome: 'selected' as const, optionId: 'deny' } } }
  const reordered = { response: { decision: { optionId: 'deny', outcome: 'selected' as const }, requestId: request.id, kind: 'permission' as const }, operationId: input.operationId, expectedRun: input.expectedRun, agentSessionId: input.agentSessionId, expectedRequest: Object.fromEntries(Object.entries(request).reverse()) as typeof request }
  expect(agentInteractionIntentDigest(reordered)).toBe(agentInteractionIntentDigest(input))
  for (const changed of [{ ...input, agentSessionId: 'replacement' }, { ...input, expectedRun: { runId: 'replacement' } }, { ...input, operationId: 'another-operation' }, { ...input, response: { ...input.response, decision: { outcome: 'selected' as const, optionId: 'allow' } } }, { ...input, expectedRequest: { ...request, toolInput: 'replacement' } }]) expect(agentInteractionIntentDigest(changed)).not.toBe(agentInteractionIntentDigest(input))
  expect(agentInteractionRequestDigest({ ...request, toolInput: 'replacement' })).not.toBe(agentInteractionRequestDigest(request))
})

it('compares the actual frozen Hosted intent, accepts reordered fields and refuses changed target, response, actor or Run before the Hook effect', async () => {
  const f = await fixture(); await f.grant(); const original = await f.open()
  await vi.waitFor(() => expect(f.buttons().length).toBeGreaterThan(0), { timeout: 8_000 })
  const send = f.hosted.respondAgentInteraction.bind(f.hosted)
  let captured: Parameters<typeof send>[0] | undefined, release!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(f.hosted, 'respondAgentInteraction').mockImplementation(async input => { captured = structuredClone(input); await hold; return await send(input) })
  const button = f.buttons().find(value => /deny|reject/i.test(value.text.content))!
  await f.sdk.receive(f.action(button.value.actionRef))
  await vi.waitFor(() => expect(captured).toBeDefined())
  const input = captured!, author = input.externalAction!
  await expect(f.rpc.call('agent.interaction.respond', input)).rejects.toMatchObject({ code: 'EXTERNAL_INTERACTION_AUTHORITY_UNCONFIRMED' })
  for (const changed of [
    { ...input, expectedRequest: { ...input.expectedRequest, title: 'Different original request' } },
    { ...input, response: { ...input.response, decision: { outcome: 'selected', optionId: 'allow-once' } } },
    { ...input, externalAction: { ...author, actor: { ...author.actor, userId: 'another-person' } } },
    { ...input, expectedRun: { runId: 'replacement-run' } },
    { ...input, externalAction: { ...author, sourceMessageId: 'another-card' } }
  ]) await expect(send(changed as typeof input)).rejects.toMatchObject({ code: 'EXTERNAL_INTERACTION_AUTHORITY_UNCONFIRMED' })
  expect(f.original.client.agentSession('original-agent').pendingInteraction?.request).not.toHaveProperty('permissionHook.response')
  const reordered = { response: input.response, expectedRequest: Object.fromEntries(Object.entries(input.expectedRequest).reverse()), externalAction: { ...author, actor: { userId: author.actor.userId, idType: author.actor.idType, application: { appId: author.actor.application.appId, domain: author.actor.application.domain } } }, operationId: input.operationId, expectedRun: input.expectedRun, agentSessionId: input.agentSessionId }
  let returned: Awaited<ReturnType<typeof send>> | undefined, failure: unknown = null
  try { returned = await send(reordered as typeof input) } catch (error) { failure = error }
  expect(failure).toBeNull(); expect(returned?.delivery).toBe('hook-written'); await original.callback
  release(); await vi.waitFor(async () => expect((await f.services.ingress!.inspect({ ingressId: (await f.cli(['connection', 'ingress', 'ls', '--connection', 'feishu-connection'])).ingresses[0].ingressId })).interactionReceipt?.delivery).toBe('hook-written'))
  expect(f.original.inner.kernel.input).not.toHaveBeenCalled()
}, 25_000)

it.each(['hosted', 'hook'] as const)('a lost %s response and an unknown PATCH preserve two independent original receipts without another decision effect', async layer => {
  const f = await fixture(); await f.grant(); const original = await f.open()
  await vi.waitFor(() => expect(f.buttons().length).toBeGreaterThan(0), { timeout: 8_000 })
  const ref = f.buttons().find(value => /deny|reject/i.test(value.text.content))!.value.actionRef
  const send = f.hosted.respondAgentInteraction.bind(f.hosted), dispatch = vi.spyOn(f.hosted, 'respondAgentInteraction').mockImplementation(async input => {
    const value = await send(input)
    if (layer === 'hosted') throw new Error('Controlled lost Hosted reply')
    return value
  })
  if (layer === 'hook') {
    const hook = Reflect.get(f.original.client, 'hookServer'), write = hook.respondPermission.bind(hook)
    vi.spyOn(hook, 'respondPermission').mockImplementation(async (...args: unknown[]) => { await write(...args); throw new Error('Controlled lost Hook receipt') })
  }
  f.setFailPatch(true)
  await f.sdk.receive(f.action(ref)); await original.callback
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
  await vi.waitFor(() => expect(f.effects.some(value => value.method === 'PATCH')).toBe(true))
  const record = (await f.cli(['connection', 'ingress', 'ls', '--connection', 'feishu-connection'])).ingresses[0]
  expect((await f.cli(['connection', 'ingress', 'inspect', '--ingress', record.ingressId])).interactionReceipt.delivery).toBe(layer === 'hook' ? 'unknown' : 'hook-written')
  const before = f.effects.length
  f.disablePermissionSupport()
  for (let index = 0; index < 2; index++) { f.services.publication!.refresh(); await f.cli(['connection', 'ingress', 'inspect', '--ingress', record.ingressId]); await tick() }
  await f.sdk.receive(f.action(ref, 'late-repeat-event')); await tick()
  expect(dispatch).toHaveBeenCalledOnce()
  expect(f.effects.filter(value => value.method === 'POST')).toHaveLength(1)
  expect(f.effects.length).toBe(before)
  const delivery = await f.cli(['connection', 'delivery', 'ls', '--connection', 'feishu-connection', '--binding', f.binding.bindingId, '--binding-revision', '1'])
  expect(delivery.deliveries.some((value: { state: string }) => value.state === 'unknown')).toBe(true)
  expect(f.original.inner.kernel.stop).not.toHaveBeenCalled()
}, 25_000)

it('retains an ACKed received action across service off or unknown and resumes that exact event after service recovery', async () => {
  const f = await fixture(); await f.grant(); const original = await f.open()
  await vi.waitFor(() => expect(f.buttons().length).toBeGreaterThan(0), { timeout: 8_000 })
  const ref = f.buttons().find(value => /deny|reject/i.test(value.text.content))!.value.actionRef
  const ingress = f.services.ingress!, receive = ingress.receive.bind(ingress)
  vi.spyOn(ingress, 'receive').mockImplementation(async (input, ack) => await receive(input, async () => {
    await f.services.connections.service.configure({ operationId: 'disable-before-permission-dispatch', expectedRevision: 0, service: { enabled: false } })
    await ack()
  }))
  await f.sdk.receive(f.action(ref)); await tick(); await tick()
  const rows = await f.cli(['connection', 'ingress', 'ls', '--connection', 'feishu-connection'])
  expect(rows.ingresses).toHaveLength(1); expect(rows.ingresses[0]).toMatchObject({ state: 'received' })
  expect(rows.ingresses[0]).not.toHaveProperty('input')
  expect(f.original.client.agentSession('original-agent').pendingInteraction?.request).not.toHaveProperty('permissionHook.response')
  const receivedId = rows.ingresses[0].ingressId
  const database = f.services.database!, prepare = database.prepare.bind(database)
  let failPolicy = true
  const fault = vi.spyOn(database, 'prepare').mockImplementation(sql => {
    if (failPolicy && sql.startsWith('SELECT enabled,revision FROM connection_service_policy')) { failPolicy = false; throw new Error('Controlled storage observation failure') }
    return prepare(sql)
  })
  await expect(ingress.dispatch(receivedId)).resolves.toMatchObject({ ingress: { ingressId: receivedId, state: 'received' }, observation: 'not-started' })
  expect(failPolicy).toBe(false); fault.mockRestore()
  await f.services.connections.service.configure({ operationId: 'restore-permission-dispatch', expectedRevision: 1, service: { enabled: true } })
  await expect(original.callback).resolves.toMatchObject({ hookSpecificOutput: { decision: { behavior: 'deny' } } })
  const after = await f.cli(['connection', 'ingress', 'inspect', '--ingress', receivedId])
  expect(after.ingress).toMatchObject({ ingressId: receivedId, state: 'claimed' }); expect(after.interactionReceipt.delivery).toBe('hook-written')
  expect((await f.cli(['connection', 'ingress', 'ls', '--connection', 'feishu-connection'])).ingresses).toHaveLength(1)
  expect(f.original.inner.kernel.stop).not.toHaveBeenCalled()
}, 25_000)

it('rechecks the grant immediately before the real Hook write and never replays the saved choice after revocation', async () => {
  const f = await fixture(); await f.grant(); const original = await f.open()
  await vi.waitFor(() => expect(f.buttons().length).toBeGreaterThan(0), { timeout: 8_000 })
  const ref = f.buttons().find(value => /deny|reject/i.test(value.text.content))!.value.actionRef
  const ingress = f.services.ingress!, authority = ingress.authority.bind(ingress)
  let checks = 0
  vi.spyOn(ingress, 'authority').mockImplementation(async input => { if (++checks === 3) await f.grant(['input'], 1); return await authority(input) })
  await f.sdk.receive(f.action(ref))
  const result = await original.callback
  expect(result).not.toHaveProperty('hookSpecificOutput.decision')
  expect(checks).toBeGreaterThanOrEqual(3)
  const record = (await f.cli(['connection', 'ingress', 'ls', '--connection', 'feishu-connection'])).ingresses[0]
  const saved = await f.cli(['connection', 'ingress', 'inspect', '--ingress', record.ingressId])
  expect(saved.interactionReceipt).toMatchObject({ operationId: record.input.operationId, delivery: 'saved', nativeAdoption: 'unknown' })
  await f.grant(['permission'], 2)
  await f.sdk.receive(f.action(ref, 'late-revoked-ref')); await tick()
  expect(checks).toBeGreaterThanOrEqual(3)
  expect((await f.cli(['connection', 'ingress', 'inspect', '--ingress', record.ingressId])).interactionReceipt.operationId).toBe(record.input.operationId)
  expect(f.original.inner.kernel.input).not.toHaveBeenCalled(); expect(f.original.inner.kernel.stop).not.toHaveBeenCalled()
}, 25_000)

it('a changed Binding refuses the old card while the original local permission remains usable', async () => {
  const f = await fixture(); await f.grant(); const original = await f.open()
  await vi.waitFor(() => expect(f.buttons().length).toBeGreaterThan(0), { timeout: 8_000 })
  const ref = f.buttons()[0]!.value.actionRef
  await f.cli(['connection', 'binding', 'pause', '--input', '-'], { operationId: 'pause-original-binding', bindingId: f.binding.bindingId, expectedRevision: 1 })
  await f.sdk.receive(f.action(ref)); await tick()
  const record = (await f.cli(['connection', 'ingress', 'ls', '--connection', 'feishu-connection'])).ingresses[0]
  await vi.waitFor(async () => expect((await f.services.ingress!.inspect({ ingressId: record.ingressId })).ingress).toMatchObject({ state: 'refused' }))
  expect(record).not.toHaveProperty('input')
  const local = await f.hosted.respondAgentInteraction({ agentSessionId: 'original-agent', expectedRun: { runId: 'run-original-agent' }, operationId: 'local-after-binding-change', expectedRequest: original.request,
    response: { kind: 'permission', requestId: original.request.id, decision: { outcome: 'selected', optionId: 'reject-once' } } })
  expect(local.delivery).toBe('hook-written'); await original.callback
  expect(f.original.inner.kernel.stop).not.toHaveBeenCalled()
}, 25_000)

it('simultaneous Desktop and authenticated group decisions share the original single callback winner', async () => {
  const f = await fixture(); await f.grant(); const original = await f.open()
  await vi.waitFor(() => expect(f.buttons().length).toBeGreaterThan(0), { timeout: 8_000 })
  const hook = Reflect.get(f.original.client, 'hookServer'), effect = vi.spyOn(hook, 'respondPermission')
  const ref = f.buttons().find(value => /deny|reject/i.test(value.text.content))!.value.actionRef
  await Promise.allSettled([f.sdk.receive(f.action(ref)), f.hosted.respondAgentInteraction({ agentSessionId: 'original-agent', expectedRun: { runId: 'run-original-agent' }, operationId: 'concurrent-original-local', expectedRequest: original.request,
    response: { kind: 'permission', requestId: original.request.id, decision: { outcome: 'selected', optionId: 'allow-once' } } })])
  const result = await original.callback
  await vi.waitFor(() => expect(effect).toHaveBeenCalledOnce())
  const pending = f.original.client.agentSession('original-agent').pendingInteraction!.request
  expect(pending.kind).toBe('permission')
  if (pending.kind !== 'permission') throw new Error('Original permission target changed')
  const decision = pending.permissionHook!.response!.value.decision
  expect(decision.outcome).toBe('selected')
  if (decision.outcome !== 'selected') throw new Error('Original decision missing')
  expect(result).toMatchObject({ hookSpecificOutput: { decision: { behavior: decision.optionId === 'allow-once' ? 'allow' : 'deny' } } })
  expect(f.original.inner.kernel.input).not.toHaveBeenCalled()
}, 25_000)

it.each(['actor', 'source'] as const)('only the authenticated original %s can use the saved action reference', async field => {
  const f = await fixture(); await f.grant(); const original = await f.open()
  await vi.waitFor(() => expect(f.buttons().length).toBeGreaterThan(0), { timeout: 8_000 })
  const ref = f.buttons().find(value => /deny|reject/i.test(value.text.content))!.value.actionRef
  await f.sdk.receive(f.action(ref, 'foreign-' + field, field === 'actor' ? { operator: { open_id: 'not-the-granted-person' } } : { context: { open_chat_id: 'original-room', open_message_id: 'not-the-original-card' } }))
  await vi.waitFor(async () => expect((await f.cli(['connection', 'ingress', 'ls', '--connection', 'feishu-connection'])).ingresses[0]).toMatchObject({ state: 'refused' }))
  expect(f.original.client.agentSession('original-agent').pendingInteraction?.request).not.toHaveProperty('permissionHook.response')
  await f.original.client.writeAgent({ agentSessionId: 'original-agent', expectedRun: { runId: 'run-original-agent' }, source: 'user', data: 'Original local input remains usable' })
  expect(f.original.inner.kernel.input).toHaveBeenCalledOnce(); expect(f.original.inner.kernel.stop).not.toHaveBeenCalled()
  expect(original.request.id).toBe('original-request')
}, 20_000)

it('does not misclassify a failed local reference read as unsupported or ACK an uncommitted event', async () => {
  const f = await fixture(); await f.grant(); const original = await f.open()
  await vi.waitFor(() => expect(f.buttons().length).toBeGreaterThan(0), { timeout: 8_000 })
  const ref = f.buttons().find(value => /deny|reject/i.test(value.text.content))!.value.actionRef, payload = f.action(ref)
  const database = f.services.database!, prepare = database.prepare.bind(database)
  const fault = vi.spyOn(database, 'prepare').mockImplementation(sql => { if (sql.startsWith('SELECT reference_json FROM connection_ingress_action_reference WHERE action_ref=')) throw new Error('Controlled reference storage failure'); return prepare(sql) })
  await f.sdk.receive(payload)
  expect(f.sdk.ack().at(-1).code).toBe(500)
  expect(database.prepare('SELECT count(*) AS count FROM connection_ingress_event').get()!.count).toBe(0)
  expect(f.original.client.agentSession('original-agent').pendingInteraction?.request).not.toHaveProperty('permissionHook.response')
  fault.mockRestore()
  await f.sdk.receive(payload)
  await expect(original.callback).resolves.toMatchObject({ hookSpecificOutput: { decision: { behavior: 'deny' } } })
  expect(f.sdk.ack().at(-1).code).toBe(200)
  expect((await f.cli(['connection', 'ingress', 'ls', '--connection', 'feishu-connection'])).ingresses).toHaveLength(1)
}, 20_000)

it('the public SDK refuses a contradictory safe claim projection without changing the original durable actor', async () => {
  const f = await fixture(); await f.grant(); const original = await f.open()
  await vi.waitFor(() => expect(f.buttons().length).toBeGreaterThan(0), { timeout: 8_000 })
  const ref = f.buttons().find(value => /deny|reject/i.test(value.text.content))!.value.actionRef
  await f.sdk.receive(f.action(ref)); await original.callback
  const first = (await f.cli(['connection', 'ingress', 'ls', '--connection', 'feishu-connection'])).ingresses[0]
  await vi.waitFor(async () => expect((await f.services.ingress!.inspect({ ingressId: first.ingressId })).interactionReceipt?.delivery).toBe('hook-written'))
  const port = f.services.connections.ingress!, list = port.list.bind(port)
  const altered = vi.spyOn(port, 'list').mockImplementation(async input => {
    const value = structuredClone(await list(input)), claimed = value.ingresses[0]!
    if (claimed.kind !== 'action' || !claimed.input) throw new Error('Original claimed action absent')
    claimed.input.author.actor.userId = 'contradictory-projected-person'
    return value
  })
  let failure: unknown = null
  try { await f.rpc.call('connection.ingress.ls', { connectionId: 'feishu-connection' }) } catch (error) { failure = error }
  expect(failure).toMatchObject({ code: 'INVALID_CONNECTION_INGRESS' })
  altered.mockRestore()
  expect((await f.cli(['connection', 'ingress', 'inspect', '--ingress', first.ingressId])).ingress.input.author.actor).toEqual(f.actor)
}, 20_000)

it('an adapter without an explicit permission declaration retains original local and speech capabilities', async () => {
  const f = await fixture(); f.disablePermissionSupport(); await f.grant(); const original = await f.open()
  f.services.publication!.refresh()
  await vi.waitFor(async () => { const lane = Reflect.get(f.services.publication!, 'lanes').get(f.binding.bindingId); expect(lane, 'The exact original Binding lane is present').toBeDefined(); await lane!.work; expect(lane!.work, 'The original publication cycle has settled before checking absence').toBeUndefined() })
  expect(f.effects).toEqual([])
  expect((await f.cli(['connection', 'delivery', 'ls', '--connection', 'feishu-connection', '--binding', f.binding.bindingId, '--binding-revision', '1'])).deliveries).toEqual([])
  const result = await f.hosted.respondAgentInteraction({ agentSessionId: 'original-agent', expectedRun: { runId: 'run-original-agent' }, operationId: 'local-on-unsupported-adapter', expectedRequest: original.request,
    response: { kind: 'permission', requestId: original.request.id, decision: { outcome: 'selected', optionId: 'reject-once' } } })
  expect(result.delivery).toBe('hook-written'); await original.callback
  await appendFile(join(f.original.root, 'native.jsonl'), JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Original ordinary reply' }] } }) + '\n')
  await vi.waitFor(() => expect(f.effects.some(value => value.body.msg_type === 'post')).toBe(true), { timeout: 6_000 })
  const deliveries = await f.cli(['connection', 'delivery', 'ls', '--connection', 'feishu-connection', '--binding', f.binding.bindingId, '--binding-revision', '1'])
  expect(deliveries.deliveries).toHaveLength(1); expect(deliveries.deliveries[0].state).toBe('confirmed')
  expect(f.original.inner.kernel.stop).not.toHaveBeenCalled()
}, 20_000)

it('keeps the original action received while its exact Core consumer is unavailable, then claims once after recovery', async () => {
  const f = await fixture(); await f.grant(); const original = await f.open()
  await vi.waitFor(() => expect(f.buttons().length).toBeGreaterThan(0), { timeout: 8_000 })
  const ref = f.buttons().find(value => /deny|reject/i.test(value.text.content))!.value.actionRef
  f.setCoreAvailable(false); await f.sdk.receive(f.action(ref)); await tick(); await tick()
  const before = (await f.cli(['connection', 'ingress', 'ls', '--connection', 'feishu-connection'])).ingresses
  expect(before).toHaveLength(1); expect(before[0]).toMatchObject({ state: 'received' }); expect(before[0]).not.toHaveProperty('input')
  expect(f.original.client.agentSession('original-agent').pendingInteraction?.request).not.toHaveProperty('permissionHook.response')
  f.setCoreAvailable(true); await f.grant()
  await expect(original.callback).resolves.toMatchObject({ hookSpecificOutput: { decision: { behavior: 'deny' } } })
  const inspected = await f.cli(['connection', 'ingress', 'inspect', '--ingress', before[0].ingressId])
  expect(inspected.ingress).toMatchObject({ state: 'claimed', ingressId: before[0].ingressId }); expect(inspected.interactionReceipt.delivery).toBe('hook-written')
  expect(f.original.inner.kernel.stop).not.toHaveBeenCalled()
}, 20_000)

it('recovers a missing original permission observation without restarting the Agent or requiring a new grant', async () => {
  const f = await fixture(false); await f.grant(); const original = await f.open()
  await vi.waitFor(() => expect(f.services.publication!.observation(f.binding.bindingId, 1)).toMatchObject({ state: 'unavailable', reason: 'source-unconfirmed' }))
  expect(f.effects).toEqual([])
  f.setCoreAvailable(true)
  await vi.waitFor(() => expect(f.buttons().length).toBeGreaterThan(0), { timeout: 8_000 })
  expect(JSON.stringify(f.card())).toContain('original command')
  const local = await f.hosted.respondAgentInteraction({ agentSessionId: 'original-agent', expectedRun: { runId: 'run-original-agent' }, operationId: 'local-after-observation-recovery', expectedRequest: original.request,
    response: { kind: 'permission', requestId: original.request.id, decision: { outcome: 'selected', optionId: 'reject-once' } } })
  expect(local.delivery).toBe('hook-written'); await original.callback
  await vi.waitFor(() => expect(f.effects.some(value => value.method === 'PATCH')).toBe(true))
  expect(f.original.inner.kernel.stop).not.toHaveBeenCalled()
}, 20_000)

it('resolves original action and operation claims through actual SQLite indexes instead of unrelated ingress history', async () => {
  const f = await fixture()
  const database = f.services.database!, prepare = database.prepare.bind(database), queries = new Set<string>(), projectionQueries = new Map<string, any[]>()
  vi.spyOn(database, 'prepare').mockImplementation(sql => {
    queries.add(sql); const statement = prepare(sql), get = statement.get.bind(statement)
    if (sql.startsWith('SELECT') && sql.includes('FROM connection_ingress_action_reference') && sql.includes('projection_id=?')) vi.spyOn(statement, 'get').mockImplementation((...args) => { projectionQueries.set(sql, args); return get(...args) })
    return statement
  })
  await f.grant(); const original = await f.open()
  await vi.waitFor(() => expect(f.buttons().length).toBeGreaterThan(0), { timeout: 8_000 })
  const ref = f.buttons().find(value => /deny|reject/i.test(value.text.content))!.value.actionRef
  await f.sdk.receive(f.action(ref)); await original.callback
  const claimed = (await f.cli(['connection', 'ingress', 'ls', '--connection', 'feishu-connection'])).ingresses[0]
  const authority = [...queries].find(sql => sql.startsWith('SELECT ingress_id FROM (') && sql.includes("'$.input.operationId')=?"))!
  const duplicate = [...queries].find(sql => sql.startsWith('SELECT record_json FROM connection_ingress_event WHERE json_extract'))!
  expect(authority).toBeDefined(); expect(duplicate).toBeDefined()
  const authorityPlan = database.prepare('EXPLAIN QUERY PLAN ' + authority).all(claimed.input.operationId).map(row => String(row.detail))
  const duplicatePlan = database.prepare('EXPLAIN QUERY PLAN ' + duplicate).all(ref, JSON.stringify(f.actor), 1).map(row => String(row.detail))
  expect(authorityPlan.some(detail => detail.includes('connection_ingress_action_operation'))).toBe(true)
  expect(duplicatePlan.some(detail => detail.includes('connection_ingress_action_original'))).toBe(true)
  expect(projectionQueries.size, 'Both original projection and authorization queries actually execute').toBe(2)
  const projectionPlans = [...projectionQueries].map(([sql, args]) => ({ sql, args, plan: prepare('EXPLAIN QUERY PLAN ' + sql).all(...args).map(row => String(row.detail)) }))
  await writeFile('.bagakit/feature-tracker/features/f-2wr8fmvnv/artifacts/permission-actions/projection-query-plans.json', JSON.stringify({ projectionPlans }, null, 2) + '\n')
  for (const query of projectionPlans) expect(query.plan.some(detail => detail.startsWith('SEARCH ') && detail.includes('connection_ingress_action_audience') && detail.includes('binding_id=? AND binding_revision=? AND projection_id=?')), 'Projection reads must search only the exact Binding revision').toBe(true)
}, 20_000)
