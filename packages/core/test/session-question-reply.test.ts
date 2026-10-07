import { fixtureEpoch as _newTailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as compiled from '../dist/index.js'
import { loadAgentSessions } from '../src/agent-session-store.js'
import type { AgentMuxSessionQuestionReplyInput } from '../src/client.js'
import { agentPromptCondition } from '../src/agent-prompt-condition.js'
import { buildPromptInputPayload } from '../src/bracketed-paste.js'
import { AgentMuxError } from '../src/errors.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { parseHostedBootstrap } from '../src/hosted-value.js'
import { parseRpcNativeResult } from '../src/rpc-native-codec.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import { hostedTestOwner } from './helpers/hosted-runtime-port.js'
import type { AgentScreenEvidenceStore } from '../src/screen-evidence.js'

const source = { providerId: 'codex', nativeSessionId: 'original-native-source' }
const close: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of close.splice(0).reverse()) await cleanup(); vi.restoreAllMocks() })
async function fixture(owner: 'source' | 'compiled' = 'source') {
  const f = await rpcOwnerFixture(['question-session'], owner === 'compiled'
    ? compiled as unknown as Parameters<typeof rpcOwnerFixture>[1] : undefined,
  () => ({ nativeHandle: { kind: 'provider', providerId: source.providerId, sessionId: source.nativeSessionId } }))
  close.push(() => f.close())
  const inner = f.client as unknown as { screenEvidence: AgentScreenEvidenceStore }
  const screen = vi.spyOn(inner.screenEvidence, 'wait').mockResolvedValue(3)
  const input: AgentMuxSessionQuestionReplyInput = { ...agentPromptCondition(f.client.agentSession('question-session')),
    agentSessionId: 'question-session', source, turnId: 'original-turn', recordId: 'original-call',
    answers: [{ questionId: 'original-question', answer: 'Keep' }], operationId: 'original-question-reply' }
  return { ...f, input, screen }
}
const recovery = (input: AgentMuxSessionQuestionReplyInput) => JSON.stringify({ reason: 'original-terminal-required',
  recovery: { kind: 'terminal', agentSessionId: input.agentSessionId, expectedRun: input.expectedRun } })

it.each(['source', 'compiled'] as const)('%s Core exposes its terminal route without an input claim or display inspection', async owner => {
  const f = await fixture(owner), before = await readFile(join(f.root, 'sessions.json'), 'utf8')
  expect(f.client.providers.get('codex').catalog.capabilities.asyncQuestionReply).toBe('terminal')
  await expect(f.client.replySessionQuestion(f.input)).rejects.toMatchObject({
    code: 'AGENT_QUESTION_REPLY_UNSUPPORTED', detail: recovery(f.input) })
  expect(await readFile(join(f.root, 'sessions.json'), 'utf8')).toBe(before)
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  expect(f.screen).not.toHaveBeenCalled()
})
it.each(['done', 'working', 'unknown'] as const)('terminal recovery is independent of the %s turn state', async state => {
  const f = await fixture(), previous = (await loadAgentSessions(f.store))[0]!
  await f.store.compareAndSwap(previous, { ...previous, ...(state === 'unknown' ? {}
    : { semanticStatus: { state, source: 'native-hook' as const, observedAt: _newTailFixtureEpoch(0, 0, 2), stateEnteredAt: _newTailFixtureEpoch(0, 0, 2) } }), updatedAt: _newTailFixtureEpoch(0, 0, 2) })
  await f.inner.registry.load('local')
  await expect(f.client.replySessionQuestion(f.input)).rejects.toHaveProperty('code', 'AGENT_QUESTION_REPLY_UNSUPPORTED')
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
})
it.each(['run', 'source', 'provider', 'answer'] as const)('rejects wrong %s while ordinary input remains usable', async mode => {
  const f = await fixture(), input = { ...f.input, ...(mode === 'run' ? { expectedRun: { runId: 'another-run' } }
    : mode === 'source' ? { source: { ...source, nativeSessionId: 'another-source' } }
    : mode === 'provider' ? { source: { ...source, providerId: 'another-provider' } }
    : { answers: [{ questionId: 'original-question', answer: '' }] }) }
  await expect(f.client.replySessionQuestion(input)).rejects.toHaveProperty('code', mode === 'run' ? 'STALE_AGENT_SESSION'
    : mode === 'source' ? 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' : 'INVALID_AGENT_QUESTION_REPLY')
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  await f.client.submitAgentPrompt({ ...agentPromptCondition(f.client.agentSession(f.input.agentSessionId)),
    agentSessionId: f.input.agentSessionId, prompt: 'Ordinary manual message', operationId: 'ordinary-input' })
  expect(vi.mocked(f.inner.kernel.input).mock.calls.map(call => (call[1] as { data: string }).data))
    .toEqual([buildPromptInputPayload('Ordinary manual message'), '\r'])
})
it('preserves earlier partial/unknown input rather than treating this rejected call as proof of non-application', async () => {
  const f = await fixture(), original = f.inner.kernel.input as (...args: unknown[]) => Promise<unknown>
  let first = true
  f.inner.kernel.input = vi.fn(async (...args: unknown[]) => {
    const receipt = await original(...args)
    if (first) { first = false; throw new AgentMuxError('Applied payload receipt unavailable.', 'CTXMUX_INPUT_UNCONFIRMED', 'unknown') }
    return receipt
  })
  await expect(f.client.submitAgentPrompt({ ...agentPromptCondition(f.client.agentSession(f.input.agentSessionId)),
    agentSessionId: f.input.agentSessionId, prompt: 'Original preserved message', operationId: 'original-unknown' })).rejects.toBeDefined()
  const before = await readFile(join(f.root, 'sessions.json'), 'utf8'), writes = vi.mocked(f.inner.kernel.input).mock.calls.length
  await expect(f.client.replySessionQuestion(f.input)).rejects.toHaveProperty('code', 'AGENT_QUESTION_REPLY_UNSUPPORTED')
  expect(await readFile(join(f.root, 'sessions.json'), 'utf8')).toBe(before)
  expect(vi.mocked(f.inner.kernel.input).mock.calls).toHaveLength(writes)
})
it('manual terminal input remains a same-Run path with an explicit byte receipt', async () => {
  const f = await fixture()
  await expect(f.client.replySessionQuestion(f.input)).rejects.toHaveProperty('code', 'AGENT_QUESTION_REPLY_UNSUPPORTED')
  const ack = await f.client.writeAgent({ agentSessionId: f.input.agentSessionId, expectedRun: f.input.expectedRun,
    source: 'user', data: 'My terminal answer' })
  expect(ack.runId).toBe(f.input.expectedRun.runId)
  expect(ack.appliedByteRange).toEqual({ startByte: 0, endByte: Buffer.byteLength('My terminal answer') })
  expect(vi.mocked(f.inner.kernel.input).mock.calls).toHaveLength(1)
})
it('the original public service enforces authority and retains recovery facts', async () => {
  const f = await fixture(), service = new AgentMuxRpcService({ coreClients: f.coreClients })
  await expect(service.call('agent.question.reply', f.input)).rejects.toHaveProperty('code', 'AGENT_CAPABILITY_INVALID')
  await expect(service.call('agent.question.reply', f.input, {
    principal: { kind: 'user', id: 'private-local-user' }, transport: 'unix' })).rejects.toMatchObject({
    code: 'AGENT_QUESTION_REPLY_UNSUPPORTED', detail: recovery(f.input) })
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
})
it('retained question route is available without a Runtime connection or a recovery side effect', async () => {
  const f = await fixture()
  f.inner.connected = false
  f.inner.kernel.isConnected = () => false
  const connect = vi.spyOn(f.client, 'connect').mockRejectedValue(new Error('Runtime observation unavailable'))
  await expect(f.client.replySessionQuestion(f.input)).rejects.toMatchObject({ code: 'AGENT_QUESTION_REPLY_UNSUPPORTED', detail: recovery(f.input) })
  const service = new AgentMuxRpcService({ coreClients: f.coreClients })
  await expect(service.call('agent.question.reply', f.input, { principal: { kind: 'user', id: 'private-user' }, transport: 'unix' }))
    .rejects.toMatchObject({ code: 'AGENT_QUESTION_REPLY_UNSUPPORTED', detail: recovery(f.input) })
  expect(connect).not.toHaveBeenCalled(); expect(f.inner.kernel.input).not.toHaveBeenCalled()
  expect(f.inner.kernel.status).not.toHaveBeenCalled()
})
it('Unix RPC, Hosted, compiled CLI and discovery codec consume the same original route', async () => {
  const f = await fixture(), owner = hostedTestOwner(f.client)
  const hosted = new AgentMuxHostedRuntimeService(f.client, join(f.root, 'sessions.json'), () => owner)
  close.push(() => hosted.dispose())
  const path = join(f.root, 'control.sock')
  const server = new AgentMuxControlServer({ socketPath: path, coreClients: f.coreClients, hostedRuntime: () => hosted })
  await server.start(); close.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } }); close.push(() => rpc.dispose())
  await expect(rpc.call('agent.question.reply', f.input)).rejects.toMatchObject({
    code: 'AGENT_QUESTION_REPLY_UNSUPPORTED', detail: recovery(f.input) })
  const reader = await connectHostedAgentMux({ rpc }); close.push(() => reader.dispose())
  expect(reader.providers.get('codex').catalog.capabilities.asyncQuestionReply).toBe('terminal')
  const bootstrap = await hosted.bootstrap()
  expect(() => parseHostedBootstrap({ ...bootstrap, catalog: [{ ...bootstrap.catalog[0], capabilities: {
    ...bootstrap.catalog[0]!.capabilities, asyncQuestionReply: 'automatic' } }] })).toThrow()
  f.inner.connected = false
  f.inner.kernel.isConnected = () => false
  const connect = vi.spyOn(f.client, 'connect').mockRejectedValue(new Error('Runtime observation unavailable'))
  await expect(reader.replySessionQuestion(f.input)).rejects.toMatchObject({
    code: 'AGENT_QUESTION_REPLY_UNSUPPORTED', detail: recovery(f.input) })
  expect(connect).not.toHaveBeenCalled()
  const input = join(f.root, 'reply.json'); await writeFile(input, JSON.stringify(f.input))
  const cli = await runCompiledObjectCli(['agent', 'question', 'reply', '--input', input], objectCliEnvironment(f.root))
  expect(cli.code).not.toBe(0)
  expect(cli.stdout + cli.stderr).toContain('AGENT_QUESTION_REPLY_UNSUPPORTED')
  expect(cli.stdout + cli.stderr).toContain('original-terminal-required')
  const help = await runCompiledObjectCli(['agent', 'question', 'reply', '--help'], objectCliEnvironment(f.root))
  expect(help.code).toBe(0); expect(help.stdout).toContain('asyncQuestionReply=terminal')
  expect(help.stdout).toContain('agent view --session SID --mode terminal')
  const catalogue = { hostId: 'local', executorId: 'codex', providerId: 'codex',
    capabilities: f.client.providers.get('codex').catalog.capabilities, availability: 'unsupported', sessions: [], issues: [] }
  expect(parseRpcNativeResult('agent.native.ls', catalogue, { hostId: 'local', executorId: 'codex' })).toEqual(catalogue)
  expect(() => parseRpcNativeResult('agent.native.ls', { ...catalogue, capabilities: { ...catalogue.capabilities, asyncQuestionReply: 'automatic' } },
    { hostId: 'local', executorId: 'codex' })).toThrow()
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
}, 20_000)
