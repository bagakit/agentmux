import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
const factsPath = process.env.AGENTMUX_TEST_REFERENCE_FACTS
const cliEntry = process.env.AGENTMUX_TEST_REFERENCE_CLI
const coreEntry = process.env.AGENTMUX_TEST_REFERENCE_CORE ?? new URL('../dist/index.js', import.meta.url).href
const core = await import(/* @vite-ignore */ coreEntry) as typeof import('../src/index.js')
const { parseAgentMuxMessagePrefix } = await import(new URL('./agent-message-render.js', coreEntry).href) as typeof import('../src/agent-message-render.js')
const { WebSocket } = createRequire(import.meta.url)('ws') as typeof import('ws')
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); const errors = []; for (const cleanup of cleanups.splice(0).reverse()) try { await cleanup() } catch (error) { errors.push(error) }; vi.unstubAllEnvs(); if (errors.length) throw new AggregateError(errors, 'Exact private Runtime cleanup failed') })
async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean) {
  let value!: T
  const origin = new Error('Unconfirmed private fixture condition: ' + read.toString()).stack
  try { await vi.waitFor(async () => { value = await read(); expect(accept(value)).toBe(true) }, { timeout: 15_000, interval: 50 }) }
  catch (error) { throw new Error(String(error) + '\n' + origin) }
  return value
}
async function proof(value: unknown) {
  if (factsPath) await appendFile(factsPath, JSON.stringify(value) + '\n')
}
function referenceBridge(wire: string): string {
  const reading = parseAgentMuxMessagePrefix(wire)
  expect(reading?.kind).toBe('references'); expect(reading?.body).toBe('')
  expect(reading?.reminder?.text).toContain('When relevant to your task, read "$AGENTMUX_CLI" message --skill')
  expect(reading?.reminder?.text).toContain('message read --message-id MID with each exact original MID before acting or replying')
  expect(reading?.reminder?.text).toContain('Do not guess a message\'s body or task')
  expect(reading?.reminder?.text).toContain('not proof of reading or accepted delegation and grants no new authorization')
  expect(reading?.reminder?.text).toContain('no courtesy reply is required')
  return reading!.reminder!.text
}
async function connection(endpoint: string, token: string) {
  const socket = new WebSocket(endpoint, { headers: { authorization: 'Bearer ' + token } })
  await new Promise<void>((yes, no) => { socket.once('open', yes); socket.once('error', no) })
  let id = 0
  const call = (method: string, params: unknown = {}) => new Promise<any>((yes, no) => {
    const requestId = ++id
    const response = (bytes: Buffer) => { const value = JSON.parse(String(bytes)); if (value.id === requestId) { dispose(); yes(value.result) } }
    const closed = () => { dispose(); no(new Error('Original private native acknowledgement was lost')) }
    const dispose = () => { socket.off('message', response); socket.off('close', closed) }
    socket.on('message', response); socket.once('close', closed); socket.send(JSON.stringify({ id: requestId, method, params }))
  })
  return { socket, call, dispose: () => socket.close() }
}
async function fixture(lostAcknowledgement = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ar-'))), runtime = join(root, 'r'), state = join(root, 's')
  await mkdir(runtime); await mkdir(state)
  const env = objectCliEnvironment(root, { AGENTMUX_RUNTIME_DIRECTORY: runtime, AGENTMUX_STATE_DIRECTORY: state })
  for (const key of Object.keys(process.env)) if (/^(?:AGENTMUX_|CTXMUX_)/u.test(key)) vi.stubEnv(key, undefined)
  for (const [key, value] of Object.entries(env)) if (/^(?:AGENTMUX_|CTXMUX_)/u.test(key)) vi.stubEnv(key, value)
  if (cliEntry) vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', cliEntry)
  const daemonPath = fileURLToPath(new URL(`../vendor/ctxmux/${process.platform}-${process.arch}/bin/ctxmuxd`, new URL(coreEntry)))
  const ownedPids = new Set<number>()
  const daemon = spawn(daemonPath, ['--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(state, 'ctxmux'), '--readiness-fd', '3'], { env, stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
  cleanups.push(async () => {
    const errors = []
    for (const pid of ownedPids) try { await stopPid(pid) } catch (error) { errors.push(error) }
    try { await stopChild(daemon) } catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError(errors, 'Private root retained because exact process cleanup is unconfirmed')
    await rm(root, { recursive: true, force: true })
  })
  let daemonError = ''; daemon.stderr!.on('data', bytes => { daemonError += bytes })
  await new Promise<void>((yes, no) => { daemon.stdio[3]!.once('data', () => yes()); daemon.once('error', no); daemon.once('exit', code => no(new Error('Private daemon exited ' + code + ': ' + daemonError))) })
  const identity = async (sessionId: string) => JSON.parse(await readFile(join(root, sessionId + '-identity.json'), 'utf8')) as { processId: number; nativeSessionId: string; endpoint: string; capability: string }
  const tokens = new Map<string, string>()
  const provider = core.defineAgentProvider({ catalog: { id: 'proof-reference-native', label: 'Private reference queue protocol', executable: process.execPath,
    expectedProcess: 'node', promptDelivery: 'positional-argv', readySignal: { kind: 'foreground-process', expectedProcess: 'node' }, hookStrategy: { kind: 'none' },
    resumeStrategy: { kind: 'provider-native', locator: 'session-id' }, acpStrategy: { kind: 'none' }, capabilities: { terminal: true, timeline: 'unavailable', permission: 'none', providerResume: true, replyCorrelation: 'none' } },
    buildArgs: (_prompt, args) => [...args], buildResumeArgs: (_nativeId, _transcript, _prompt, args) => [...args], hook: { rules: [] },
    async prepareManagedLaunch(plan, lifecycleOperationId) {
      const token = randomBytes(32).toString('hex'), actorId = randomUUID(); tokens.set(actorId, token)
      return { plan: { ...plan, env: { ...plan.env, REFERENCE_ACTOR_TOKEN: token } }, nativeActor: { protocolId: 'reference-private-v1', actorId, lifecycleOperationId, token, launch: { command: plan.command, args: plan.args } } }
    },
    async discoverNativeSession(context) {
      const id = context.args.at(-2); if (!id) return null
      const observed = await identity(id).catch(() => null); if (!observed || observed.processId !== context.processId) return null
      return { handle: { kind: 'provider', providerId: 'proof-reference-native', sessionId: observed.nativeSessionId },
        async assertCurrent() { process.kill(observed.processId, 0); expect((await identity(id)).processId).toBe(context.processId) } }
    },
    async observeSessionStatus(context) {
      const id = context.nativeHandle?.kind === 'provider' ? context.nativeHandle.sessionId.replace(/^native-/u, '') : ''; if (!id) throw new Error('The original private native source is missing');
      const observed = await identity(id), transport = await connection(observed.endpoint, tokens.get((await store.readMetadata(id))!.nativeActor!.actorId)!)
      transport.socket.on('message', bytes => { const event = JSON.parse(String(bytes)); if (event.method === 'status/changed') context.onStatus(event.params) })
      context.onStatus(await transport.call('status/subscribe'))
      return { dispose: transport.dispose }
    },
    async prepareNativeInput(context, target) {
      const id = target.nativeSessionId.replace(/^native-/u, ''), observed = await identity(id)
      expect(observed.processId).toBe(context.processId); expect(target.idleOnly).toBe(true)
      if (!context.nativeActor) throw new Error('The original private fixture actor is missing')
      const transport = await connection(observed.endpoint, context.nativeActor.token)
      return { plan: { kind: 'native-rpc', protocolId: context.nativeActor.protocolId, sourceId: JSON.stringify([target.providerId, target.nativeSessionId]),
        actorId: context.nativeActor.actorId, threadId: target.nativeSessionId, operation: 'queue-idle' }, dispose: transport.dispose,
        async assertCurrent() { expect((await identity(id)).processId).toBe(context.processId) },
        async send(wire, frozen) {
          const original = await store.readPromptAdmission(id, client.agentSession(id).run, JSON.parse(Buffer.from(frozen.clientCorrelation!.split('.')[1]!, 'base64url').toString()).key.submissionId)
          expect(original?.admission?.intent?.plan).toEqual(frozen)
          const result = await transport.call('queue/add', { threadId: target.nativeSessionId, input: [{ type: 'text', text: wire }], clientUserMessageId: frozen.clientCorrelation })
          return { outcome: 'admitted', queuedSubmissionId: result.queuedSubmissionId }
        } }
    }
  })
  const store = new core.AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
  const events: unknown[] = []
  let client = new core.AgentMuxClient({ store, providers: [provider] })
  client.onEvent(event => { if (event.type === 'agent-error') events.push(event) })
  await client.connect()
  const sessions: Array<{ agentSessionId: string; run: { runId: string } }> = []
  cleanups.push(async () => { const errors = []; for (const session of sessions) try { if ((await client.statusAgent(session.agentSessionId)).run.state === 'running') await client.stopAgent(session.agentSessionId, session.run) } catch (error) { errors.push(error) }; try { await client.dispose() } catch (error) { errors.push(error) }; if (errors.length) throw new AggregateError(errors) })
  for (const id of ['sender', 'recipient']) {
    const session = await client.createAgent({ agentSessionId: id, createOperationId: 'create-' + id, providerId: provider.id, executorId: provider.id, workspacePath: root,
      commandOverride: process.execPath, args: [fileURLToPath(new URL('./fixtures/a2a-reference/native-actor.mjs', import.meta.url)), root, id, lostAcknowledgement ? 'lost' : 'ack'], env, injectAgentMuxGuide: false })
    sessions.push(session)
    const actual = await eventually(async () => {
      const observed = await identity(id).catch(() => null)
      if (!observed) {
        const status = await client.statusAgent(id)
        if (status.run.state !== 'running') throw new Error('Private actor exited: ' + JSON.stringify(await client.readRunReplay(session.run)))
      }
      return observed
    }, Boolean); ownedPids.add(actual!.processId)
    await client.refreshAgentSession(id, session.run)
    await eventually(() => client.statusAgent(id), value => Boolean(value.session.nativeHandle))
    await eventually(() => readFile(join(root, id + '-subscribed'), 'utf8').catch(() => ''), value => value === 'ready')
  }
  const server = new core.AgentMuxControlServer({ socketPath: join(root, 'control.sock'), coreClients: () => [{ hostId: 'local', client }] }); await server.start()
  cleanups.push(() => server.stop())
  const sender = await identity('sender'), recipient = await identity('recipient'), recipientStored = (await store.readMetadata('recipient'))!
  const control = await connection(recipient.endpoint, recipientStored.nativeActor!.token); cleanups.push(async () => control.dispose())
  const userEnvironment = { ...env, AGENTMUX_RPC_ENDPOINT: 'unix://' + server.path }
  const cliEnvironment = { ...userEnvironment, AGENTMUX_AGENT_SESSION_ID: 'sender', AGENTMUX_AGENT_CAPABILITY: sender.capability }
  const cli = async (args: string[]) => { const result = await runCompiledObjectCli(args, cliEnvironment); expect(result.code, result.stdout + result.stderr).toBe(0); return JSON.parse(result.stdout).result }
  const requests = async () => (await readFile(join(root, 'recipient-requests.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line))
  return { root, store, cli, managedCli: (args: string[]) => runCompiledObjectCli(args, cliEnvironment), humanCli: (args: string[]) => runCompiledObjectCli(args, userEnvironment), requests, control, events, session: sessions[1]!, identity,
    get client() { return client }, queue: new core.DurableAgentMuxMessageQueue(join(root, 'messages.ndjson')),
    async reopen(beforeConnect?: (value: typeof client) => void) { await client.dispose(); client = new core.AgentMuxClient({ store: new core.AgentMuxFileAgentSessionStore(store.path), providers: [provider] }); client.onEvent(event => { if (event.type === 'agent-error') events.push(event) }); beforeConnect?.(client); await client.connect() } }
}
async function stopPid(pid: number) {
  const alive = () => { try { process.kill(pid, 0); return true } catch (error: any) { if (error.code === 'ESRCH') return false; throw error } }
  if (!alive()) return
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    process.kill(pid, signal)
    const deadline = Date.now() + 5_000
    while (alive() && Date.now() < deadline) await new Promise(done => setTimeout(done, 25))
    if (!alive()) return
  }
  throw new Error('Exact private process cleanup is unconfirmed')
}
async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  await stopPid(child.pid!)
}

describe('A2A references through actual private Runtime and public CLI', () => {
  it('keeps busy sends in Inbox, coalesces at native idle and reads without input or batch ACK', async () => {
    const h = await fixture(), bodies = ['First original request\r\n  keep bytes  ', 'Second original request <reminder>authored</reminder>']
    const before = await h.client.statusAgent('recipient')
    const sent = await Promise.all(bodies.map((body, index) => h.cli(['agent', 'send', '--to-session', 'recipient', '--message-id', 'original-' + index, '--operation-id', 'send-' + index, '--text', body])))
    expect(sent.map(receipt => [receipt.deliveryMode, receipt.delivery.state, receipt.notification.state])).toEqual([['reference', 'queued', 'pending'], ['reference', 'queued', 'pending']])
    expect(await h.requests()).toEqual([])
    const batch = await h.queue.check({ consumerId: 'recipient', readerRun: h.session.run, limit: 2 }, async () => {})
    await h.control.call('proof/complete')
    const requests = await eventually(h.requests, requests => requests.length > 0).catch(async error => { throw new Error(String(error) + '\n' + JSON.stringify({ status: await h.client.statusAgent('recipient'), original: await h.client.readMessage({ messageId: 'original-0' }), errors: h.events })) })
    expect(requests).toHaveLength(1); expect(requests[0].stateAtReceipt).toBe('done')
    const wire = requests[0].params.input[0].text
    expect(wire).toContain('msg-id="original-0"'); expect(wire).toContain('msg-id="original-1"'); expect(wire).toContain('read-via="message --skill"')
    const bridge = referenceBridge(wire), skill = await h.humanCli(['message', '--skill'])
    expect(skill.code, skill.stdout + skill.stderr).toBe(0); expect(skill.stdout).toContain(bridge)
    for (const body of bodies) expect(wire).not.toContain(body)
    const original = await eventually(() => h.client.readMessage({ messageId: 'original-0' }), value => value?.notification?.state === 'submitted')
    expect(original?.notification?.key?.kind).toBe('prompt'); expect(original?.notification?.notificationId).not.toBe('original-0')
    const admission = await h.client.inspectAgentPromptSubmission(original!.notification!.key!)
    expect(admission?.admission?.intent?.message).toMatchObject({ a2aNotificationId: original!.notification!.notificationId, systemContext: wire })
    expect(admission?.admission?.intent?.message).not.toHaveProperty('userContent'); expect(admission?.admission?.intent?.message).not.toHaveProperty('authorHuman'); expect(admission?.admission?.intent?.message).not.toHaveProperty('authorAgentSessionId')
    expect(admission?.admission?.transport).toBe('native'); expect(admission?.admission?.native).toMatchObject({ outcome: 'admitted', queuedSubmissionId: expect.any(String) })
    const notifiedBatch = await h.queue.check({ consumerId: 'recipient', readerRun: h.session.run, limit: 2 }, async () => {})
    expect(notifiedBatch.generation).toBe(batch.generation); expect(notifiedBatch.messages.map(message => message.envelope)).toEqual(batch.messages.map(message => message.envelope))
    const read = await h.cli(['message', 'read', '--message-id', 'original-0'])
    expect(read.message.envelope.body).toBe(bodies[0]); expect(await h.requests()).toHaveLength(1)
    expect(await h.queue.check({ consumerId: 'recipient', readerRun: h.session.run, limit: 2 }, async () => {})).toEqual(notifiedBatch)
    await h.reopen(); await h.control.call('proof/complete')
    expect(await h.client.readMessage({ messageId: 'original-0' })).toMatchObject({ envelope: { body: bodies[0] }, delivery: { state: 'queued' }, notification: { state: 'submitted', key: original!.notification!.key } })
    expect(await h.requests()).toHaveLength(1)
    const after = await h.client.statusAgent('recipient')
    expect(after.run.runId).toBe(before.run.runId); expect(after.run.pid).toBe(before.run.pid); expect(after.run.acceptedInputBytes).toBe(before.run.acceptedInputBytes)
    await proof({ scenario: 'idle-coalescing-and-reopen', originalIds: sent.map(receipt => receipt.messageId), original: original?.notification, before: before.run, after: after.run, wire, requests: requests.length, restoredNotification: (await h.client.readMessage({ messageId: 'original-0' }))?.notification, bodyAfterReopen: (await h.client.readMessage({ messageId: 'original-0' }))?.envelope.body, originalBody: bodies[0] })
  }, 45_000)

  it('isolates unknown native input from later messages and actual human terminal input', async () => {
    const h = await fixture(true)
    await h.cli(['agent', 'send', '--to-session', 'recipient', '--message-id', 'unknown-original', '--text', 'Preserve this original body'])
    await h.control.call('proof/complete')
    const original = await eventually(() => h.client.readMessage({ messageId: 'unknown-original' }), value => value?.notification?.state === 'unconfirmed')
    const requests = await h.requests(); expect(requests).toHaveLength(1)
    const observed: Array<Awaited<ReturnType<typeof h.queue.prepareNotification>>> = []
    await h.reopen(client => {
      // Observe the actual restored journal call; retain every original decision.
      const queue = (client as unknown as { messageQueue: typeof h.queue }).messageQueue
      const prepare = queue.prepareNotification.bind(queue)
      vi.spyOn(queue, 'prepareNotification').mockImplementation(async input => { const notice = await prepare(input); observed.push(notice); return notice })
    })
    await eventually(async () => observed, notices => notices.some(notice => notice?.notificationId === original?.notification?.notificationId))
    expect(observed.length).toBeGreaterThan(0)
    const retained = await h.client.readMessage({ messageId: 'unknown-original' })
    expect(retained?.notification?.key).toEqual(original?.notification?.key); expect(retained?.notification?.state).toBe('unconfirmed'); expect(await h.requests()).toHaveLength(1)
    await h.cli(['agent', 'send', '--to-session', 'recipient', '--message-id', 'independent-new', '--text', 'A distinct later original request'])
    // No additional turn, completion or input-byte change creates this opportunity.
    const independent = await eventually(() => h.client.readMessage({ messageId: 'independent-new' }), value => value?.notification?.state === 'unconfirmed').catch(async error => { throw new Error(String(error) + '\n' + JSON.stringify({ status: await h.client.statusAgent('recipient'), original: await h.client.readMessage({ messageId: 'independent-new' }), notices: observed, requests: await h.requests(), errors: h.events })) })
    expect(independent?.notification?.key).not.toEqual(original?.notification?.key)
    const bothRequests = await h.requests(); expect(bothRequests).toHaveLength(2)
    expect(bothRequests[1].nativeStatus).toEqual(bothRequests[0].nativeStatus)
    expect(bothRequests[1].params.input[0].text).toContain('msg-id="independent-new"')
    expect(bothRequests[1].params.input[0].text).not.toContain('msg-id="unknown-original"')
    expect((await h.client.readMessage({ messageId: 'unknown-original' }))?.notification?.key).toEqual(original?.notification?.key)
    await proof({ scenario: 'same-idle-unknown-and-new-mid', originalKey: original?.notification?.key, restoredKey: retained?.notification?.key, independentKey: independent?.notification?.key, oldMid: 'unknown-original', newMid: 'independent-new', requests: bothRequests.map(request => ({ nativeStatus: request.nativeStatus, wire: request.params.input[0].text })) })
    const before = await h.client.statusAgent('recipient')
    await h.client.writeAgent({ agentSessionId: 'recipient', expectedRun: h.session.run, source: 'user', data: 'Original manual input remains usable\r' })
    const after = await h.client.statusAgent('recipient')
    expect(after.run.runId).toBe(before.run.runId); expect(after.run.pid).toBe(before.run.pid); expect(after.run.acceptedInputBytes).toBeGreaterThan(before.run.acceptedInputBytes)
    expect(await eventually(() => readFile(join(h.root, 'recipient-terminal.bytes'), 'utf8').catch(() => ''), value => value.includes('Original manual input remains usable'))).toContain('Original manual input remains usable')
  }, 45_000)

  it('refuses an ordinary prompt ACK as proof of a distinct user notification', async () => {
    const h = await fixture(), operationId = 'ordinary-ack', prompt = 'Original user prompt owns its input key'
    await h.cli(['agent', 'send', '--to-session', 'recipient', '--message-id', 'needs-explicit-notice', '--text', 'An original Inbox request'])
    await h.client.submitAgentPrompt({ agentSessionId: 'recipient', operationId, expectedRun: h.session.run,
      admissionIntent: { kind: 'manual-actor' }, execution: 'immediate', prompt, authorHuman: true })
    const key = { kind: 'prompt' as const, agentSessionId: 'recipient', expectedRun: h.session.run, submissionId: operationId }
    const original = await eventually(() => h.client.inspectAgentPromptSubmission(key), value => value?.admission?.acknowledged === true || value?.terminalPromptSubmission?.submit.acknowledged === true)
    expect(await eventually(() => readFile(join(h.root, 'recipient-terminal.bytes'), 'utf8').catch(() => ''), value => value.includes(prompt))).toContain(prompt)
    const refused = await h.humanCli(['message', 'notify', '--host', 'local', '--message-id', 'needs-explicit-notice', '--operation-id', operationId])
    expect(refused.code).not.toBe(0)
    expect(refused.stdout + refused.stderr).toContain('AGENT_PROMPT_OPERATION_CONFLICT')
    expect(await h.client.inspectAgentPromptSubmission(key)).toEqual(original)
    expect(await h.queue.readNotification(operationId)).toBeNull()
    expect((await h.client.readMessage({ messageId: 'needs-explicit-notice' }))?.notification).toEqual({ state: 'pending' })
    expect(await h.requests()).toEqual([])
  }, 45_000)

  it('reserves pending notification keys while preserving distinct human input', async () => {
    const h = await fixture(), notificationId = 'reserved-notice'
    await h.cli(['agent', 'send', '--to-session', 'recipient', '--message-id', 'reserved-original', '--text', 'Keep the selected original Inbox body'])
    // A durable user action interrupted before dispatch owns this exact input key.
    const notice = await h.queue.prepareNotification({ notificationId, agentSessionId: 'recipient', condition: { expectedRun: h.session.run, afterSubmissionId: null }, messageIds: ['reserved-original'] })
    expect(notice?.state).toBe('pending')
    const before = await h.client.statusAgent('recipient')
    await expect(h.client.submitAgentPrompt({ agentSessionId: 'recipient', operationId: notificationId, expectedRun: h.session.run,
      admissionIntent: { kind: 'manual-actor' }, execution: 'immediate', prompt: 'Unrelated input must not take the notice key', authorHuman: true })).rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
    expect(await h.queue.readNotification(notificationId)).toEqual(notice)
    expect(await h.client.inspectAgentPromptSubmission(notice!.key)).toBeNull()
    expect((await h.client.statusAgent('recipient')).run.acceptedInputBytes).toBe(before.run.acceptedInputBytes)
    const unrelatedPrompt = 'The other Session keeps its own same-ID input capability'
    const senderRun = h.client.agentSession('sender').run
    await h.client.submitAgentPrompt({ agentSessionId: 'sender', operationId: notificationId, expectedRun: senderRun,
      admissionIntent: { kind: 'manual-actor' }, execution: 'immediate', prompt: unrelatedPrompt, authorHuman: true })
    expect(await eventually(() => readFile(join(h.root, 'sender-terminal.bytes'), 'utf8').catch(() => ''), value => value.includes(unrelatedPrompt))).toContain(unrelatedPrompt)
    const senderKey = { kind: 'prompt' as const, agentSessionId: 'sender', expectedRun: senderRun, submissionId: notificationId }
    const unrelated = await h.client.inspectAgentPromptSubmission(senderKey)
    expect(unrelated?.admission?.inputKey).toEqual(senderKey)
    expect(unrelated?.admission?.acknowledged || unrelated?.terminalPromptSubmission?.submit.acknowledged).toBe(true)
    expect(await h.queue.readNotification(notificationId)).toEqual(notice)
    const prompt = 'A distinct user input remains available'
    await h.client.submitAgentPrompt({ agentSessionId: 'recipient', operationId: 'independent-user-input', expectedRun: h.session.run,
      admissionIntent: { kind: 'manual-actor' }, execution: 'immediate', prompt, authorHuman: true })
    expect(await eventually(() => readFile(join(h.root, 'recipient-terminal.bytes'), 'utf8').catch(() => ''), value => value.includes(prompt))).toContain(prompt)
    expect(await h.queue.readNotification(notificationId)).toEqual(notice)
    expect(await h.requests()).toEqual([])
  }, 45_000)


  it('submits reference notifications through flags and JSON and lets an authenticated participant inspect or reuse the original operation', async () => {
    const h = await fixture(), originals = ['user-single', 'user-batch-left', 'user-batch-right']
    for (const id of originals) await h.cli(['agent', 'send', '--to-session', 'recipient', '--message-id', id, '--text', 'Private original body ' + id])
    const batch = await h.queue.check({ consumerId: 'recipient', readerRun: h.session.run, limit: 3 }, async () => {})
    const before = await h.client.statusAgent('recipient')
    const singleArgs = ['message', 'notify', '--host', 'local', '--message-id', originals[0]!, '--operation-id', 'user-single-notice']
    const single = await h.managedCli(singleArgs)
    expect(single.code, single.stdout + single.stderr).toBe(0)
    const singleResult = JSON.parse(single.stdout).result
    expect(singleResult.notification).toMatchObject({ notificationId: 'user-single-notice', messageIds: [originals[0]], mode: 'steer', state: 'submitted' })
    const inputPath = join(h.root, 'user-notification.json')
    await writeFile(inputPath, JSON.stringify({ hostId: 'local', operationId: 'user-batch-notice', messageIds: originals.slice(1) }))
    const batchArgs = ['message', 'notify', '--input', inputPath], merged = await h.humanCli(batchArgs)
    expect(merged.code, merged.stdout + merged.stderr).toBe(0)
    const mergedResult = JSON.parse(merged.stdout).result
    expect(mergedResult.notification).toMatchObject({ notificationId: 'user-batch-notice', messageIds: originals.slice(1), mode: 'steer', state: 'submitted' })
    for (const result of [singleResult, mergedResult]) {
      const { notification, input } = result
      expect(input.admission.intent.prompt).toBe(notification.wire)
      expect(input.admission.intent.message).toEqual({ a2aNotificationId: notification.notificationId, systemContext: notification.wire })
      expect(input.admission.acknowledged || input.terminalPromptSubmission?.submit.acknowledged).toBe(true)
      expect(notification.wire).toContain('read-via="message --skill"'); expect(notification.wire).not.toContain('Private original body')
      referenceBridge(notification.wire)
      expect(parseAgentMuxMessagePrefix(notification.wire)?.references?.map(reference => reference.declaredMessageId)).toEqual(notification.messageIds)
    }
    const written = await eventually(() => readFile(join(h.root, 'recipient-terminal.bytes'), 'utf8').catch(() => ''), value => value.includes(mergedResult.notification.wire))
    for (const result of [singleResult, mergedResult]) expect(written.split(result.notification.wire)).toHaveLength(2)
    const accepted = await h.client.statusAgent('recipient')
    expect(accepted.run.acceptedInputBytes).toBeGreaterThan(before.run.acceptedInputBytes)
    expect((await h.humanCli(singleArgs)).code).toBe(0); expect((await h.humanCli(batchArgs)).code).toBe(0)
    expect((await h.client.statusAgent('recipient')).run.acceptedInputBytes).toBe(accepted.run.acceptedInputBytes)
    expect(await readFile(join(h.root, 'recipient-terminal.bytes'), 'utf8')).toBe(written)
    const repeated = await h.managedCli(singleArgs)
    expect(repeated.code, repeated.stdout + repeated.stderr).toBe(0)
    expect(JSON.parse(repeated.stdout).result.notification.key).toEqual(singleResult.notification.key)
    const inspected = await h.managedCli(['message', 'notify', 'inspect', '--host', 'local', '--operation-id', 'user-single-notice'])
    expect(inspected.code, inspected.stdout + inspected.stderr).toBe(0)
    expect(JSON.parse(inspected.stdout).result.notification.key).toEqual(singleResult.notification.key)
    expect((await h.client.statusAgent('recipient')).run.acceptedInputBytes).toBe(accepted.run.acceptedInputBytes)
    expect(await readFile(join(h.root, 'recipient-terminal.bytes'), 'utf8')).toBe(written)
    expect(await h.requests()).toEqual([])
    const retained = await h.queue.check({ consumerId: 'recipient', readerRun: h.session.run, limit: 3 }, async () => {})
    expect(retained.generation).toBe(batch.generation); expect(retained.readerRun).toEqual(batch.readerRun)
    expect(retained.messages.map(message => message.envelope)).toEqual(batch.messages.map(message => message.envelope))
    for (const id of originals) expect(await h.client.readMessage({ messageId: id })).toMatchObject({ envelope: { body: 'Private original body ' + id }, delivery: { state: 'queued' }, notification: { state: 'submitted' } })
    expect((await h.queue.readJournal()).some(record => record.kind === 'consumer-ack')).toBe(false)
  }, 45_000)

})
