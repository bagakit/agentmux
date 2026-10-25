import { expect, it, vi, afterEach } from 'vitest'
import { appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import * as processLeaves from '../../core/src/agent-native-process.js'
import { MoteChatStore } from '../src/mote-chat-store.js'
import { moteChatJourneyFixture } from './fixtures/mote-chat-journey.js'
import * as core from '../../core/src/index.js'
import { runSourceObjectCli } from '../../core/test/helpers/source-object-cli.js'
import { objectCliEnvironment } from '../../core/test/helpers/object-cli-rpc.js'
import type { ConnectionIngressMessage } from '@agentmux/core/connections'
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture() {
  const reactions: any[] = []
  const f = await moteChatJourneyFixture(0, 60000, 'headless', true, 'codex', call => {
    if (!call.path.endsWith('/reactions')) return
    if (call.method === 'POST') { const result = { reaction_id: 'reaction-' + reactions.length, operator: { operator_type: 'app', operator_id: 'cli_0123456789abcdef' }, reaction_type: JSON.parse(call.body).reaction_type }; reactions.push({ ...result, path: call.path }); return { status: 200, body: { code: 0, data: result } } }
    return { status: 200, body: { code: 0, data: { items: [], has_more: false } } }
  })
  const originalTarget = Reflect.get(f.services.ingress!, 'options').inputTarget
  // A retained input from the previous installed producer. Restore the production
  // admission port before new input; no saved Binding or old input is rewritten.
  Reflect.get(f.services.ingress!, 'options').inputTarget = undefined
  await f.wire.post(f.message('old')); const old = await f.claimed('old')
  await expect.poll(async () => (await f.services.ingress!.inspect({ ingressId: old.ingressId })).inputReceipt?.status, { timeout: 10000 }).toBe('terminal-confirmed')
  Reflect.get(f.services.ingress!, 'options').inputTarget = originalTarget
  const currentRun = f.inner.kernel.status as (id: string) => Promise<ReturnType<typeof f.run>>
  f.inner.kernel.status = async (id: string) => ({ ...await currentRun(id), acceptedInputBytes: f.run(id).acceptedInputBytes })
  const saved = (await f.store.readMetadata(old.input!.agentSessionId))!, source = { providerId: 'codex', nativeSessionId: 'original-private-thread' }, transcript = join(f.root, 'private-native.jsonl')
  await writeFile(transcript, JSON.stringify({ type: 'session_meta', payload: { id: source.nativeSessionId, cwd: saved.workspacePath, history_mode: 'paginated' } }) + '\n')
  const actor = { protocolId: 'codex-app-server-v2-0.163', actorId: 'original-private-actor', lifecycleOperationId: 'original-private-launch', token: 'b'.repeat(64), launch: { command: 'codex', args: [] } }
  await f.store.compareAndSwapMetadata(saved, { ...saved, nativeActor: actor, nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: source.nativeSessionId, transcriptPath: transcript }, nativeBinding: { source: 'user-selected', run: saved.run, observedAt: saved.updatedAt } }); await f.inner.registry.load('local')
  const sends: any[] = [], server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await new Promise<void>(resolve => server.once('listening', resolve))
  cleanup.push(async () => { for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const endpoint = 'ws://127.0.0.1:' + (server.address() as { port: number }).port
  let unavailable = false, unknown = false
  vi.spyOn(processLeaves, 'nativeProcessBirth').mockResolvedValue('original-process-birth')
  vi.spyOn(processLeaves, 'nativeProcessTcpListeners').mockImplementation(async () => unavailable ? [] : [{ processId: 400001, endpoint }])
  server.on('connection', (socket, request) => { expect(request.headers.authorization).toBe('Bearer ' + actor.token)
    socket.on('message', bytes => { const message = JSON.parse(bytes.toString()); if (!Object.hasOwn(message, 'id')) return
      let result: unknown = {}
      if (message.method === 'thread/read') result = { thread: { id: source.nativeSessionId, canAcceptDirectInput: true, status: { type: 'idle' } } }
      else if (message.method === 'turn/start') { sends.push(message.params); if (unknown) { socket.close(); return }; result = { turn: { id: 'turn-' + sends.length } } }
      else expect(message.method).toBe('initialize')
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    })
  })
  const generation = () => { const store = new MoteChatStore(f.services.database!); return store.generation(store.admissionByIngress(old.ingressId)!.generationId)! }
  const feedback = (q: ConnectionIngressMessage) => f.services.publication!.store.list(generation().binding!, 100).filter(row => row.queryFeedback?.ingressId === q.ingressId)
  const native = async (index: number, complete = false) => { const sent = sends[index]!, turn = 'turn-' + (index + 1)
    await appendFile(transcript, JSON.stringify(complete ? { type: 'event_msg', payload: { type: 'task_complete', turn_id: turn } } : { type: 'event_msg', payload: { type: 'item_completed', thread_id: source.nativeSessionId, turn_id: turn, item: { type: 'UserMessage', id: 'native-user-' + index, client_id: sent.clientUserMessageId, content: sent.input } } }) + '\n'); f.services.publication!.refresh() }
  return { ...f, get services() { return f.services }, get sdk() { return f.sdk }, old, saved, source, actor, transcript, sends, reactions, generation, feedback, native,
    unavailable(value: boolean) { unavailable = value }, unknown(value: boolean) { unknown = value },
    async send(id: string) { await f.wire.post(f.message(id)); return await f.claimed(id) } }
}
it('an existing private generation keeps its old PTY input and gains real native adoption for future input on the same Session', async () => {
  const f = await fixture(), before = structuredClone(f.generation()), bytes = vi.mocked(f.inner.kernel.input).mock.calls.length
  const q = await f.send('native')
  try { await expect.poll(() => f.sends.length, { timeout: 10000 }).toBe(1) }
  catch (error) { expect(f.sends, 'Future private input must reach the original native actor').toHaveLength(1); throw error }
  await expect.poll(async () => (await f.services.ingress!.inspect({ ingressId: q.ingressId })).inputReceipt?.status).toBe('admitted')
  expect(q.input!.admissionIntent?.kind).toBe('session-conversation'); expect(q.input!.agentSessionId).toBe(f.old.input!.agentSessionId); expect(q.input!.expectedRun).toEqual(f.old.input!.expectedRun)
  expect(f.generation().generation).toEqual({ ...before.generation, lastActivityAt: expect.any(Number) }); expect(f.generation().binding).toEqual(before.binding); expect(f.start).toHaveBeenCalledOnce()
  expect(vi.mocked(f.inner.kernel.input).mock.calls.length).toBe(bytes)
  expect((await f.services.ingress!.inspect({ ingressId: f.old.ingressId })).inputReceipt?.status).toBe('terminal-confirmed')
  await f.native(0)
  await expect.poll(async () => (await f.client.sessionHistoryPage(q.input!.agentSessionId)).items.some(item =>
    item.conversation?.adoptedInput?.key.kind === 'message' && item.conversation.adoptedInput.key.messageId === q.input!.messageId), { timeout: 10000 }).toBe(true)
  const committed = vi.spyOn(f.services.publication!.store, 'commitPage')
  try {
    await f.native(0, true)
    await expect.poll(() => committed.mock.calls.some((call, index) => committed.mock.results[index]?.type === 'return' && call[4]?.queryFeedback === true && call[4].units.some(unit => unit.records.some(record =>
      record.original.kind === 'native' && record.original.item.turnId === 'turn-1' && record.original.item.turnOutcome?.status === 'completed'))), { timeout: 10000 }).toBe(true)
    await expect.poll(() => Reflect.get(f.services.publication!, 'lanes').get(f.generation().binding!.bindingId)?.work === undefined).toBe(true)
  } finally { committed.mockRestore() }
  expect(f.feedback(q).filter(row => row.effect === 'upsert').map(row => row.queryFeedback!.stage)).toEqual(['received', 'dispatched'])
  expect(f.feedback(q).every(row => row.queryFeedback!.messageId === q.externalMessageId)).toBe(true)
  await f.restart(); expect(f.generation().generation).toEqual({ ...before.generation, lastActivityAt: expect.any(Number) }); expect(f.sends).toHaveLength(1)
}, 30000)

it.each(['unavailable', 'missing-actor'] as const)('a selected original native target with %s observation keeps the request and independent PTY capability', async kind => {
  const f = await fixture(), bytes = vi.mocked(f.inner.kernel.input).mock.calls.length
  if (kind === 'unavailable') f.unavailable(true)
  else {
    const saved = (await f.store.readMetadata(f.old.input!.agentSessionId))!, { nativeActor: _actor, ...withoutActor } = saved
    await f.store.compareAndSwapMetadata(saved, withoutActor); await f.inner.registry.load('local')
  }
  const q = await f.send(kind)
  await expect.poll(async () => (await f.services.ingress!.inspect({ ingressId: q.ingressId })).inputReceipt?.control.waiting?.wake, { timeout: 10000 }).toBe('explicit-rejoin')
  const before = await f.services.ingress!.inspect({ ingressId: q.ingressId })
  expect(before.inputReceipt?.status).toBe('waiting'); expect(f.sends).toEqual([]); expect(vi.mocked(f.inner.kernel.input).mock.calls.length).toBe(bytes)
  const input = await f.client.submitAgentPrompt({ agentSessionId: q.input!.agentSessionId, expectedRun: q.input!.expectedRun, operationId: 'explicit-original-terminal', prompt: 'Independent terminal instruction', admissionIntent: { kind: 'manual-actor' }, execution: 'immediate', authorHuman: true })
  await expect.poll(async () => (await f.client.inspectAgentInput({ key: input.key }))?.status).toBe('terminal-confirmed')
  expect(vi.mocked(f.inner.kernel.input).mock.calls.length).toBeGreaterThan(bytes)
  expect((await f.services.ingress!.inspect({ ingressId: q.ingressId })).inputReceipt?.key).toEqual(before.inputReceipt!.key)
  expect(f.start).toHaveBeenCalledOnce(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 30000)

it('an unknown native dispatch keeps its frozen correlation and is never replayed or changed to terminal on reopen', async () => {
  const f = await fixture(), bytes = vi.mocked(f.inner.kernel.input).mock.calls.length; f.unknown(true)
  const q = await f.send('unknown')
  await expect.poll(() => f.sends.length, { timeout: 10000 }).toBe(1)
  await expect.poll(async () => { const claim = (await f.services.ingress!.inspect({ ingressId: q.ingressId })).inputReceipt?.admission?.admission; return claim?.transport === 'native' ? claim.native.outcome : undefined }, { timeout: 10000 }).toBe('unknown')
  expect(f.sends).toHaveLength(1)
  const before = (await f.services.ingress!.inspect({ ingressId: q.ingressId })).inputReceipt!
  await f.restart(); f.services.publication!.refresh(true)
  const after = (await f.services.ingress!.inspect({ ingressId: q.ingressId })).inputReceipt!
  expect(after.key).toEqual(before.key); expect(after.admission?.admission?.intent).toEqual(before.admission?.admission?.intent)
  expect(after.status).toBe('unknown'); expect(f.sends).toHaveLength(1); expect(vi.mocked(f.inner.kernel.input).mock.calls.length).toBe(bytes)
  expect(f.feedback(q).some(row => row.queryFeedback!.stage === 'started' || row.queryFeedback!.stage === 'completed')).toBe(false)
}, 30000)

it('a changed original source or revoked private route never retargets the saved conversation input', async () => {
  const f = await fixture(), original = f.submission.getMockImplementation()!
  f.submission.mockImplementation(async (...args) => { f.inner.connected = false; f.inner.kernel.isConnected = () => false; return await original(...args) })
  const q = await f.send('source-change')
  await expect.poll(async () => (await f.services.ingress!.inspect({ ingressId: q.ingressId })).inputReceipt?.control.waiting?.phase).toBe('runtime')
  const before = (await f.services.ingress!.inspect({ ingressId: q.ingressId })).inputReceipt!
  const saved = (await f.store.readMetadata(q.input!.agentSessionId))!
  await f.store.compareAndSwapMetadata(saved, { ...saved, nativeHandle: { ...saved.nativeHandle!, sessionId: 'different-native-thread' } as typeof saved.nativeHandle }); await f.inner.registry.load('local')
  f.inner.connected = true; f.inner.kernel.isConnected = () => true
  Reflect.get(f.client, 'publisher').publish({ type: 'connection-state', state: 'restored', evidence: { source: 'run-process', observedAt: Date.now() } })
  await expect.poll(async () => (await f.client.inspectAgentInput({ key: before.key }))?.control.waiting?.wake, { timeout: 10000 }).toBe('explicit-rejoin')
  expect(f.sends).toHaveLength(0); expect((await f.client.inspectAgentInput({ key: before.key }))?.key).toEqual(before.key)
  const configuration = await f.sdk.call('space.mote.chat.inspect', { target: f.target })
  await f.sdk.call('space.mote.chat.configure', { operationId: 'disable-original-route', target: f.target, expectedRevision: configuration.configuration!.revision, expectedConnectionRevision: 1, values: { ...configuration.configuration!.values, enabled: false } })
  await expect(f.services.ingress!.rejoin(q.ingressId)).rejects.toBeDefined()
  expect(f.start).toHaveBeenCalledOnce(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 30000)

it('a Provider without native input contribution keeps real private PTY delivery and does not invent processing', async () => {
  const f = await moteChatJourneyFixture(0, 60000, 'headless', false, 'grok')
  await f.wire.post(f.message('unsupported')); const q = await f.claimed('unsupported')
  expect(Reflect.get(f.client, 'providers').get('grok').prepareNativeInput).toBeUndefined()
  expect(q.input?.admissionIntent?.kind).toBe('session-conversation')
  await expect.poll(async () => (await f.services.ingress!.inspect({ ingressId: q.ingressId })).inputReceipt?.status).toBe('terminal-confirmed')
  const store = new MoteChatStore(f.services.database!), binding = store.generation(store.admissionByIngress(q.ingressId)!.generationId)!.binding!
  expect(f.services.publication!.store.list(binding).filter(row => row.queryFeedback).every(row => !['started', 'completed'].includes(row.queryFeedback!.stage))).toBe(true)
  expect(f.inner.kernel.input).toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 30000)

it('source CLI and public SDK preserve session input journal membership through stop and rejoin before real native adoption', async () => {
  const f = await fixture(), agentSessionId = f.old.input!.agentSessionId, expectedRun = f.old.input!.expectedRun
  const cli = async (args: string[], input: unknown) => {
    const result = await runSourceObjectCli(['--endpoint', 'unix:' + join(f.root, 'public.sock'), ...args], objectCliEnvironment(f.root,
      process.env.AGENTMUX_TEST_NATIVE_PRIVATE_CLI_LOADED ? { AGENTMUX_RESUMED_INBOX_CLI_LOADED: process.env.AGENTMUX_TEST_NATIVE_PRIVATE_CLI_LOADED } : {}), JSON.stringify(input), 30000,
      new URL('../../core/test/fixtures/a2a-resumed-inbox/source-loader.mjs', import.meta.url))
    expect(result.code, result.stdout + result.stderr).toBe(0); return JSON.parse(result.stdout).result
  }
  const cut = await cli(['agent', 'input', 'changes', '--input', '-'], { hostId: 'local', agentSessionId })
  f.inner.connected = false; f.inner.kernel.isConnected = () => false
  const result = await cli(['agent', 'input', 'submit', '--session', agentSessionId, '--operation-id', 'cli-conversation-input', '--input', '-'], { expectedRun, prompt: 'Original public conversation input', admissionIntent: { kind: 'session-conversation' }, execution: 'immediate' })
  const receipt = result.input
  expect(receipt.status).toBe('waiting'); expect(receipt.key.kind).toBe('prompt')
  await cli(['agent', 'input', 'stop', '--input', '-'], { ref: receipt.ref, cancelOperationId: 'stop-cli-conversation' })
  const stopped = await cli(['agent', 'input', 'inspect', '--input', '-'], { key: receipt.key })
  expect(stopped.input?.status).toBe('stopped')
  const next = await cli(['agent', 'input', 'rejoin', '--input', '-'], { ref: receipt.ref })
  expect((next.inputReceipt ?? next).ref.waitGeneration).toBe(2)
  const changed = await cli(['agent', 'input', 'changes', '--input', '-'], { hostId: 'local', agentSessionId, after: cut.checkpoint })
  expect(changed.changes.map((row: any) => row.key)).toContainEqual(receipt.key)
  f.inner.connected = true; f.inner.kernel.isConnected = () => true
  Reflect.get(f.client, 'publisher').publish({ type: 'connection-state', state: 'restored', evidence: { source: 'run-process', observedAt: Date.now() } })
  await expect.poll(() => f.sends.length, { timeout: 10000 }).toBe(1)
  await expect.poll(async () => (await f.client.inspectAgentInput({ key: receipt.key }))?.status).toBe('admitted')
  await f.native(0)
  const history = await f.client.sessionHistoryPage(agentSessionId)
  expect(history.items.some(item => item.conversation?.adoptedInput?.key.kind === 'prompt' && item.conversation.adoptedInput.key.submissionId === 'cli-conversation-input')).toBe(true)
  await expect(f.sdk.call('agent.input.submit', { agentSessionId, operationId: 'invalid-conversation-target', expectedRun, prompt: 'No dispatch', admissionIntent: { kind: 'session-conversation', source: f.source } as never, execution: 'immediate' })).rejects.toBeDefined()
  expect(f.sends).toHaveLength(1)
}, 60000)

it('Hosted Runtime and public agent send consume the same original native conversation intent without a new Provider method', async () => {
  const f = await fixture(), agentSessionId = f.old.input!.agentSessionId, expectedRun = f.old.input!.expectedRun
  const { hostedTestOwner } = await import('../../core/test/helpers/hosted-runtime-port.js')
  const { AgentMuxHostedRuntimeService } = await import('../../core/src/hosted-runtime-service.js')
  const { connectHostedAgentMux } = await import('../../core/src/hosted-client.js')
  const service = new AgentMuxHostedRuntimeService(f.client, f.store.path, () => hostedTestOwner(f.client)); cleanup.push(() => service.dispose())
  const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'native-hosted.sock'), coreClients: f.coreClients, hostedRuntime: () => service }); await server.start(); cleanup.push(() => server.stop())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  const hosted = await connectHostedAgentMux({ rpc, waitForReady: false }); cleanup.push(() => hosted.dispose())
  const receipt = await hosted.submitAgentPrompt({ agentSessionId, expectedRun, operationId: 'hosted-conversation-input', prompt: 'Original hosted input', admissionIntent: { kind: 'session-conversation' }, execution: 'immediate' })
  await expect.poll(async () => (await hosted.inspectAgentInput({ key: receipt.key }))?.status).toBe('admitted')
  expect(f.sends).toHaveLength(1)
  const result = await f.sdk.call('agent.send', { target: { kind: 'agent-session', agentSessionId }, expectedRun, operationId: 'public-conversation-message', text: 'Original public message', execution: 'immediate', admissionIntent: { kind: 'session-conversation', expectedRun } })
  await expect.poll(() => f.sends.length).toBe(2)
  expect(result.inputReceipt?.key.kind).toBe('message')
  expect((await f.client.readAgentSession(agentSessionId))?.run).toEqual(expectedRun); expect(f.start).toHaveBeenCalledOnce()
}, 30000)
