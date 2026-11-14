import { afterEach, expect, it, vi } from 'vitest'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { nativeInputCorrelationKey } from '../src/native-input-correlation.js'
import { agentPromptCondition } from '../src/agent-prompt-condition.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { ObjectCliProbe } from './helpers/object-cli-rpc.js'
import { runSourceObjectCli } from './helpers/source-object-cli.js'

const machine = vi.hoisted(() => ({ endpoint: '' }))
// Kernel discovery is the explicit deterministic port; the original built-in
// Provider's prepare/verify/send, WS bytes and saved-history parser are real.
vi.mock('../src/agent-native-process.js', () => ({
  nativeProcessBirth: async (pid: number) => `original-private-kernel-${pid}`,
  nativeProcessTcpListeners: async () => [{ processId: 4321, endpoint: machine.endpoint }]
}))
const closes: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const source = { providerId: 'codex', nativeSessionId: 'wire-original-thread' }
const actor = { protocolId: 'codex-app-server-v2-0.163', actorId: 'wire-original-actor', lifecycleOperationId: 'wire-original-lifecycle', token: 'a'.repeat(64), launch: { command: 'codex', args: [] } }
const line = (value: unknown) => JSON.stringify(value) + '\n'
it.each(['direct', 'queued'] as const)('the actual Core input consumer and original native %s wire produce the private result through CLI', async carrier => {
  const h = await rpcOwnerFixture(['recipient']); closes.push(h.close)
  const socket = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(socket, 'listening')
  const address = socket.address(); if (!address || typeof address === 'string') throw Error('Private native endpoint missing')
  machine.endpoint = `ws://127.0.0.1:${address.port}`
  closes.push(async () => { for (const peer of socket.clients) peer.terminate(); await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve())) })
  const path = join(h.root, 'original-native.jsonl'), before = (await h.store.readMetadata('recipient'))!
  const meta = { type: 'session_meta', payload: { id: source.nativeSessionId, cwd: h.root, history_mode: 'paginated' } }
  await writeFile(path, line(meta))
  await h.store.compareAndSwap(before, { ...before, nativeActor: actor, nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: source.nativeSessionId, transcriptPath: path },
    nativeBinding: { source: 'user-selected', run: before.run, observedAt: before.updatedAt }, semanticStatus: { state: 'done', source: 'native-hook', observedAt: before.updatedAt } })
  h.inner.kernel.status = vi.fn(async (runId: string) => ({ ...h.run(runId), pid: 1234 }))
  await h.inner.registry.load('local')
  const calls: any[] = [], errors: unknown[] = []
  socket.on('connection', (peer, request) => {
    expect(request.headers.authorization).toBe(`Bearer ${actor.token}`)
    peer.on('message', data => { void (async () => {
      const value = JSON.parse(String(data)); calls.push(value)
      if (value.id === undefined) return
      const reply = (result: unknown) => peer.send(JSON.stringify({ jsonrpc: '2.0', id: value.id, result }))
      if (value.method === 'initialize') return reply({})
      if (value.method === 'thread/read') return reply({ thread: { id: source.nativeSessionId, canAcceptDirectInput: true, status: { type: 'idle' } } })
      if (!['turn/start', 'thread/queue/add'].includes(value.method)) throw Error('Unexpected original native method ' + value.method)
      const key = nativeInputCorrelationKey(value.params.clientUserMessageId)!
      expect(key).toBeTruthy()
      const frozen = await h.store.readPromptAdmission(key.agentSessionId, key.expectedRun, key.kind === 'prompt' ? key.submissionId : key.messageId)
      expect(frozen?.admission?.native?.outcome).toBe('claimed')
      expect(frozen?.admission?.native?.plan.clientCorrelation).toBe(value.params.clientUserMessageId)
      expect(frozen?.nativeSource?.nativeHandle).toMatchObject({ providerId: 'codex', sessionId: source.nativeSessionId, transcriptPath: path })
      return reply(value.method === 'turn/start' ? { turn: { id: 'wire-native-turn' } } : { queuedSubmission: { id: 'wire-queue-item', clientUserMessageId: value.params.clientUserMessageId, input: value.params.input } })
    })().catch(error => { errors.push(error); peer.close() }) })
  })
  const prompt = 'Private machine result input', operationId = 'wire-' + carrier
  if (carrier === 'queued') {
    await h.client.saveAgentFuturePromptIntent({ agentSessionId: 'recipient', expectedRun: before.run, intentId: 'wire-future', operationId: 'wire-future-definition', prompt, active: true })
    await expect(h.client.submitAgentPrompt({ agentSessionId: 'recipient', operationId, ...agentPromptCondition(h.client.agentSession('recipient')), prompt,
      expectedFutureIntent: { intentId: 'wire-future', occurrenceAt: 1000 }, expectedInputByte: 0 })).resolves.toBeUndefined()
  } else {
    await h.client.submitAgentPrompt({ agentSessionId: 'recipient', operationId, expectedRun: before.run, execution: 'immediate',
      admissionIntent: { kind: 'native-conversation', source }, prompt, authorHuman: true })
    await Reflect.get(h.client, 'inputWaitingRecipients').get('recipient')?.pending
  }
  expect(errors).toEqual([])
  const key = { kind: 'prompt' as const, agentSessionId: 'recipient', expectedRun: before.run, submissionId: operationId }
  const admitted = (await h.client.inspectAgentPromptSubmission(key))!
  expect(admitted?.admission).toMatchObject({ transport: 'native', native: { outcome: 'admitted' } })
  expect(admitted.nativeResult?.state).toBe('unknown')
  const sent = calls.find(value => value.method === (carrier === 'direct' ? 'turn/start' : 'thread/queue/add'))
  await appendFile(path, line({ timestamp: '2026-11-15T00:00:00Z', ordinal: 1, type: 'event_msg', payload: { type: 'task_started', thread_id: source.nativeSessionId, turn_id: 'wire-native-turn' } }) +
    line({ timestamp: '2026-11-15T00:00:00Z', ordinal: 2, type: 'event_msg', payload: { type: 'item_completed', thread_id: source.nativeSessionId,
    turn_id: 'wire-native-turn', item: { type: 'UserMessage', id: 'wire-canonical-item', client_id: sent.params.clientUserMessageId, content: [{ type: 'text', text: prompt }] } } }) +
    line({ timestamp: '2026-11-15T00:00:01Z', ordinal: 3, type: 'event_msg', payload: { type: 'task_complete', thread_id: source.nativeSessionId, turn_id: 'wire-native-turn' } }))
  if (carrier === 'queued') await h.client.sessionHistoryPage('recipient')
  else {
    await h.client.statusAgent('recipient')
    await vi.waitFor(async () => expect((await h.client.inspectAgentPromptSubmission(key))?.nativeResult?.state).toBe('completed'))
  }
  const rpc = new AgentMuxRpcService({ coreClients: h.coreClients }); closes.push(() => rpc.dispose())
  const probe = new ObjectCliProbe(request => rpc.call(request.method as any, request.params as any, { caller: h.credentials }))
  await probe.start(); closes.push(() => probe.stop())
  const cli = await runSourceObjectCli(['--endpoint', 'unix:' + probe.socketPath, 'agent', 'input', 'inspect', '--input', '-'], probe.environment(), JSON.stringify({ key }))
  expect(cli.code, cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout).result.record.nativeResult).toMatchObject({ state: 'completed', nativeTurnId: 'wire-native-turn', correlation: { kind: carrier === 'direct' ? 'native-ack' : 'native-adoption' } })
  expect(h.inner.kernel.input).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
  if (process.env.PROMPT_NATIVE_RESULT_CASES) await appendFile(process.env.PROMPT_NATIVE_RESULT_CASES, line({ scenario: 'actual-native-wire-' + carrier,
    root: h.root, nativeRequests: calls.map(value => value.method), key, modelCalls: 0, kernelDiscovery: 'controlled-port', sourceProviderAndCoreAndCli: true }))
}, 20000)
