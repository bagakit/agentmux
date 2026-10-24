// @vitest-environment happy-dom
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxFileAgentSessionStore } from '../../core/dist/index.js'
import type { AgentProviderPreparedNativeInput } from '../../core/src/agent-provider.js'
import { codexQuestionAnswers } from '../../core/src/providers/codex-question.js'
import { savedQuestionEvent, savedQuestionJsonl, savedQuestionId } from '../../core/test/helpers/codex-saved-question.js'
import { permissionActionsFixture } from './fixtures/permission-actions.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
async function fixture(outcome: 'admitted' | 'unknown' = 'admitted') {
  const mutant = process.env.AGENTMUX_TEST_QUESTION_ACTION_MUTANT
  const f = await permissionActionsFixture(); cleanup.push(f.close)
  if (mutant) {
    const actions = f.services.ingress!.permissions
    expect(actions.constructor.name).toBe('ConversationActions')
    if (mutant === 'permission-grant-answers') {
      const grants = Reflect.get(actions, 'grants').bind(actions)
      vi.spyOn(actions as any, 'grants').mockImplementation((binding, capability) => grants(binding, capability === 'answer' ? 'permission' : capability))
    } else if (mutant === 'changed-original-option') {
      const answers = Reflect.get(actions, 'questionAnswers').bind(actions)
      vi.spyOn(actions as any, 'questionAnswers').mockImplementation((ref, record) => answers(ref, record).map((answer: { questionId: string; answer: string }, index: number) => index ? answer : { ...answer, answer: 'Changed selected option' }))
    } else throw Error('Unknown question action mutant')
    process.stderr.write(`[loaded-question-mutant:${mutant}:ConversationActions]\n`)
  }
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(f.services.publication!.store.list(f.binding).some(value => value.payload.kind === 'binding-lifecycle' && value.state === 'confirmed')).toBe(true))
  f.effects.splice(0)
  const original = (await f.original.store.readMetadata('original-agent'))!
  const actor = { protocolId: 'codex-app-server-v2-0.163', actorId: 'original-question-actor', lifecycleOperationId: 'original-question-lifecycle', token: 'a'.repeat(64), launch: { command: 'codex', args: [] } }
  await f.original.store.compareAndSwap(original, { ...original, nativeActor: actor }); await f.original.inner.registry.load('local')
  const send = vi.fn<AgentProviderPreparedNativeInput['send']>(async (_text, plan) => {
    const admission = await new AgentMuxFileAgentSessionStore(f.original.store.path).readPromptAdmission('original-agent', original.run, plan.clientCorrelation ? JSON.parse(Buffer.from(plan.clientCorrelation.split('.')[1]!, 'base64url').toString()).key.submissionId : '')
    expect(admission, 'The original answer is durable before native dispatch').toBeDefined()
    if (outcome === 'unknown') throw Error('Controlled native reply loss')
    return { outcome: 'admitted', turnId: 'answer-native-turn' }
  })
  f.original.client.providers.get('codex').prepareNativeInput = async (_context, source) => ({
    plan: { kind: 'native-rpc', protocolId: actor.protocolId, sourceId: JSON.stringify([source.providerId, source.nativeSessionId]), actorId: actor.actorId, threadId: source.nativeSessionId, operation: 'start-or-steer' },
    assertCurrent: async () => {}, send, dispose() {}
  })
  const event = savedQuestionEvent(); event.payload.thread_id = 'original-native'
  event.payload.item.questions.push({ title: 'What should happen after the original work?', options: ['Proceed', 'Wait'] })
  const questionId2 = JSON.stringify(['request_user_input_async', event.payload.item.id, 1])
  const publish = async () => {
    await appendFile(join(f.original.root, 'native.jsonl'), savedQuestionJsonl([event])); f.services.publication!.refresh()
    await vi.waitFor(() => { expect(f.card()?.schema).toBe('2.0'); expect(f.services.publication!.store.list(f.binding).some(value => value.payload.kind === 'question' && value.state === 'confirmed')).toBe(true) }, { timeout: 8_000 })
  }
  const submit = () => ((f.card()?.body as { elements: Array<{ tag: string; elements?: unknown[] }> }).elements.find(value => value.tag === 'form')!.elements!.at(-1) as { value: Record<string, unknown> })
  const answer = (eventId = 'original-answer-action', fields: Record<string, unknown> = { question_0_option: '0', question_1_text: 'Continue with the original plan' }) => {
    const value = submit().value
    const mapping = f.services.publication!.store.list(f.binding).filter(value => value.payload.kind === 'question' && value.state === 'confirmed').at(-1)!.mapping!
    return f.action(String(value.actionRef), eventId, { context: { open_chat_id: 'original-room', open_message_id: mapping.messageId }, action: { tag: 'button', value, form_value: fields } })
  }
  return { ...f, send, publish, submit, answer, questionId2 }
}

it('default Desktop and authenticated Feishu form answer exact original questions through Hosted Core once', async () => {
  const f = await fixture(); await f.grant(['answer']); await f.publish()
  expect(f.effects.filter(value => value.method === 'POST')).toHaveLength(1)
  const wire = f.answer(), actionRef = f.submit().value.actionRef
  const formRead = { connectionId: 'feishu-connection', application: f.actor.application, actor: f.actor,
    externalConversationId: wire.event.context.open_chat_id, sourceMessageId: wire.event.context.open_message_id, actionRef: String(actionRef) }
  expect(f.services.ingress!.questionForm(formRead)).toMatchObject({ status: 'pending', questions: [{ id: savedQuestionId }, { id: f.questionId2 }] })
  expect(f.services.ingress!.questionForm({ ...formRead, actor: { ...f.actor, userId: 'foreign-person' } })).toBeNull()
  await f.sdk.receive(wire)
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce(), { timeout: 8_000 })
  expect(codexQuestionAnswers([{ type: 'text', text: f.send.mock.calls[0]![0] }])).toEqual([
    { questionId: savedQuestionId, prompt: 'Choose how to continue the original work.', answer: 'Keep the original work' },
    { questionId: f.questionId2, prompt: 'What should happen after the original work?', answer: 'Continue with the original plan' }
  ])
  const list = await f.cli(['connection', 'ingress', 'ls', '--connection', 'feishu-connection']), record = list.ingresses[0]
  expect(record).toMatchObject({ kind: 'action', state: 'claimed', input: { responseKind: 'question', author: { actionRef, actor: f.actor, grantRevision: 1 } } })
  const receipt = await f.cli(['connection', 'ingress', 'inspect', '--ingress', record.ingressId])
  expect(receipt.inputReceipt).toBeNull()
  expect(receipt.questionReceipt).toMatchObject({ operationId: record.input.operationId, outcome: 'submitted', questionIds: [savedQuestionId, f.questionId2] })
  const original = await f.original.client.inspectAgentPromptSubmission({ kind: 'prompt', agentSessionId: 'original-agent', expectedRun: record.input.expectedRun, submissionId: record.input.operationId })
  expect(original?.admission?.intent?.message?.questionReply?.externalAction).toEqual(record.input.author)
  expect(original?.admission?.intent?.message?.authorHuman).toBeUndefined()
  expect(f.services.ingress!.questionForm(formRead)).toBeNull()
  await f.sdk.receive(wire); await f.sdk.receive({ ...wire, header: { ...wire.header, event_id: 'duplicate-answer-event' } })
  await vi.waitFor(async () => expect((await f.services.ingress!.list({ connectionId: 'feishu-connection' })).ingresses).toHaveLength(2))
  expect(f.send).toHaveBeenCalledOnce(); expect(f.original.inner.kernel.input).not.toHaveBeenCalled()
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(JSON.stringify(f.card())).toContain('Answer submitted to the original Agent'), { timeout: 8_000 })
  expect(JSON.stringify(f.card())).toContain('Answer 1: Keep the original work')
  expect(JSON.stringify(f.card())).toContain('Answer 2: Continue with the original plan')
  expect(JSON.stringify(f.card())).not.toContain('submit_original_answer')
  expect(f.original.client.agentSession('original-agent').run).toEqual({ runId: 'run-original-agent' })
}, 25_000)

it('permission grants do not authorize answers, and revocation refuses the exact callback while local input stays available', async () => {
  const f = await fixture(); await f.grant(['permission']); await f.publish()
  expect(JSON.stringify(f.card())).toContain('Open the original conversation to continue')
  expect(JSON.stringify(f.card())).not.toContain('submit_original_answer')
  await f.grant(['answer'], 1)
  // A new exact observation of the same source creates the explicitly authorized answer form.
  f.services.publication!.refresh()
  await appendFile(join(f.original.root, 'native.jsonl'), savedQuestionJsonl([{ ...savedQuestionEvent(), payload: { ...savedQuestionEvent().payload, thread_id: 'original-native', turn_id: 'next-question-turn' } }]))
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(JSON.stringify(f.card())).toContain('submit_original_answer'), { timeout: 8_000 })
  const wire = f.answer('revoked-answer', { question_0_text: 'A different response', question_1_text: 'Original second answer' })
  await f.grant([], 2); await f.sdk.receive(wire)
  await vi.waitFor(async () => expect((await f.services.ingress!.list({ connectionId: 'feishu-connection' })).ingresses[0]).toMatchObject({ state: 'refused', code: 'INGRESS_ACTOR_NOT_AUTHORIZED' }))
  expect(f.send).not.toHaveBeenCalled()
  await f.original.client.writeAgent({ agentSessionId: 'original-agent', expectedRun: { runId: 'run-original-agent' }, source: 'user', data: 'Local input remains usable' })
  expect(f.original.inner.kernel.input).toHaveBeenCalledOnce()
}, 25_000)

it('unknown native answer delivery preserves the original action and refuses a changed repeat without replay', async () => {
  const f = await fixture('unknown'); await f.grant(['answer']); await f.publish()
  const wire = f.answer(); await f.sdk.receive(wire)
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce(), { timeout: 8_000 })
  const first = (await f.services.ingress!.list({ connectionId: 'feishu-connection' })).ingresses[0]!
  const inspection = vi.spyOn(f.hosted, 'inspectAgentPromptSubmission').mockRejectedValue(Error('Original receipt observation unavailable'))
  expect(await f.cli(['connection', 'ingress', 'inspect', '--ingress', first.ingressId])).toMatchObject({ observation: 'unavailable', questionReceipt: null, inputReceipt: null })
  inspection.mockRestore()
  await f.sdk.receive({ ...wire, header: { ...wire.header, event_id: 'changed-repeat' }, event: { ...wire.event, action: { ...wire.event.action, form_value: { question_0_text: 'Changed answer', question_1_text: 'Changed next step' } } } })
  await vi.waitFor(async () => expect((await f.services.ingress!.list({ connectionId: 'feishu-connection' })).ingresses[1]).toMatchObject({ state: 'refused', code: 'INGRESS_AUTHORITY_REVISED' }))
  await f.services.ingress!.dispatch(first.ingressId); await f.services.ingress!.rejoin(first.ingressId)
  expect(f.send).toHaveBeenCalledOnce(); expect(f.original.inner.kernel.input).not.toHaveBeenCalled()
}, 25_000)

it('original live Hook question preserves the same unavailable route as local Conversation and opens its exact Agent', async () => {
  const f = await fixture(); await f.grant(['answer'])
  const opened = await f.open('original-live-question', 'Choose how the original work continues', 'question')
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(JSON.stringify(f.card())).toContain('no addressable reply channel'), { timeout: 8_000 })
  expect(JSON.stringify(f.card())).toContain('Choose how the original work continues')
  expect(JSON.stringify(f.card())).toContain('amux://agent/original-agent')
  expect(JSON.stringify(f.card())).not.toContain('submit_original_answer')
  if (opened.request.kind !== 'question') throw Error('Original Hook did not expose its native question')
  await expect(f.hosted.respondAgentInteraction({ agentSessionId: 'original-agent', expectedRun: { runId: 'run-original-agent' },
    operationId: 'original-live-answer', expectedRequest: opened.request, response: { kind: 'question', requestId: opened.request.id,
      outcome: 'answered', answers: [{ questionId: opened.request.questions[0]!.id, optionId: opened.request.questions[0]!.options[0]!.id }] } }))
    .rejects.toHaveProperty('code', 'AGENT_INTERACTION_UNCONFIRMED')
  expect(f.send).not.toHaveBeenCalled(); expect(f.original.inner.kernel.input).not.toHaveBeenCalled()
  await f.original.client.writeAgent({ agentSessionId: 'original-agent', expectedRun: { runId: 'run-original-agent' }, source: 'user', data: 'Original terminal answer' })
  expect(f.original.inner.kernel.input).toHaveBeenCalledOnce()
}, 25_000)

it('application access answers original questions through the same native owner without materializing room grants', async () => {
  const f = await fixture()
  expect((await f.cli(['connection', 'application', 'access', 'configure', '--input', '-'], { operationId: 'application-answer', connectionId: 'feishu-connection', expectedConnectionRevision: 1, grantId: 'application-answerer', expectedRevision: null, actor: f.actor, state: 'active', capabilities: ['answer'] })).state).toBe('applied')
  expect((await f.cli(['connection', 'binding', 'inspect', '--binding', f.binding.bindingId])).grants).toEqual([])
  await f.publish()
  const originalProjections = f.services.publication!.store.list(f.binding).filter(value => value.payload.kind === 'question').map(value => ({ projectionId: value.projectionId, payload: value.payload }))
  const owner = Reflect.get(f.services.bindings!, 'options').connections
  const unavailable = vi.spyOn(owner.applicationAccess, 'grants').mockImplementation(() => { throw Error('Controlled application access outage') })
  f.services.publication!.refreshAccess('feishu', f.actor.application)
  await vi.waitFor(async () => expect((await f.services.connections.delivery!.list({ connectionId: 'feishu-connection', bindingId: f.binding.bindingId, bindingRevision: 1 })).observation?.reason).toBe('access-unconfirmed'))
  const observed = f.services.publication!.store.list(f.binding).filter(value => value.payload.kind === 'question').map(value => ({ projectionId: value.projectionId, payload: value.payload }))
  expect(observed, JSON.stringify({ originalProjections, observed })).toEqual(originalProjections)
  unavailable.mockRestore()
  const wire = f.answer(), actionRef = f.submit().value.actionRef
  await f.sdk.receive(wire)
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce(), { timeout: 8_000 })
  const record = (await f.cli(['connection', 'ingress', 'ls', '--connection', 'feishu-connection'])).ingresses[0]
  expect(record.input.author).toMatchObject({ actionRef, actor: f.actor, grantSource: 'application', grantId: 'application-answerer', grantRevision: 1 })
  expect((await f.cli(['connection', 'ingress', 'inspect', '--ingress', record.ingressId])).questionReceipt).toMatchObject({ operationId: record.input.operationId, outcome: 'submitted', questionIds: [savedQuestionId, f.questionId2] })
  await f.sdk.receive(wire)
  expect(f.send).toHaveBeenCalledOnce()
  expect(f.original.inner.kernel.input).not.toHaveBeenCalled()
}, 25_000)
