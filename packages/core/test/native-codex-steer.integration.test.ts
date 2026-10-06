import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, AgentProviderRegistry, hashAgentCapability, issueAgentCapability } from '../dist/index.js'
import { AgentMuxControlServer } from '../dist/public-rpc-server.js'
import { connectAgentMuxRpc } from '../dist/public-rpc-client.js'
import { openNativeSocketChannel } from '../dist/agent-native-socket.js'
import { nativeProcessFiles } from '../dist/agent-native-process.js'
import { codexNativePromptReceipt } from '../dist/providers/codex-native-prompt.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

afterEach(() => vi.unstubAllEnvs())
const binary = process.env.AGENTMUX_NATIVE_CODEX_BINARY

async function waitFor<T>(read: () => Promise<T>, accepts: (value: T) => boolean, budget = 15_000): Promise<T> {
  const deadline = Date.now() + budget
  do { const value = await read(); if (accepts(value)) return value; await new Promise(resolve => setTimeout(resolve, 30)) } while (Date.now() < deadline)
  throw new Error('Private Native fixture did not observe its required machine fact')
}

// Test-only owners, held since creation. Cleanup never discovers PIDs or follows
// a replacement pathname, and a cleanup failure preserves the primary assertion.
async function closePrivateFixture(root: string, identity: { dev: bigint; ino: bigint }, daemon: ChildProcess,
  daemonClosed: Promise<[number | null, NodeJS.Signals | null]>,
  actions: { owner: string; close: () => unknown | Promise<unknown> }[], primary?: { error: unknown }): Promise<void> {
  const failures: unknown[] = [], receipts: { owner: string; result: 'closed' | 'unknown' }[] = []
  const attempt = async (owner: string, close: () => unknown | Promise<unknown>, budget = 5000): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([Promise.resolve().then(close), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Private fixture cleanup observation timed out: ' + owner)), budget)
      })])
      receipts.push({ owner, result: 'closed' })
    } catch (error) { failures.push(error); receipts.push({ owner, result: 'unknown' }) }
    finally { clearTimeout(timer) }
  }
  for (const action of actions) await attempt(action.owner, action.close)
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined
  await attempt('original-daemon-child', async () => {
    let escalation: ReturnType<typeof setTimeout> | undefined
    try {
      if (daemon.exitCode === null && daemon.signalCode === null) {
        daemon.kill('SIGTERM')
        escalation = setTimeout(() => { if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill('SIGKILL') }, 2000)
      }
      const [code, signal] = await daemonClosed
      exit = { code, signal }
    } finally { clearTimeout(escalation) }
  })
  let directoryRemoved = false
  if (exit && failures.length === 0) await attempt('original-fixture-directory', async () => {
    const current = await lstat(root, { bigint: true })
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) {
      throw new Error('The private fixture directory identity changed; the current path is retained.')
    }
    await rm(root, { recursive: true }); directoryRemoved = true
  })
  console.log(JSON.stringify({ schema: 'agentmux.native-fixture-exit.v1', originalDaemonPid: daemon.pid,
    exit: exit ?? { state: 'unknown' }, directoryIdentity: { dev: String(identity.dev), ino: String(identity.ino) },
    directoryRemoved, primaryFailureRetained: Boolean(primary), owners: receipts }))
  if (failures.length) throw new AggregateError([...(primary ? [primary.error] : []), ...failures],
    'Private Native fixture cleanup is unconfirmed; original evidence is retained.', { cause: primary?.error })
}

// Explicit opt-in test-owned real 0.162.1 backend + TUI in one original ctxmux Run.
// No user HOME/auth/MCP/Native data, no model network outside the loopback fixture.
it.runIf(Boolean(binary))('real original Native/TUI atomically starts idle manual input and appends busy input through SDK and public Send', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'am-native-')))
  const rootIdentity = await lstat(root, { bigint: true })
  const runtime = join(root, 'runtime'), workspace = join(root, 'workspace'), home = join(root, 'home'), nativeHome = join(root, 'codex')
  for (const path of [runtime, workspace, home, nativeHome]) await mkdir(path)
  const streams: import('node:http').ServerResponse[] = [], requests: { path: string; body: string }[] = []
  const model = createServer(async (request, response) => {
    let body = ''; for await (const bytes of request) body += bytes
    requests.push({ path: request.url ?? '', body })
    if (request.url?.endsWith('/responses')) {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      response.write('event: response.created\ndata: ' + JSON.stringify({ type: 'response.created', response: {
        id: 'private-' + requests.length, status: 'in_progress', object: 'response', output: [] } }) + '\n\n')
      streams.push(response)
    } else { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"data":[]}') }
  })
  model.listen(0, '127.0.0.1'); await once(model, 'listening')
  const port = (model.address() as import('node:net').AddressInfo).port
  const config = ['-c', 'model="private-model"', '-c', 'model_provider="private"', '-c', 'approval_policy="never"', '-c', 'sandbox_mode="read-only"',
    '-c', 'features.hooks=false', '-c', 'features.plugins=false', '-c', 'features.memories=false', '-c', 'features.chronicle=false',
    '-c', `model_providers.private={name="Private loopback",base_url="http://127.0.0.1:${port}/v1",wire_api="responses",requires_openai_auth=false,supports_websockets=false}`,
    '-c', `projects={${JSON.stringify(workspace)}={trust_level="trusted"}}`]
  const endpoint = join(root, 'native.sock'), wrapper = join(root, 'original-cli.mjs')
  await writeFile(wrapper, `#!/usr/bin/env node
import {spawn,spawnSync} from 'node:child_process';import {existsSync,appendFileSync} from 'node:fs';
const binary=${JSON.stringify(binary)},root=${JSON.stringify(root)},endpoint=${JSON.stringify(endpoint)},args=process.argv.slice(2);
if(args.includes('--version')){const r=spawnSync(binary,['--version'],{stdio:'inherit'});process.exit(r.status??1)}
const env={...process.env,HOME:${JSON.stringify(home)},CODEX_HOME:${JSON.stringify(nativeHome)}};
const backend=spawn(binary,['app-server','--listen','unix://'+endpoint,...${JSON.stringify(config)}],{env,stdio:['ignore','ignore','pipe']});
backend.stderr.on('data',b=>appendFileSync(root+'/backend.log',b));
for(let n=0;!existsSync(endpoint)&&n<500;n++)await new Promise(r=>setTimeout(r,10));if(!existsSync(endpoint))process.exit(2);
const tui=spawn(binary,['--no-alt-screen','-C',${JSON.stringify(workspace)},...args],{env,stdio:'inherit'});
appendFileSync(root+'/pids.json',JSON.stringify({root:process.pid,backend:backend.pid,tui:tui.pid}));
const stop=()=>{tui.kill('SIGTERM');backend.kill('SIGTERM')};process.on('SIGTERM',stop);process.on('SIGINT',stop);
tui.on('close',()=>{backend.kill('SIGTERM');process.exit()});
`, { mode: 0o700 })
  for (const key of Object.keys(process.env).filter(key => /^(AGENTMUX_|CTXMUX_)/u.test(key))) vi.stubEnv(key, undefined)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', runtime); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
  vi.stubEnv('AGENTMUX_AGENT_SESSION_STORE', join(root, 'sessions.json')); vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  const daemon = spawn(fileURLToPath(new URL('../vendor/ctxmux/darwin-arm64/bin/ctxmuxd', import.meta.url)), [
    '--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(root, 'daemon'), '--readiness-fd', '3'
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
  daemon.stderr!.resume(); const daemonClosed = once(daemon, 'close') as Promise<[number | null, NodeJS.Signals | null]>
  // Hook ownership/activation is a different closure; only that installation contribution
  // is omitted here. Native discovery, machine qualification and dispatch are Builtin.
  const builtin = new AgentProviderRegistry().get('codex')
  const preparations: { durationMs: number; phases: { phase: string; durationMs: number }[] }[] = []
  const nativeDispatchIds: string[] = []
  let beforeCurrent: ((check: number) => Promise<void>) | undefined
  let notifyProtocol: (() => void) | undefined
  let loseReceiptFor: string | undefined
  const provider = { ...builtin, planManagedHooks: () => null,
    prepareNativePromptInput: async (context: Parameters<NonNullable<typeof builtin.prepareNativePromptInput>>[0]) => {
      const start = performance.now(), phases: { phase: string; durationMs: number }[] = []
      let previous = start, current = 'entry'
      try { const prepared = await builtin.prepareNativePromptInput!({ ...context, onPreparationPhase: phase => {
        const now = performance.now(); phases.push({ phase: current, durationMs: now - previous }); current = phase; previous = now
        context.onPreparationPhase?.(phase); if (phase === 'native-protocol') notifyProtocol?.()
      } }); let checks = 0
        return { ...prepared, assertCurrent: async signal => { await beforeCurrent?.(++checks); await prepared.assertCurrent(signal) },
          dispatch: async (prompt, operationId, signal) => {
            nativeDispatchIds.push(operationId)
            const receipt = await prepared.dispatch(prompt, operationId, signal)
            if (operationId === loseReceiptFor) {
              expect(receipt.outcome).toBe('admitted')
              // Exact Provider→Core receipt-loss boundary after the real actor
              // accepted this input; no vendor response or consumption is faked.
              throw new Error('Private Provider receipt lost after real Native admission')
            }
            return receipt
          } }
      } finally { phases.push({ phase: current, durationMs: performance.now() - previous }); preparations.push({ durationMs: performance.now() - start, phases }) }
    } }
  // A real bounded Core credential producer; it claims no Native protocol facts.
  const senderProvider = { ...builtin, id: 'private-sender', label: 'Private Core sender', executable: process.execPath,
    catalog: { ...builtin.catalog, id: 'private-sender', label: 'Private Core sender', executable: process.execPath, expectedProcess: 'node',
      hookStrategy: { kind: 'none' as const }, resumeStrategy: { kind: 'none' as const },
      capabilities: { terminal: true as const, timeline: 'unavailable' as const, permission: 'none' as const, providerResume: false, replyCorrelation: 'none' as const } },
    buildLaunch: (context: Parameters<typeof builtin.buildLaunch>[0]) => ({ command: process.execPath, args: [...context.args], env: context.env }),
    planManagedHooks: undefined, discoverNativeSession: undefined, observeSessionStatus: undefined, prepareNativePromptInput: undefined,
    terminalHandshake: undefined, terminalPromptRender: undefined }
  const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
  let beforeAuthorSwap: ((...args: Parameters<typeof store.compareAndSwapMetadata>) => Promise<void>) | undefined
  const swap = store.compareAndSwapMetadata.bind(store)
  store.compareAndSwapMetadata = async (...args) => { await beforeAuthorSwap?.(...args); await swap(...args) }
  const externalStore = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
  let client: AgentMuxClient
  try { client = new AgentMuxClient({ providers: [provider, senderProvider], store }) }
  catch (error) {
    await closePrivateFixture(root, rootIdentity, daemon, daemonClosed, [{ owner: 'original-loopback-model', close: async () => {
      for (const stream of streams) stream.destroy(); model.closeAllConnections()
      await new Promise<void>((resolve, reject) => model.close(error => error ? reject(error) : resolve()))
    } }], { error })
    throw error
  }
  const senders: ReturnType<AgentMuxClient['agentSession']>[] = []
  const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
  let outputThrough = Promise.resolve()
  client.onEvent(event => { if (event.type === 'terminal-output') outputThrough = outputThrough.then(async () => await new Promise<void>(resolve => terminal.write(event.data ?? '', resolve))) })
  const screen = async () => { await outputThrough; return Array.from({ length: terminal.rows }, (_, row) => terminal.buffer.active.getLine(terminal.buffer.active.viewportY + row)?.translateToString(true) ?? '').join('\n') }
  let session: ReturnType<AgentMuxClient['agentSession']> | undefined
  const control = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), coreClients: () => [{ hostId: 'local', client }] })
  let rpc: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined, channel: Awaited<ReturnType<typeof openNativeSocketChannel>> | undefined
  let primaryFailure: { error: unknown } | undefined
  try {
    await once(daemon.stdio[3]!, 'data'); await client.connect()
    session = await client.createAgent({ agentSessionId: 'private-native', createOperationId: 'private-create', providerId: 'codex', executorId: 'codex',
      workspacePath: workspace, commandOverride: wrapper, args: ['--remote', 'unix://' + endpoint], env: { HOME: home, CODEX_HOME: nativeHome },
      injectAgentMuxGuide: false, prompt: 'Remain busy on this private test. Do not use tools.' })
    await client.reattachAgent(session.agentSessionId, 0)
    session = await waitFor(async () => await client.refreshAgentSession('private-native', session!.run), current => Boolean(current.nativeHandle && requests.some(request => request.path.endsWith('/responses'))))
    // Initial launch kept its original one-actor contract; Native immediate did not
    // replace creation or create a second backend. Its original prompt reached the model.
    expect(requests.some(request => JSON.stringify(request).includes('Remain busy on this private test.'))).toBe(true)
    const original = session.run, pids = JSON.parse(await readFile(join(root, 'pids.json'), 'utf8')) as { root: number; backend: number; tui: number }
    expect((await client.statusAgent(session.agentSessionId)).run.pid).toBe(pids.root)
    await client.writeAgent({ agentSessionId: session.agentSessionId, expectedRun: original, source: 'user', data: 'PRIVATE-DRAFT-KEEP' })
    await waitFor(screen, text => text.includes('PRIVATE-DRAFT-KEEP'))
    const before = (await client.statusAgent(session.agentSessionId)).run
    await control.start(); rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(root, 'control.sock') } })
    const cli = await runCompiledObjectCli(['--endpoint', 'unix://' + join(root, 'control.sock'), 'agent', 'send', '--to-session', session.agentSessionId,
      '--text', 'PRIVATE-NATIVE-STEER', '--execution', 'immediate', '--operation-id', 'native-exact-steer'], objectCliEnvironment(root, {}), '', 50_000)
    expect(cli.code, cli.stderr).toBe(0)
    const delivered = JSON.parse(cli.stdout).result as { messageId: string }
    const admission = client.agentSession(session.agentSessionId).promptCompletionAdmission!
    expect(admission).toMatchObject({ transport: 'native', submissionId: delivered.messageId, native: { outcome: 'admitted' }, intent: { execution: 'immediate', message: { authorHuman: true } } })
    expect(admission).not.toHaveProperty('startByte'); expect(admission).not.toHaveProperty('endByte')
    const after = (await client.statusAgent(session.agentSessionId)).run
    expect(after).toMatchObject({ runId: original.runId, pid: pids.root, state: 'running', acceptedInputBytes: before.acceptedInputBytes })
    expect(await screen()).toContain('PRIVATE-DRAFT-KEEP')
    const records = () => readFile(session!.nativeHandle!.kind === 'provider' ? session!.nativeHandle!.transcriptPath! : '', 'utf8').then(text => text.split('\n').filter(Boolean).map(line => JSON.parse(line)))
    const consumed = await waitFor(records, values => values.some(value => value.payload?.item?.client_id === delivered.messageId))
    const item = consumed.filter(value => value.payload?.item?.client_id === delivered.messageId)
    expect(item).toHaveLength(1); expect(item[0].payload.turn_id).toBe(admission.native!.turnId)
    await expect(rpc.call('agent.send', { target: { kind: 'agent-session', agentSessionId: session.agentSessionId }, text: 'PRIVATE-NATIVE-STEER',
      sourceChannel: 'cli', execution: 'immediate', operationId: 'native-exact-steer' })).resolves.toMatchObject({ messageId: delivered.messageId })
    expect((await records()).filter(value => value.payload?.item?.client_id === delivered.messageId)).toHaveLength(1)
    let protocolReady!: () => void
    const ready = new Promise<void>(resolve => { protocolReady = resolve }); notifyProtocol = protocolReady
    const secondStarted = performance.now()
    const secondPromise = runCompiledObjectCli(['--endpoint', 'unix://' + join(root, 'control.sock'), 'agent', 'send', '--to-session', session.agentSessionId,
      '--text', 'PRIVATE-NATIVE-SECOND', '--execution', 'immediate', '--operation-id', 'native-exact-second'], objectCliEnvironment(root, {}), '', 50_000)
    await ready; notifyProtocol = undefined
    const rawStarted = performance.now()
    // Exact focus-in terminal protocol bytes, no submitted text or recall. Raw is
    // available while this second message qualifies the immutable mapped image.
    await client.writeAgent({ agentSessionId: session.agentSessionId, expectedRun: original, source: 'terminal-protocol', data: '\x1b[I' })
    const rawAckMs = performance.now() - rawStarted, second = await secondPromise, secondSendMs = performance.now() - secondStarted
    expect(second.code, second.stderr).toBe(0)
    const secondMessage = JSON.parse(second.stdout).result as { messageId: string }
    const secondAdmission = client.agentSession(session.agentSessionId).promptCompletionAdmission!
    expect(secondAdmission.native?.plan).toMatchObject({ actorId: admission.native!.plan.actorId, threadId: admission.native!.plan.threadId, operation: 'start-or-steer' })
    expect(secondAdmission.native?.turnId).toBe(admission.native!.turnId)
    const secondConsumed = await waitFor(records, values => values.some(value => value.payload?.item?.client_id === secondMessage.messageId))
    expect(secondConsumed.filter(value => value.payload?.item?.client_id === secondMessage.messageId)).toHaveLength(1)
    expect((await client.statusAgent(session.agentSessionId)).run.acceptedInputBytes).toBe(after.acceptedInputBytes! + 3)
    expect(await screen()).toContain('PRIVATE-DRAFT-KEEP')
    // Real method-specific negatives from the same mapped Native image/manager.
    channel = await openNativeSocketChannel(pids.root, await realpath(endpoint), AbortSignal.timeout(4000))
    expect(channel.binding).toMatchObject({ tuiPid: pids.tui, peerPid: pids.backend })
    await channel.request('initialize', { clientInfo: { name: 'agentmux_private_verifier', version: '1' }, capabilities: { experimentalApi: true } }); channel.notify('initialized')
    const stale = await channel.request('turn/start', { threadId: 'not-a-thread', clientUserMessageId: 'stale-must-not-queue', input: [{ type: 'text', text: 'stale', text_elements: [] }] })
    expect(stale.error?.code).toBe(-32600)
    expect(codexNativePromptReceipt(stale)).toEqual({ outcome: 'not-applied', errorCode: -32600 })
    expect((await records()).some(value => value.payload?.item?.client_id === 'stale-must-not-queue')).toBe(false)
    const invalid = await channel.request('turn/start', { threadId: admission.native!.plan.threadId, clientUserMessageId: 'invalid-must-not-queue',
      permissionProfile: 'obsolete-field', input: [{ type: 'text', text: 'invalid', text_elements: [] }] })
    expect(invalid.error?.code).toBe(-32602)
    expect(codexNativePromptReceipt(invalid)).toEqual({ outcome: 'not-applied', errorCode: -32602 })
    expect((await records()).some(value => value.payload?.item?.client_id === 'invalid-must-not-queue')).toBe(false)
    const internal = await channel.request('turn/start', { threadId: admission.native!.plan.threadId,
      clientUserMessageId: 'internal-not-a-negative-receipt', input: [] })
    expect(internal.error?.code).toBe(-32603)
    expect(codexNativePromptReceipt(internal)).toEqual({ outcome: 'unknown', errorCode: -32603 })
    expect((await records()).some(value => value.payload?.item?.client_id === 'internal-not-a-negative-receipt')).toBe(false)
    const ambiguityProof: { stage: string; oldThread: string; otherThread: string; dispatched: number }[] = []
    const originalTranscript = session.nativeHandle!.kind === 'provider' ? session.nativeHandle!.transcriptPath! : ''
    const otherUserRoot = async () => {
      const started = await channel!.request('thread/start', { cwd: workspace, model: 'private-model', modelProvider: 'private',
        approvalPolicy: 'never', sandbox: 'read-only', threadSource: 'user' })
      expect(started.error).toBeUndefined()
      const other = (started.result as { thread: { id: string; path: string } }).thread
      expect(other.id).not.toBe(admission.native!.plan.threadId)
      const running = await channel!.request('turn/start', { threadId: other.id, clientUserMessageId: 'private-other-' + other.id,
        input: [{ type: 'text', text: 'Remain busy on this other private root. Do not use tools.', text_elements: [] }] })
      expect(running.error).toBeUndefined()
      const files = await waitFor(() => nativeProcessFiles(pids.backend, AbortSignal.timeout(4000), 'process'),
        values => values.some(file => file.path === other.path && (file.access === 'w' || file.access === 'u')))
      expect(files.some(file => file.path === originalTranscript && (file.access === 'w' || file.access === 'u'))).toBe(true)
      const header = JSON.parse((await readFile(other.path, 'utf8')).split('\n')[0]!)
      expect(header.payload).toMatchObject({ id: other.id, source: 'vscode', thread_source: 'user' })
      const originalThread = await channel!.request('thread/read', { threadId: admission.native!.plan.threadId, includeTurns: false })
      expect(originalThread.result).toMatchObject({ thread: { id: admission.native!.plan.threadId, status: { type: 'active' } } })
      return other
    }
    // A second genuine user root arrives after preparation, both before durable
    // claim and after claim. The original thread remains active and writable.
    for (const check of [1, 2]) {
      let other: { id: string; path: string } | undefined
      beforeCurrent = async current => { if (current === check) other = await otherUserRoot() }
      const dispatchCount = nativeDispatchIds.length, rawBefore = (await client.statusAgent(session.agentSessionId)).run.acceptedInputBytes!
      try {
        const refused = await runCompiledObjectCli(['--endpoint', 'unix://' + join(root, 'control.sock'), 'agent', 'send', '--to-session', session.agentSessionId,
          '--text', 'AMBIGUOUS-MUST-NOT-QUEUE-' + check, '--execution', 'immediate', '--operation-id', 'ambiguous-stage-' + check], objectCliEnvironment(root, {}), '', 50_000)
        expect(refused.code).not.toBe(0); expect(refused.stderr).toContain(check === 1 ? 'AGENT_NATIVE_INPUT_WAITING' : 'AGENT_NATIVE_INPUT_UNCONFIRMED')
        expect(nativeDispatchIds).toHaveLength(dispatchCount)
        expect((await records()).some(value => JSON.stringify(value.payload?.item ?? null).includes('AMBIGUOUS-MUST-NOT-QUEUE-' + check))).toBe(false)
        expect(other).toBeDefined()
        if (check === 2) expect(client.agentSession(session.agentSessionId).promptCompletionAdmission).toMatchObject({ transport: 'native', notApplied: true, native: { outcome: 'not-applied' } })
        await client.writeAgent({ agentSessionId: session.agentSessionId, expectedRun: original, source: 'terminal-protocol', data: '\x1b[I' })
        expect((await client.statusAgent(session.agentSessionId)).run).toMatchObject({ runId: original.runId, pid: pids.root, state: 'running', acceptedInputBytes: rawBefore + 3 })
        ambiguityProof.push({ stage: check === 1 ? 'before-claim' : 'after-claim', oldThread: admission.native!.plan.threadId, otherThread: other!.id, dispatched: nativeDispatchIds.length - dispatchCount })
      } finally {
        beforeCurrent = undefined
        if (other) {
          expect((await channel.request('thread/archive', { threadId: other.id })).error).toBeUndefined()
          await waitFor(() => nativeProcessFiles(pids.backend, AbortSignal.timeout(4000), 'process'), values => !values.some(file => file.path === other!.path && (file.access === 'w' || file.access === 'u')))
        }
      }
    }
    const transcript = session.nativeHandle!.kind === 'provider' ? session.nativeHandle!.transcriptPath! : ''
    const header = (await readFile(transcript)).subarray(0, (await readFile(transcript)).indexOf(10))
    const roleOffset = header.indexOf(Buffer.from('"thread_source":"user"')) + Buffer.byteLength('"thread_source":"')
    expect(roleOffset).toBeGreaterThan(Buffer.byteLength('"thread_source":"'))
    // Mutate only the four role bytes on this test-owned original writer file. SID,
    // inode, peer and active Native thread stay unchanged; no append is overwritten.
    const roleFile = await open(transcript, 'r+')
    try {
      await roleFile.write(Buffer.from('xxxx'), 0, 4, roleOffset)
      const refusedRole = await runCompiledObjectCli(['--endpoint', 'unix://' + join(root, 'control.sock'), 'agent', 'send', '--to-session', session.agentSessionId,
        '--text', 'ROLE-MUST-NOT-QUEUE', '--execution', 'immediate', '--operation-id', 'role-must-stay-kept'], objectCliEnvironment(root, {}), '', 50_000)
      expect(refusedRole.code).not.toBe(0); expect(refusedRole.stderr).toContain('AGENT_NATIVE_INPUT_WAITING')
      expect((await records()).some(value => JSON.stringify(value.payload?.item ?? null).includes('ROLE-MUST-NOT-QUEUE'))).toBe(false)
    } finally { await roleFile.write(Buffer.from('user'), 0, 4, roleOffset); await roleFile.close() }
    await channel.request('turn/interrupt', { threadId: admission.native!.plan.threadId, turnId: admission.native!.turnId })
    await waitFor(async () => await channel!.request('thread/read', { threadId: admission.native!.plan.threadId, includeTurns: false }),
      response => (response.result as { thread?: { status?: { type?: string } } })?.thread?.status?.type === 'idle')
    const sdkCondition = client.agentSession(session.agentSessionId).promptCompletionAdmission?.submissionId ?? null
    const sdkRaw = (await client.statusAgent(session.agentSessionId)).run.acceptedInputBytes
    await expect(client.submitAgentPrompt({ agentSessionId: session.agentSessionId, expectedRun: original, afterSubmissionId: sdkCondition,
      operationId: 'native-sdk-idle', prompt: 'PRIVATE-SDK-IDLE', agentMuxNote: 'Private original SDK context.', authorHuman: true,
      sourceChannel: 'api', execution: 'immediate', allowUncertainTurn: true })).resolves.toBeUndefined()
    const sdkAdmission = client.agentSession(session.agentSessionId).promptCompletionAdmission!
    expect(sdkAdmission).toMatchObject({ transport: 'native', submissionId: 'native-sdk-idle', native: { outcome: 'admitted',
      plan: { operation: 'start-or-steer', actorId: admission.native!.plan.actorId, threadId: admission.native!.plan.threadId } },
      intent: { message: { userContent: 'PRIVATE-SDK-IDLE', systemContext: 'Private original SDK context.', authorHuman: true, sourceChannel: 'api' } } })
    expect(sdkAdmission.native!.turnId).not.toBe(admission.native!.turnId)
    const sdkRecords = await waitFor(records, values => values.some(value => value.payload?.item?.client_id === 'native-sdk-idle'))
    expect(sdkRecords.filter(value => value.payload?.item?.client_id === 'native-sdk-idle')).toHaveLength(1)
    expect(sdkRecords.find(value => value.payload?.item?.client_id === 'native-sdk-idle')?.payload.item.content)
      .toEqual([{ type: 'text', text: sdkAdmission.intent!.prompt, text_elements: [] }])
    const inspected = await rpc.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: session.agentSessionId } })
    expect(inspected.session.promptCompletionAdmission).toMatchObject({ submissionId: 'native-sdk-idle', native: { outcome: 'admitted',
      plan: { operation: 'start-or-steer', threadId: admission.native!.plan.threadId }, turnId: sdkAdmission.native!.turnId } })
    expect((await client.statusAgent(session.agentSessionId)).run.acceptedInputBytes).toBe(sdkRaw)
    await client.submitAgentPrompt({ agentSessionId: session.agentSessionId, expectedRun: original, afterSubmissionId: sdkCondition,
      operationId: 'native-sdk-idle', prompt: 'PRIVATE-SDK-IDLE', agentMuxNote: 'Private original SDK context.', authorHuman: true,
      sourceChannel: 'api', execution: 'immediate', allowUncertainTurn: true })
    expect((await records()).filter(value => value.payload?.item?.client_id === 'native-sdk-idle')).toHaveLength(1)
    await channel.request('turn/interrupt', { threadId: admission.native!.plan.threadId, turnId: sdkAdmission.native!.turnId })
    await waitFor(async () => await channel!.request('thread/read', { threadId: admission.native!.plan.threadId, includeTurns: false }),
      response => (response.result as { thread?: { status?: { type?: string } } })?.thread?.status?.type === 'idle')
    const idleImmediate = await runCompiledObjectCli(['--endpoint', 'unix://' + join(root, 'control.sock'), 'agent', 'send', '--to-session', session.agentSessionId,
      '--text', 'IDLE-IMMEDIATE-DELIVERED', '--execution', 'immediate', '--operation-id', 'idle-immediate-delivered'], objectCliEnvironment(root, {}), '', 50_000)
    expect(idleImmediate.code, idleImmediate.stderr).toBe(0)
    const idleMessage = JSON.parse(idleImmediate.stdout).result as { messageId: string }
    const idleAdmission = client.agentSession(session.agentSessionId).promptCompletionAdmission!
    expect(idleAdmission.native?.outcome).toBe('admitted')
    expect(idleAdmission.native?.turnId).not.toBe(sdkAdmission.native?.turnId)
    const idleRecords = await waitFor(records, values => values.some(value => value.payload?.item?.client_id === idleMessage.messageId))
    expect(idleRecords.filter(value => value.payload?.item?.client_id === idleMessage.messageId)).toHaveLength(1)
    expect((await client.statusAgent(session.agentSessionId)).run.acceptedInputBytes).toBe(sdkRaw)
    expect((await client.statusAgent(session.agentSessionId)).run).toMatchObject({ runId: original.runId, pid: pids.root, state: 'running' })
    expect(await screen()).toContain('PRIVATE-DRAFT-KEEP')
    const senderScript = join(root, 'sender.mjs')
    await writeFile(senderScript, `import {writeFileSync} from 'node:fs';
writeFileSync(process.argv[2],JSON.stringify({agentSessionId:process.env.AGENTMUX_AGENT_SESSION_ID,capability:process.env.AGENTMUX_AGENT_CAPABILITY}),{mode:0o600});
setInterval(()=>{},1000);process.on('SIGTERM',()=>process.exit());\n`)
    const newSender = async (id: string) => {
      const credentialsPath = join(root, id + '.json')
      const sender = await client.createAgent({ agentSessionId: id, createOperationId: 'create-' + id, providerId: 'private-sender', executorId: 'private-sender',
        workspacePath: workspace, args: [senderScript, credentialsPath], env: { HOME: home }, injectAgentMuxGuide: false })
      senders.push(sender)
      const credentials = await waitFor(async () => JSON.parse(await readFile(credentialsPath, 'utf8').catch(() => '{}')) as { agentSessionId?: string; capability?: string },
        value => value.agentSessionId === sender.agentSessionId && typeof value.capability === 'string')
      return { sender, credentials: credentials as { agentSessionId: string; capability: string } }
    }
    const validAuthor = await newSender('private-valid-author')
    const authored = await runCompiledObjectCli(['--endpoint', 'unix://' + join(root, 'control.sock'), 'agent', 'send', '--to-session', session.agentSessionId,
      '--text', 'PRIVATE-AUTHORED-INPUT', '--execution', 'immediate', '--operation-id', 'author-control-operation', '--message-id', 'author-message-input'],
      objectCliEnvironment(root, { AGENTMUX_AGENT_SESSION_ID: validAuthor.credentials.agentSessionId, AGENTMUX_AGENT_CAPABILITY: validAuthor.credentials.capability }), '', 50_000)
    expect(authored.code, authored.stderr).toBe(0)
    const authorRecords = await waitFor(records, values => values.some(value => value.payload?.item?.client_id === 'author-message-input'))
    expect(authorRecords.filter(value => value.payload?.item?.client_id === 'author-message-input')).toHaveLength(1)
    const authoredItem = authorRecords.find(value => value.payload?.item?.client_id === 'author-message-input')?.payload.item
    expect(authoredItem.content, JSON.stringify(authoredItem)).toEqual([{ type: 'text', text: '[Message from Agent private-valid-author]\nPRIVATE-AUTHORED-INPUT', text_elements: [] }])
    expect(client.agentSession(session.agentSessionId).promptCompletionAdmission).toMatchObject({ submissionId: 'author-message-input',
      native: { outcome: 'admitted' }, intent: { message: { authorAgentSessionId: 'private-valid-author' } } })
    const authorProof: { stage: string; dispatched: number; inputId: string }[] = []
    for (const phase of ['before-claim', 'before-dispatch'] as const) {
      const value = await newSender('private-author-' + phase), inputId = 'author-refused-' + phase
      let revoked = false
      beforeAuthorSwap = async (expected, next) => {
        // Fault selection uses the exact original recipient/input/stage. It does
        // not depend on the author fence parameter whose omission is tested.
        if (revoked || next?.agentSessionId !== session!.agentSessionId || next?.promptCompletionAdmission?.submissionId !== inputId) return
        const alreadyClaimed = expected?.promptCompletionAdmission?.submissionId === inputId
        if (alreadyClaimed !== (phase === 'before-dispatch')) return
        // The original authority changes through another durable owner at the
        // final persistence await. No Native/recipient receipt is fabricated.
        const originalAuthor = await externalStore.readMetadata(value.sender.agentSessionId)
        expect(originalAuthor).not.toBeNull()
        await externalStore.compareAndSwapMetadata(originalAuthor, { ...originalAuthor!, capabilityHash: hashAgentCapability(issueAgentCapability()), updatedAt: originalAuthor!.updatedAt + 1 })
        revoked = true
        console.log(JSON.stringify({ schema: 'agentmux.native-authority-fault.v1', stage: phase, inputId,
          originalAuthorSessionId: value.sender.agentSessionId, persistedAuthorityChanged: true }))
      }
      const dispatchCount = nativeDispatchIds.length
      try {
        const refused = await runCompiledObjectCli(['--endpoint', 'unix://' + join(root, 'control.sock'), 'agent', 'send', '--to-session', session.agentSessionId,
          '--text', 'AUTHORITY-MUST-NOT-QUEUE-' + phase, '--execution', 'immediate', '--operation-id', 'control-' + inputId, '--message-id', inputId],
          objectCliEnvironment(root, { AGENTMUX_AGENT_SESSION_ID: value.credentials.agentSessionId, AGENTMUX_AGENT_CAPABILITY: value.credentials.capability }), '', 50_000)
        if (refused.code === 0) await waitFor(records, values => values.some(record => record.payload?.item?.client_id === inputId))
        console.log(JSON.stringify({ schema: 'agentmux.native-authority-result.v1', stage: phase, inputId, persistedAuthorityChanged: revoked,
          dispatches: nativeDispatchIds.length - dispatchCount, nativeInputItems: (await records()).filter(record => record.payload?.item?.client_id === inputId).length, cliExit: refused.code }))
        expect(refused.code).not.toBe(0)
        expect(refused.stderr).toContain(phase === 'before-claim' ? 'AGENT_CAPABILITY_INVALID' : 'AGENT_NATIVE_INPUT_UNCONFIRMED')
        expect(revoked).toBe(true); expect(nativeDispatchIds).toHaveLength(dispatchCount)
        expect((await records()).some(record => record.payload?.item?.client_id === inputId)).toBe(false)
        if (phase === 'before-dispatch') expect(client.agentSession(session.agentSessionId).promptCompletionAdmission).toMatchObject({ submissionId: inputId, notApplied: true, native: { outcome: 'not-applied' } })
        expect((await client.statusAgent(value.sender.agentSessionId)).run.state).toBe('running')
        const raw = (await client.statusAgent(session.agentSessionId)).run.acceptedInputBytes!
        await client.writeAgent({ agentSessionId: session.agentSessionId, expectedRun: original, source: 'terminal-protocol', data: '\x1b[I' })
        expect((await client.statusAgent(session.agentSessionId)).run.acceptedInputBytes).toBe(raw + 3)
        authorProof.push({ stage: phase, dispatched: nativeDispatchIds.length - dispatchCount, inputId })
      } finally { beforeAuthorSwap = undefined }
    }
    loseReceiptFor = 'native-real-lost-receipt'
    const lostParams = { target: { kind: 'agent-session' as const, agentSessionId: session.agentSessionId }, text: 'PRIVATE-REAL-LOST-RECEIPT',
      sourceChannel: 'cli' as const, execution: 'immediate' as const, operationId: 'lost-receipt-control', messageId: loseReceiptFor }
    const lost = await runCompiledObjectCli(['--endpoint', 'unix://' + join(root, 'control.sock'), 'agent', 'send', '--to-session', session.agentSessionId,
      '--text', lostParams.text, '--execution', 'immediate', '--operation-id', lostParams.operationId, '--message-id', lostParams.messageId], objectCliEnvironment(root, {}), '', 50_000)
    expect(lost.code).not.toBe(0); expect(lost.stderr).toContain('AGENT_PROMPT_INPUT_UNCONFIRMED')
    expect(client.agentSession(session.agentSessionId).promptCompletionAdmission).toMatchObject({ submissionId: loseReceiptFor, notApplied: false, native: { outcome: 'unknown' } })
    expect(client.agentSession(session.agentSessionId).promptCompletionAdmission?.acknowledged).not.toBe(true)
    const lostRecords = await waitFor(records, values => values.some(value => value.payload?.item?.client_id === loseReceiptFor))
    expect(lostRecords.filter(value => value.payload?.item?.client_id === loseReceiptFor)).toHaveLength(1)
    const dispatchesAfterLoss = nativeDispatchIds.length, preparationsAfterLoss = preparations.length
    await expect(rpc.call('agent.send', lostParams)).rejects.toMatchObject({ code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
    expect(nativeDispatchIds).toHaveLength(dispatchesAfterLoss); expect(preparations).toHaveLength(preparationsAfterLoss)
    expect((await records()).filter(value => value.payload?.item?.client_id === loseReceiptFor)).toHaveLength(1)
    const unknownAdmission = client.agentSession(session.agentSessionId).promptCompletionAdmission
    expect((await externalStore.readMetadata(session.agentSessionId))?.promptCompletionAdmission).toEqual(unknownAdmission)
    const lostRaw = (await client.statusAgent(session.agentSessionId)).run.acceptedInputBytes!
    await client.writeAgent({ agentSessionId: session.agentSessionId, expectedRun: original, source: 'terminal-protocol', data: '\x1b[I' })
    expect((await client.statusAgent(session.agentSessionId)).run.acceptedInputBytes).toBe(lostRaw + 3)
    console.log(JSON.stringify({ schema: 'agentmux.native-steer-proof.v1', run: original, pids, binding: channel.binding, nativePlan: admission.native!.plan,
      nativeOutcome: admission.native!.outcome, clientId: delivered.messageId, consumedOnce: true, draftKept: true, ttyBytesUnchanged: true,
    invalidThreadErrorCode: stale.error?.code, invalidParamsErrorCode: invalid.error?.code, internalErrorCode: internal.error?.code,
    idleAdmissions: [{ inputId: 'native-sdk-idle', turnId: sdkAdmission.native?.turnId }, { inputId: idleMessage.messageId, turnId: idleAdmission.native?.turnId }], ambiguityProof, authorProof,
    lostReceiptProof: { boundary: 'Provider-to-Core after real Native admitted receipt', inputId: loseReceiptFor, outcome: 'unknown', consumedOnce: true, replayDispatches: nativeDispatchIds.length - dispatchesAfterLoss } }))
    console.log(JSON.stringify({ schema: 'agentmux.native-steer-cost.v1', preparations, secondSendMs, rawAckMs,
      independentMessagesConsumedOnce: [delivered.messageId, secondMessage.messageId], sameActor: true }))
  } catch (error) { primaryFailure = { error }; throw error }
  finally {
    await closePrivateFixture(root, rootIdentity, daemon, daemonClosed, [
      { owner: 'original-native-channel', close: async () => await channel?.close() },
      { owner: 'original-rpc-reader', close: async () => await rpc?.dispose() },
      { owner: 'original-control-server', close: async () => await control.stop() },
      ...senders.map(sender => ({ owner: 'original-sender-' + sender.agentSessionId, close: async () => await client.stopAgent(sender.agentSessionId, sender.run) })),
      { owner: 'original-native-run', close: async () => { if (session) await client.stopAgent(session.agentSessionId, session.run) } },
      { owner: 'original-sdk-disposal', close: async () => await client.dispose() },
      { owner: 'original-terminal-consumer', close: () => terminal.dispose() },
      { owner: 'original-loopback-model', close: async () => {
        for (const stream of streams) stream.destroy(); model.closeAllConnections()
        await new Promise<void>((resolve, reject) => model.close(error => error ? reject(error) : resolve()))
      } }
    ], primaryFailure)
  }
}, 120_000)
