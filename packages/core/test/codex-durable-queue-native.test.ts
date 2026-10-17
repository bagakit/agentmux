import { offlineEndpoint } from './helpers/codex-offline-endpoint.js'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { activateRuntime } from '../node_modules/@ctxmux/sdk/dist/index.js'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { JSONRPCClient } from 'json-rpc-2.0'
import { afterEach, expect, it, vi } from 'vitest'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import * as runner from '../src/process-runner.js'
import { runSourceObjectCli } from './helpers/source-object-cli.js'
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'
import { consumeConversationWindowPage, type ConversationWindowAssembly } from '../src/conversation-changes.js'

vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, fork: ((modulePath: string | URL, args: readonly string[], options: import('node:child_process').ForkOptions) =>
    actual.fork(String(modulePath).endsWith('/control-endpoint-listener-worker.js')
      ? fileURLToPath(new URL('../src/control-endpoint-listener-worker.ts', import.meta.url)) : modulePath, args, options)) as typeof actual.fork }
})

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })


/** Real Codex/CodexL, kernel identity, native writer and durable queue. Core's
 * Runtime status/byte port is the explicit fixture boundary; no real model or
 * user Run participates. A native protocol receipt is not model task adoption. */
it.runIf(process.platform === 'darwin')('public A2A reference reaches an existing wrapper native thread, then original MID and Outbox remain queryable', async () => {
  const h = await rpcOwnerFixture(['sender', 'recipient']), root = h.root, home = join(root, 'native-home'), helper = join(root, 'native-process-proof')
  const nativeVersion = await runner.runProcess('codex', ['--version'], { timeoutMs: 3000 })
  expect(nativeVersion.stdout.trim()).toBe('codex-cli 0.163.0')
  const compiled = await runner.runProcess('cc', ['-Wall', '-Wextra', '-Werror', fileURLToPath(new URL('../native/native-socket-peer.c', import.meta.url)), '-lproc', '-o', helper], { timeoutMs: 10_000 })
  expect(compiled).toMatchObject({ exitCode: 0, stderr: '' })
  const originalRunProcess = runner.runProcess
  vi.spyOn(runner, 'runProcess').mockImplementation((command, args, options) =>
    originalRunProcess(command.endsWith('/native-socket-peer-darwin') ? helper : command, args, options))
  // Exercise the original standalone listener worker through Node's native TS
  // loader. Source qualification does not generate or borrow a dist artifact.
  await mkdir(home)
  const inputs: string[] = []
  const { endpoint, sockets } = await offlineEndpoint(home, inputs)
  const child = spawn('codexL', ['as-ops', '--mode=global', '--', 'app-server', '--stdio'], {
    cwd: root, env: { ...process.env, CODEX_HOME: home, HOME: root }, detached: true, stdio: ['pipe', 'pipe', 'pipe']
  })
  const nativeEvents: any[] = [], coreEvents: any[] = [], calls: string[] = []
  let ended = false, diagnostic = '', carry = '', server: AgentMuxControlServer | undefined
  let sender: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined, recipient: typeof sender
  const native = new JSONRPCClient(value => new Promise<void>((resolve, reject) => {
    calls.push(value.method); child.stdin.write(JSON.stringify(value) + '\n', error => error ? reject(error) : resolve())
  }))
  child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes.toString()).slice(-4096) })
  const closed = new Promise<void>(resolve => child.once('close', () => { ended = true; native.rejectAllPendingRequests('Private wrapper stopped: ' + diagnostic); resolve() }))
  child.stdout.on('data', bytes => { carry += bytes.toString(); for (let newline; (newline = carry.indexOf('\n')) >= 0;) {
    const line = carry.slice(0, newline); carry = carry.slice(newline + 1)
    if (!line.trim()) continue
    const value = JSON.parse(line)
    if (value.method) nativeEvents.push(value); else native.receive(value)
  } })
  const call = (method: string, params: Record<string, unknown>) => native.timeout(10_000).request(method, params) as Promise<any>
  try {
    await call('initialize', { clientInfo: { name: 'agentmux_queue_native_proof', version: '1' }, capabilities: { experimentalApi: true } })
    native.notify('initialized', {}, undefined)
    const started = await call('thread/start', { cwd: root, threadSource: 'user', modelProvider: 'private_queue', model: 'private-queue', approvalPolicy: 'never', sandbox: 'read-only' })
    const nativeId = started.thread.id, initial = await call('turn/start', { threadId: nativeId, input: [{ type: 'text', text: 'PRIVATE_QUEUE_INITIAL' }] })
    await vi.waitFor(() => expect(nativeEvents.some(event => event.method === 'turn/completed' && event.params.turn.id === initial.turn.id)).toBe(true), { timeout: 10_000, interval: 50 })
    const read = await call('thread/read', { threadId: nativeId, includeTurns: false }), path = read.thread.path
    expect(read.thread).toMatchObject({ id: nativeId, status: { type: 'idle' }, canAcceptDirectInput: true })
    const saved = (await h.store.readMetadata('recipient'))!
    await h.store.compareAndSwapMetadata(saved, { ...saved, workspacePath: root,
      nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: nativeId, transcriptPath: path }, updatedAt: Date.now() })
    await h.inner.registry.load('local')
    h.inner.kernel.status = vi.fn(async (runId: string) => ({ ...h.run(runId), ...(runId === saved.run.runId ? { pid: child.pid!, program: 'codexL', args: ['as-ops', '--mode=global', '--', 'app-server', '--stdio'] } : {}) }))
    h.client.onEvent(event => coreEvents.push(event))
    await vi.waitFor(async () => expect((await h.client.statusAgent('recipient')).session.semanticStatus?.state).toBe('done'), { timeout: 10_000, interval: 50 })
    server = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), coreClients: h.coreClients }); await server.start()
    sender = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path }, credentials: h.credentials })
    recipient = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path }, credentials: { ...h.credentials, agentSessionId: 'recipient' } })
    const mid = 'native-queue-original-mid', body = 'PRIVATE_QUEUE_ORIGINAL_BODY stays in the Core Inbox'
    const sent = await sender.call('agent.send', { target: { kind: 'agent-session', agentSessionId: 'recipient' }, messageId: mid, operationId: 'native-queue-send', text: body })
    expect(sent).toMatchObject({ deliveryMode: 'reference', envelope: { body, recipientSessionId: 'recipient' } })
    await vi.waitFor(async () => {
      const current = await h.client.readMessage({ messageId: mid })
      expect(current?.notification?.state, JSON.stringify(coreEvents)).toBe('submitted')
    }, { timeout: 15_000, interval: 100 })
    const message = (await h.client.readMessage({ messageId: mid }))!, key = message.notification!.key!
    const claim = await h.client.inspectAgentPromptSubmission(key)
    expect(claim?.admission).toMatchObject({ acknowledged: true, transport: 'native', native: { outcome: 'admitted', queuedSubmissionId: expect.any(String), plan: { protocolId: 'codex-durable-queue-0.163', operation: 'queue-idle' } } })
    const wire = claim!.admission!.intent!.prompt
    expect(wire).toContain(`msg-id="${mid}"`); expect(wire).toContain('read-via="message --skill"'); expect(wire).not.toContain(body)
    await vi.waitFor(() => expect(inputs.filter(text => text === wire)).toHaveLength(1), { timeout: 20_000, interval: 100 })
    await vi.waitFor(async () => expect((await readFile(path, 'utf8')).includes(claim!.admission!.native!.plan.clientCorrelation!)).toBe(true), { timeout: 5000, interval: 50 })
    const opened = await recipient.call('message.read', { messageId: mid })
    expect(opened.message?.envelope.body).toBe(body)
    const outbox = await sender.call('message.events', { messageId: mid })
    expect(outbox.events.some(event => event.kind === 'a2a-notification-result')).toBe(true)
    expect((await h.client.statusAgent('recipient')).run).toMatchObject({ runId: saved.run.runId, pid: child.pid!, state: 'running' })
    expect((await h.store.readMetadata('recipient'))?.nativeActor).toBeUndefined()
    expect(h.inner.kernel.input).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    expect(calls.filter(method => method === 'turn/start')).toHaveLength(1)
    expect(calls).not.toContain('thread/resume')
  } finally {
    await recipient?.dispose(); await sender?.dispose(); await server?.stop(); await h.client.dispose()
    child.stdin.end()
    await Promise.race([closed, new Promise<void>(resolve => setTimeout(resolve, 1500))])
    if (!ended && child.pid) { process.kill(-child.pid, 'SIGTERM'); await closed }
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => endpoint.close(() => resolve()))
    // All original process handles have closed before the private namespace goes away.
    expect(ended).toBe(true)
    await rm(root, { recursive: true })
  }
}, 60_000)

it.runIf(process.platform === 'darwin')('actual ctxmux Run and source Core survive reconnect while source CLI reads the exact queued Inbox and sender events', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amux-native-runtime-'))), runtime = join(root, 'runtime'), state = join(root, 'state')
  for (const name of ['runtime', 'state', 'sender-home', 'recipient-home']) await mkdir(join(root, name), { mode: 0o700 })
  for (const name of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(name)) vi.stubEnv(name, undefined)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', runtime); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', state)
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  const helper = join(root, 'native-process-proof'), compiled = await runner.runProcess('cc', ['-Wall', '-Wextra', '-Werror',
    fileURLToPath(new URL('../native/native-socket-peer.c', import.meta.url)), '-lproc', '-o', helper], { timeoutMs: 10_000 })
  expect(compiled).toMatchObject({ exitCode: 0, stderr: '' })
  const originalRunProcess = runner.runProcess
  vi.spyOn(runner, 'runProcess').mockImplementation((command, args, options) =>
    originalRunProcess(command.endsWith('/native-socket-peer-darwin') ? helper : command, args, options))
  const inputs: string[] = [], { endpoint, sockets } = await offlineEndpoint(join(root, 'sender-home'), inputs)
  const config = await readFile(join(root, 'sender-home', 'config.toml'))
  await writeFile(join(root, 'recipient-home', 'config.toml'), config)
  const builtin = new AgentProviderRegistry().get('codex'), worker = fileURLToPath(new URL('./fixtures/codex-queue-native-worker.mjs', import.meta.url))
  const provider = { ...builtin, planManagedHooks: () => null,
    buildLaunch: (context: Parameters<typeof builtin.buildLaunch>[0]) => {
      const id = context.args[0]; if (!id) throw new Error('Private fixture identity is missing')
      return { command: process.execPath, args: [worker, root, id, join(root, id + '-home')], env: { ...context.env } }
    } }
  const storePath = join(root, 'sessions.json'), sessions: Array<{ agentSessionId: string; run: { runId: string } }> = []
  const errors: unknown[] = [], observations: unknown[] = []
  let activation: Awaited<ReturnType<typeof activateRuntime>> | undefined, client: AgentMuxClient | undefined, server: AgentMuxControlServer | undefined
  let sender: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined
  try {
    activation = await activateRuntime({ executable: fileURLToPath(new URL('../vendor/ctxmux/darwin-arm64/bin/ctxmuxd', import.meta.url)),
      socketPath: join(runtime, 'ctxmux.sock'), stateDir: join(state, 'ctxmux'), env: { AGENTMUX_AGENT_SESSION_ID: undefined, AGENTMUX_AGENT_CAPABILITY: undefined },
      timeoutMs: 5000, childDisposition: { mode: 'detached', stdout: 'ignore', stderr: 'pipe' } })
    expect(activation.spawned).toBe(true)
    client = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(storePath), providers: [provider] }); await client.connect()
    client.onEvent(event => { if (event.type === 'agent-error') observations.push(event) })
    for (const id of ['sender', 'recipient']) {
      const session = await client.createAgent({ agentSessionId: id, createOperationId: 'create-' + id, providerId: 'codex', executorId: 'codex',
        workspacePath: root, injectAgentMuxGuide: false, commandOverride: process.execPath, args: [id] })
      sessions.push(session)
      await vi.waitFor(async () => {
        const identity = JSON.parse(await readFile(join(root, id + '-identity.json'), 'utf8'))
        const status = await client!.statusAgent(id)
        expect(status.run.pid).toBe(identity.processId)
        await client!.refreshAgentSession(id, session.run)
        expect((await client!.statusAgent(id)).session.semanticStatus?.state, JSON.stringify(observations)).toBe('done')
      }, { timeout: 15_000, interval: 100 })
    }
    const sourceIdentity = JSON.parse(await readFile(join(root, 'sender-identity.json'), 'utf8'))
    const recipientIdentity = JSON.parse(await readFile(join(root, 'recipient-identity.json'), 'utf8'))
    const original = await client.statusAgent('recipient')
    expect(original.session.nativeHandle).toMatchObject({ sessionId: recipientIdentity.nativeSessionId, transcriptPath: recipientIdentity.transcriptPath })
    expect((await new AgentMuxFileAgentSessionStore(storePath).readMetadata('recipient'))?.nativeActor).toBeUndefined()
    server = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), coreClients: () => [{ hostId: 'local', client: client! }] }); await server.start()
    sender = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path }, credentials: { agentSessionId: 'sender', capability: sourceIdentity.capability } })
    const body = 'PRIVATE_QUEUE_ORIGINAL_RUNTIME_BODY remains sealed in Inbox', mid = 'native-runtime-original-mid'
    const sent = await sender.call('agent.send', { target: { kind: 'agent-session', agentSessionId: 'recipient' }, messageId: mid, operationId: 'native-runtime-send', text: body })
    expect(sent).toMatchObject({ deliveryMode: 'reference', envelope: { body, recipientSessionId: 'recipient' } })
    await vi.waitFor(async () => expect((await client!.readMessage({ messageId: mid }))?.notification?.state, JSON.stringify(observations)).toBe('submitted'), { timeout: 15_000, interval: 100 })
    const notified = (await client.readMessage({ messageId: mid }))!, claim = await client.inspectAgentPromptSubmission(notified.notification!.key!)
    expect(claim?.admission).toMatchObject({ transport: 'native', acknowledged: true, native: { outcome: 'admitted', queuedSubmissionId: expect.any(String), plan: { protocolId: 'codex-durable-queue-0.163', operation: 'queue-idle' } } })
    const wire = claim!.admission!.intent!.prompt
    expect(wire).toContain(`msg-id="${mid}"`); expect(wire).not.toContain(body)
    await vi.waitFor(() => expect(inputs.filter(text => text === wire)).toHaveLength(1), { timeout: 20_000, interval: 100 })
    await vi.waitFor(async () => expect((await readFile(recipientIdentity.transcriptPath, 'utf8')).includes(claim!.admission!.native!.plan.clientCorrelation!)).toBe(true), { timeout: 5000, interval: 50 })
    expect(inputs.every(text => !text.includes(body))).toBe(true)
    expect(await readFile(recipientIdentity.transcriptPath, 'utf8')).not.toContain(body)
    // Dispose/reconnect only the Core client. The original ctxmux Run and native
    // process keep the same durable identities; no resume or replacement launch.
    await client.dispose()
    client = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(storePath), providers: [provider] }); await client.connect()
    const rejoined = await client.statusAgent('recipient')
    expect(rejoined.run).toMatchObject({ runId: original.run.runId, pid: original.run.pid, state: 'running' })
    expect(rejoined.session.nativeHandle).toEqual(original.session.nativeHandle)
    const history = await client.sessionHistoryPage('recipient', { limit: 100 })
    const adopted = history.items.find(item => item.conversation?.nativeInput?.clientCorrelation === claim!.admission!.native!.plan.clientCorrelation)
    expect(adopted?.conversation?.adoptedInput?.key).toEqual(notified.notification!.key)
    expect(adopted?.conversation?.adoptedInput?.purpose).toBe('a2a-notification')
    expect(adopted?.turnId).toEqual(expect.any(String))
    const conversation = await vi.waitFor(async () => {
      let page = await client!.readAgentConversation({ hostId: 'local', agentSessionId: 'recipient', limit: 100 }), pending: ConversationWindowAssembly | undefined
      for (let pages = 0; pages < 10; pages++) {
        const result = consumeConversationWindowPage(page, pending)
        if (result.kind === 'complete') {
          const assistant = result.snapshot.units.find(unit => unit.records.some(record => record.original.kind === 'native' &&
            record.original.item.kind === 'assistant-message' && record.original.item.turnId === adopted!.turnId))
          expect(assistant, 'The queued native turn must have a complete public assistant message').toBeDefined()
          return result.snapshot
        }
        pending = result.pending
        page = await client!.readAgentConversation({ hostId: 'local', agentSessionId: 'recipient', limit: 100, cursor: page.nextCursor! })
      }
      throw new Error('Private native proof exceeded the bounded conversation window')
    }, { timeout: 5000, interval: 100 })
    const notice = conversation.units.find(unit => unit.records.some(record => record.original.kind === 'native' &&
      record.original.item.conversation?.nativeInput?.clientCorrelation === claim!.admission!.native!.plan.clientCorrelation))!
    expect(notice.event).toMatchObject({ role: 'notice', author: { kind: 'system' } })
    const assistant = conversation.units.find(unit => unit.records.some(record => record.original.kind === 'native' &&
      record.original.item.kind === 'assistant-message' && record.original.item.turnId === adopted!.turnId))!
    const nativeAnswer = assistant.records.find(record => record.original.kind === 'native' && record.original.item.kind === 'assistant-message')!
    expect(nativeAnswer.original).toMatchObject({ kind: 'native', item: { contentParts: [{ kind: 'text', text: 'PRIVATE_QUEUE_COMPLETE' }] } })
    expect(assistant.event).toMatchObject({ role: 'message', author: { kind: 'agent', agentSessionId: 'recipient' } })
    expect(assistant.event.content).toContainEqual(expect.objectContaining({ recordId: nativeAnswer.id,
      selector: { kind: 'native-part', partIndex: 0 }, placement: 'body' }))
    const targetEnv = objectCliEnvironment(root, { AGENTMUX_AGENT_SESSION_ID: 'recipient', AGENTMUX_AGENT_CAPABILITY: recipientIdentity.capability })
    const read = await runSourceObjectCli(['--endpoint', 'unix://' + server.path, 'message', 'read', '--message-id', mid], targetEnv)
    expect(read.code, read.stderr).toBe(0); expect(JSON.parse(read.stdout).result.message.envelope.body).toBe(body)
    const senderEnv = objectCliEnvironment(root, { AGENTMUX_AGENT_SESSION_ID: 'sender', AGENTMUX_AGENT_CAPABILITY: sourceIdentity.capability })
    const events = await runSourceObjectCli(['--endpoint', 'unix://' + server.path, 'message', 'events', '--message-id', mid], senderEnv)
    expect(events.code, events.stderr).toBe(0)
    expect(JSON.parse(events.stdout).result.events.some((event: any) => event.kind === 'a2a-notification-result')).toBe(true)
    expect((await client.statusAgent('recipient')).run.acceptedInputBytes).toBe(original.run.acceptedInputBytes)
    expect((await new AgentMuxFileAgentSessionStore(storePath).readMetadata('recipient'))?.nativeActor).toBeUndefined()
  } catch (error) { errors.push(error) }
  finally {
    await sender?.dispose(); await server?.stop()
    if (client) {
      for (const session of sessions) try { await client.stopAgent(session.agentSessionId, session.run) } catch (error) { errors.push(error) }
      try { await client.dispose() } catch (error) { errors.push(error) }
    }
    if (activation) try {
      const runs = await activation.client.list()
      for (const run of runs) { if (run.state.type === 'running') await activation.client.stop(await activation.client.prepareStop(run.id)); await activation.client.remove(run.id) }
      expect(await activation.client.list()).toEqual([])
      await activation.shutdown(); await activation.dispose()
    } catch (error) { errors.push(error) }
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => endpoint.close(() => resolve()))
    if (!errors.length) await rm(root, { recursive: true })
  }
  if (errors.length) throw new AggregateError(errors, 'Actual private native Runtime proof or original cleanup failed:\n' +
    errors.map(error => error instanceof Error ? error.stack ?? error.message : String(error)).join('\n'))
}, 90_000)
