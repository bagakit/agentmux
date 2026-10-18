import { afterEach, expect, it, vi } from 'vitest'
import * as compiled from '../dist/index.js'
import { agentQuestionReplyIntentDigest } from '../src/external-author.js'
import { questionReplyOwner } from './helpers/question-reply-owner.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const author = { kind: 'external-action' as const, connectionId: 'original-connection', actor: { application: { domain: 'example.test', appId: 'original-app' }, idType: 'native_user', userId: 'original-person' }, externalConversationId: 'original-room', sourceMessageId: 'original-card', actionRef: 'original-action', bindingId: 'original-binding', bindingRevision: 1, grantId: 'original-answer-grant', grantRevision: 1 }

it.each(['source', 'compiled'] as const)('%s Core retains the exact external answer author and rechecks its Host owner before native dispatch', async owner => {
  const f = await questionReplyOwner({ ...(owner === 'compiled' ? { ownerModule: compiled as unknown as NonNullable<Parameters<typeof questionReplyOwner>[0]>['ownerModule'] } : {}) }); cleanup.push(f.close)
  f.input.externalAction = author
  const expected = agentQuestionReplyIntentDigest(f.input), assertCurrent = vi.fn(async intent => { expect(agentQuestionReplyIntentDigest(intent)).toBe(expected) })
  const context = { externalQuestion: { identity: author, assertCurrent } }
  await expect(f.client.replySessionQuestion(f.input)).rejects.toHaveProperty('code', 'EXTERNAL_INTERACTION_AUTHORITY_UNCONFIRMED')
  expect((await f.client.replySessionQuestion(f.input, context)).outcome).toBe('submitted')
  expect(assertCurrent.mock.calls.length).toBeGreaterThan(1)
  const original = await f.client.inspectAgentPromptSubmission(f.key)
  expect(original?.admission?.intent?.message?.questionReply?.externalAction).toEqual(author)
  expect(original?.admission?.intent?.message?.authorHuman).toBeUndefined()
  expect(f.send).toHaveBeenCalledOnce()
  await expect(f.client.replySessionQuestion({ ...f.input, authorHuman: true }, context)).rejects.toHaveProperty('code', 'EXTERNAL_INTERACTION_AUTHORITY_UNCONFIRMED')
  await f.client.replySessionQuestion(f.input, context)
  expect(f.send).toHaveBeenCalledOnce(); expect(f.inner.kernel.input).not.toHaveBeenCalled()
})

it('revoked answer authority during native preparation prevents only this original reply and retains ordinary input', async () => {
  const f = await questionReplyOwner(); cleanup.push(f.close); f.input.externalAction = author
  let current = true
  const assertCurrent = async () => { if (!current) throw new compiled.AgentMuxError('Original answer grant was revoked.', 'EXTERNAL_INTERACTION_AUTHORITY_UNCONFIRMED') }
  const provider = f.client.providers.get('codex'), prepare = provider.prepareNativeInput!
  provider.prepareNativeInput = async (...args) => { const prepared = await prepare(...args); current = false; return prepared }
  await expect(f.client.replySessionQuestion(f.input, { externalQuestion: { identity: author, assertCurrent } })).rejects.toBeDefined()
  expect(f.send).not.toHaveBeenCalled(); expect(await f.client.inspectAgentPromptSubmission(f.key)).toBeNull()
  await f.client.writeAgent({ agentSessionId: f.input.agentSessionId, expectedRun: f.input.expectedRun, source: 'user', data: 'Ordinary local input' })
  expect(f.inner.kernel.input).toHaveBeenCalledOnce(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})
