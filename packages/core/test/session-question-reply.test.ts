import { readFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as compiled from '../dist/index.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { parseHostedBootstrap } from '../src/hosted-value.js'
import { parseRpcNativeResult } from '../src/rpc-native-codec.js'
import { questionReplyOwner } from './helpers/question-reply-owner.js'
import { savedQuestionPrompt, savedQuestionId, savedQuestionEvent, savedQuestionJsonl } from './helpers/codex-saved-question.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import { hostedTestOwner } from './helpers/hosted-runtime-port.js'
import { NativeJsonlHistoryReader } from '../src/native-jsonl-history-reader.js'
import { confirmNativeInputAdoption } from '../src/native-input-adoption.js'
import type { AgentSessionHistoryItem } from '../src/types.js'
import { codexQuestionAnswers } from '../src/providers/codex-question.js'

const close: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of close.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
async function fixture(options: Parameters<typeof questionReplyOwner>[0] = {}) { const f = await questionReplyOwner(options); close.push(f.close); return f }

it.each(['source', 'compiled'] as const)('%s Core sends original question protocol through one durable native claim without terminal input', async owner => {
  const f = await fixture({ ...(owner === 'compiled' ? { ownerModule: compiled as unknown as NonNullable<Parameters<typeof questionReplyOwner>[0]>['ownerModule'] } : {}) })
  const receipt = await f.client.replySessionQuestion(f.input)
  expect(receipt).toEqual({ agentSessionId: f.input.agentSessionId, source: f.input.source, recordId: f.input.recordId,
    questionIds: [savedQuestionId], operationId: f.input.operationId, outcome: 'submitted' })
  expect(f.send).toHaveBeenCalledTimes(1)
  expect(codexQuestionAnswers([{ type: 'text', text: f.send.mock.calls[0]![0] }])).toEqual([
    { questionId: savedQuestionId, prompt: savedQuestionPrompt, answer: 'Keep the original work' } ])
  expect(f.send.mock.calls[0]![1]).toMatchObject({ actorId: f.actor.actorId, threadId: f.input.source.nativeSessionId, clientCorrelation: expect.stringMatching(/^amux-input-v1\./u) })
  expect(await f.client.replySessionQuestion(f.input)).toEqual(receipt)
  expect(f.send).toHaveBeenCalledTimes(1)
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  expect((await f.client.inspectAgentPromptSubmission(f.key))?.admission).toMatchObject({ transport: 'native', native: { outcome: 'admitted' }, acknowledged: true })
})

it.each(['run', 'source', 'provider', 'turn', 'record', 'question', 'duplicate', 'answer'] as const)('rejects wrong %s only for this exact reply and keeps ordinary input', async mode => {
  const f = await fixture()
  const input = { ...f.input, ...(mode === 'run' ? { expectedRun: { runId: 'other-run' } }
    : mode === 'source' ? { source: { ...f.input.source, nativeSessionId: 'other-native' } }
    : mode === 'provider' ? { source: { ...f.input.source, providerId: 'other-provider' } }
    : mode === 'turn' ? { turnId: 'other-turn' } : mode === 'record' ? { recordId: 'other-record' }
    : mode === 'question' ? { answers: [{ questionId: 'other-question', answer: 'Keep' }] }
    : mode === 'duplicate' ? { answers: [...f.input.answers, ...f.input.answers] }
    : { answers: [{ questionId: savedQuestionId, answer: '' }] }) }
  await expect(f.client.replySessionQuestion(input)).rejects.toBeDefined()
  expect(f.send).not.toHaveBeenCalled(); expect(await f.client.inspectAgentPromptSubmission(f.key)).toBeNull()
  await f.client.writeAgent({ agentSessionId: input.agentSessionId, expectedRun: f.input.expectedRun, source: 'user', data: 'ordinary input' })
  expect(f.inner.kernel.input).toHaveBeenCalledTimes(1); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it.each(['unknown', 'not-applied'] as const)('preserves original %s claim, condition and body without redispatch', async outcome => {
  const f = await fixture({ outcome })
  await expect(f.client.replySessionQuestion(f.input)).rejects.toHaveProperty('code', outcome === 'unknown' ? 'AGENT_PROMPT_INPUT_UNCONFIRMED' : 'AGENT_PROMPT_INPUT_NOT_APPLIED')
  const before = await f.client.inspectAgentPromptSubmission(f.key)
  await expect(f.client.replySessionQuestion(f.input)).rejects.toBeDefined()
  await expect(f.client.replySessionQuestion({ ...f.input, afterSubmissionId: 'changed-condition' })).rejects.toHaveProperty('code', 'AGENT_PROMPT_OPERATION_CONFLICT')
  await expect(f.client.replySessionQuestion({ ...f.input, answers: [{ questionId: savedQuestionId, answer: 'Changed answer' }] })).rejects.toHaveProperty('code', 'AGENT_PROMPT_OPERATION_CONFLICT')
  expect(await f.client.inspectAgentPromptSubmission(f.key)).toEqual(before)
  expect(f.send).toHaveBeenCalledTimes(1); expect(f.inner.kernel.input).not.toHaveBeenCalled()
})

it('refuses an unavailable original actor without replacing a healthy Run or falling back to PTY', async () => {
  const f = await fixture(), original = (await f.store.readMetadata(f.input.agentSessionId))!
  const { nativeActor: _actor, ...withoutActor } = original
  await f.store.compareAndSwap(original, withoutActor); await f.inner.registry.load('local')
  await expect(f.client.replySessionQuestion(f.input)).rejects.toHaveProperty('code', 'AGENT_NATIVE_INPUT_UNAVAILABLE')
  expect(f.send).not.toHaveBeenCalled(); expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('keeps the original predecessor fence after another native reply', async () => {
  const f = await fixture()
  await f.client.replySessionQuestion(f.input)
  await expect(f.client.replySessionQuestion({ ...f.input, operationId: 'stale-question-reply' })).rejects.toHaveProperty('code', 'AGENT_PROMPT_CONDITION_CHANGED')
  expect(f.send).toHaveBeenCalledTimes(1)
  expect(await f.client.inspectAgentPromptSubmission({ ...f.key, submissionId: 'stale-question-reply' })).toBeNull()
})

it('public service, Unix RPC, Hosted, compiled CLI and discovery consume the original native reply route', async () => {
  const f = await fixture(); f.input.sourceChannel = 'cli'
  const owner = hostedTestOwner(f.client), service = new AgentMuxRpcService({ coreClients: f.coreClients })
  await expect(service.call('agent.question.reply', f.input)).rejects.toHaveProperty('code', 'AGENT_CAPABILITY_INVALID')
  const hosted = new AgentMuxHostedRuntimeService(f.client, join(f.root, 'sessions.json'), () => owner); close.push(() => hosted.dispose())
  const path = join(f.root, 'control.sock'), server = new AgentMuxControlServer({ socketPath: path, coreClients: f.coreClients, hostedRuntime: () => hosted })
  await server.start(); close.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } }); close.push(() => rpc.dispose())
  const receipt = await rpc.call('agent.question.reply', f.input)
  expect(receipt.outcome).toBe('submitted')
  const reader = await connectHostedAgentMux({ rpc }); close.push(() => reader.dispose())
  expect(reader.providers.get('codex').catalog.capabilities.asyncQuestionReply).toBe('native-input')
  expect(await reader.replySessionQuestion(f.input)).toEqual(receipt)
  const bootstrap = await hosted.bootstrap()
  expect(parseHostedBootstrap(bootstrap).catalog.find(entry => entry.id === 'codex')?.capabilities.asyncQuestionReply).toBe('native-input')
  const cli = await runCompiledObjectCli(['agent', 'question', 'reply', '--input', '-'], objectCliEnvironment(f.root), JSON.stringify(f.input))
  expect(cli.code, cli.stderr).toBe(0); expect(JSON.parse(cli.stdout).result).toEqual(receipt)
  const help = await runCompiledObjectCli(['agent', 'question', 'reply', '--help'], objectCliEnvironment(f.root))
  expect(help.code).toBe(0); expect(help.stdout).toContain('asyncQuestionReply=native-input')
  const catalogue = { hostId: 'local', executorId: 'codex', providerId: 'codex', capabilities: f.client.providers.get('codex').catalog.capabilities, availability: 'unsupported', sessions: [], issues: [] }
  expect(parseRpcNativeResult('agent.native.ls', catalogue, { hostId: 'local', executorId: 'codex' })).toEqual(catalogue)
  expect(() => parseRpcNativeResult('agent.native.ls', { ...catalogue, capabilities: { ...catalogue.capabilities, asyncQuestionReply: 'invented-route' } }, { hostId: 'local', executorId: 'codex' })).toThrow()
  expect(f.send).toHaveBeenCalledTimes(1); expect(f.inner.kernel.input).not.toHaveBeenCalled()
}, 20_000)

it.runIf(process.platform === 'darwin')('actual Provider transport delivers SDK and compiled CLI answers once to a private native protocol port on the same Run', async () => {
  const f = await fixture({ nativeProtocol: true }), receipt = await f.client.replySessionQuestion(f.input)
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: f.coreClients })
  await server.start(); close.push(() => server.stop())
  const cliInput = { ...f.input, operationId: 'cli-question-reply', afterSubmissionId: f.input.operationId }
  const run = () => runCompiledObjectCli(['agent', 'question', 'reply', '--input', '-'], objectCliEnvironment(f.root), JSON.stringify(cliInput))
  const cli = await run(); expect(cli.code, cli.stderr).toBe(0)
  const repeated = await run(); expect(repeated.code, repeated.stderr).toBe(0)
  const requests = await f.requests(), sent = requests.filter(request => request.method === 'turn/start')
  expect(sent).toHaveLength(2)
  expect(sent.every(request => request.params?.threadId === f.input.source.nativeSessionId)).toBe(true)
  expect(codexQuestionAnswers([{ type: 'text', text: sent[0]!.params!.input[0].text }])).toEqual([{ questionId: savedQuestionId, prompt: savedQuestionPrompt, answer: 'Keep the original work' }])
  expect(sent[0]!.params!.clientUserMessageId).not.toEqual(sent[1]!.params!.clientUserMessageId)
  expect(receipt.outcome).toBe('submitted'); expect(f.client.agentSession(f.input.agentSessionId).run).toEqual(f.input.expectedRun)
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 30_000)

it('reads the original byte record directly without scanning later history', async () => {
  const f = await fixture(), scan = vi.spyOn(NativeJsonlHistoryReader.prototype, 'readPrevious')
  expect((await f.client.replySessionQuestion(f.input)).outcome).toBe('submitted')
  expect(scan).not.toHaveBeenCalled()
})

it('rejects native source replacement during preparation before any claim or input', async () => {
  const f = await fixture(), provider = f.client.providers.get('codex'), prepare = provider.prepareNativeInput!
  provider.prepareNativeInput = async (...args) => {
    const prepared = await prepare(...args), original = (await f.store.readMetadata(f.input.agentSessionId))!
    await f.store.compareAndSwap(original, { ...original, nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'replacement-native-source' } })
    return prepared
  }
  await expect(f.client.replySessionQuestion(f.input)).rejects.toBeDefined()
  expect(f.send).not.toHaveBeenCalled(); expect(await f.client.inspectAgentPromptSubmission(f.key)).toBeNull()
})

it('refuses a conflicting observed native source while retaining the original actor and ordinary input', async () => {
  const f = await fixture(), original = (await f.store.readMetadata(f.input.agentSessionId))!
  await f.store.compareAndSwap(original, { ...original, observedNativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'foreign-observed-source' } })
  await f.inner.registry.load('local')
  await expect(f.client.replySessionQuestion(f.input)).rejects.toHaveProperty('code', 'AGENT_NATIVE_INPUT_UNAVAILABLE')
  expect(f.send).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  await f.client.writeAgent({ agentSessionId: f.input.agentSessionId, expectedRun: f.input.expectedRun, source: 'user', data: 'ordinary input' })
  expect(f.inner.kernel.input).toHaveBeenCalledTimes(1)
})

it('binds an original operation to its exact record and turn even when another record repeats the same native question', async () => {
  const f = await fixture()
  await f.client.replySessionQuestion(f.input)
  const path = join(f.root, 'native.jsonl'), start = (await readFile(path)).length, repeated = savedQuestionEvent()
  repeated.payload.turn_id = 'another-question-turn'
  await appendFile(path, savedQuestionJsonl([repeated]))
  await expect(f.client.replySessionQuestion({ ...f.input, recordId: `codex-record:${start}`, turnId: repeated.payload.turn_id })).rejects.toHaveProperty('code', 'AGENT_PROMPT_OPERATION_CONFLICT')
  expect(f.send).toHaveBeenCalledTimes(1)
  expect((await f.client.replySessionQuestion(f.input)).outcome).toBe('submitted')
})

it('keeps an unknown reply while an independent ordinary semantic input remains usable', async () => {
  const f = await fixture({ outcome: 'unknown' })
  await expect(f.client.replySessionQuestion(f.input)).rejects.toHaveProperty('code', 'AGENT_PROMPT_INPUT_UNCONFIRMED')
  const original = await f.client.inspectAgentPromptSubmission(f.key)
  vi.spyOn(f.client.providers.get('codex'), 'planPromptInput').mockImplementation(prompt => ({ kind: 'single-phase', data: prompt + '\r' }))
  await f.client.submitAgentPrompt({ agentSessionId: f.input.agentSessionId, expectedRun: f.input.expectedRun,
    admissionIntent: { kind: 'manual-actor' }, execution: 'immediate', prompt: 'Independent ordinary input', operationId: 'independent-semantic-input' })
  await expect.poll(() => vi.mocked(f.inner.kernel.input).mock.calls.length).toBe(1)
  expect(await f.client.inspectAgentPromptSubmission(f.key)).toEqual(original)
  expect(f.send).toHaveBeenCalledTimes(1)
})

it('joins native question reply adoption only to its original exact-condition prompt claim and source', async () => {
  const f = await fixture()
  await f.client.replySessionQuestion(f.input)
  const original = (await f.client.inspectAgentPromptSubmission(f.key))!, claim = original.admission!
  if (claim.transport !== 'native') throw Error('Expected original native claim')
  const item: AgentSessionHistoryItem = { id: 'native-answer-record', kind: 'user-message', turnId: 'reply-native-turn', contentParts: [],
    conversation: { nativeInput: { source: f.input.source, semanticItemId: 'original-native-answer', turnId: 'reply-native-turn', clientCorrelation: claim.native.plan.clientCorrelation! } } }
  const ref = { hostId: 'local', agentSessionId: f.input.agentSessionId }
  const adopted = await confirmNativeInputAdoption(item, ref, f.input.source, key => f.client.inspectAgentPromptSubmission(key))
  expect(adopted.conversation?.adoptedInput).toEqual({ key: f.key })
  for (const mode of ['missing-question', 'foreign-question-source']) {
    const other = structuredClone(original), message = other.admission!.intent!.message!
    if (mode === 'missing-question') delete message.questionReply
    else message.questionReply!.source.nativeSessionId = 'foreign-question-source'
    const unconfirmed = await confirmNativeInputAdoption(item, ref, f.input.source, async () => other)
    expect(unconfirmed.conversation?.adoptedInput).toBeUndefined()
    expect(unconfirmed.conversationDiagnostic?.code).toBe('CONVERSATION_INPUT_ADOPTION_UNCONFIRMED')
    expect(unconfirmed.contentParts).toEqual(item.contentParts)
  }
})
