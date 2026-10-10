// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { appendFile } from 'node:fs/promises'
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

it('keeps permission off for chat/answer grants and never exposes original tool context before explicit consent', async () => {
  const f = await fixture(); await f.grant(['input', 'answer'])
  const original = await f.open()
  f.services.publication!.refresh(); await tick(); await tick()
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

