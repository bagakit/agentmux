import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, AgentProviderRegistry } from '../dist/index.js'
import { AgentMuxControlServer } from '../dist/public-rpc-server.js'
import { connectAgentMuxRpc } from '../dist/public-rpc-client.js'
import { openNativeSocketChannel } from '../dist/agent-native-socket.js'
import { nativeProcessFiles } from '../dist/agent-native-process.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

afterEach(() => vi.unstubAllEnvs())
const binary = process.env.AGENTMUX_NATIVE_CODEX_BINARY

async function waitFor<T>(read: () => Promise<T>, accepts: (value: T) => boolean, budget = 15_000): Promise<T> {
  const deadline = Date.now() + budget
  do { const value = await read(); if (accepts(value)) return value; await new Promise(resolve => setTimeout(resolve, 30)) } while (Date.now() < deadline)
  throw new Error('Private Native fixture did not observe its required machine fact')
}

// Explicit opt-in test-owned real 0.162.1 backend + TUI in one original ctxmux Run.
// No user HOME/auth/MCP/Native data, no model network outside the loopback fixture.
it.runIf(Boolean(binary))('real original Native/TUI consumes public Send, keeps draft, refuses stale turns and joins the same operation', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'am-native-')))
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
  daemon.stderr!.resume(); const daemonClosed = once(daemon, 'close')
  // Hook ownership/activation is a different closure; only that installation contribution
  // is omitted here. Native discovery, machine qualification and dispatch are Builtin.
  const builtin = new AgentProviderRegistry().get('codex')
  const preparations: { durationMs: number; phases: { phase: string; durationMs: number }[] }[] = []
  const nativeDispatchIds: string[] = []
  let beforeCurrent: ((check: number) => Promise<void>) | undefined
  let notifyProtocol: (() => void) | undefined
  const provider = { ...builtin, planManagedHooks: () => null,
    prepareNativePromptInput: async (context: Parameters<NonNullable<typeof builtin.prepareNativePromptInput>>[0]) => {
      const start = performance.now(), phases: { phase: string; durationMs: number }[] = []
      let previous = start, current = 'entry'
      try { const prepared = await builtin.prepareNativePromptInput!({ ...context, onPreparationPhase: phase => {
        const now = performance.now(); phases.push({ phase: current, durationMs: now - previous }); current = phase; previous = now
        context.onPreparationPhase?.(phase); if (phase === 'native-protocol') notifyProtocol?.()
      } }); let checks = 0
        return { ...prepared, assertCurrent: async signal => { await beforeCurrent?.(++checks); await prepared.assertCurrent(signal) },
          dispatch: async (prompt, operationId, signal) => { nativeDispatchIds.push(operationId); return await prepared.dispatch(prompt, operationId, signal) } }
      } finally { phases.push({ phase: current, durationMs: performance.now() - previous }); preparations.push({ durationMs: performance.now() - start, phases }) }
    } }
  const client = new AgentMuxClient({ providers: [provider], store: new AgentMuxFileAgentSessionStore(join(root, 'sessions.json')) })
  const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
  let outputThrough = Promise.resolve()
  client.onEvent(event => { if (event.type === 'terminal-output') outputThrough = outputThrough.then(async () => await new Promise<void>(resolve => terminal.write(event.data ?? '', resolve))) })
  const screen = async () => { await outputThrough; return Array.from({ length: terminal.rows }, (_, row) => terminal.buffer.active.getLine(terminal.buffer.active.viewportY + row)?.translateToString(true) ?? '').join('\n') }
  let session: ReturnType<AgentMuxClient['agentSession']> | undefined
  const control = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), coreClients: () => [{ hostId: 'local', client }] })
  let rpc: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined, channel: Awaited<ReturnType<typeof openNativeSocketChannel>> | undefined
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
    expect(secondAdmission.native?.plan).toMatchObject({ actorId: admission.native!.plan.actorId, threadId: admission.native!.plan.threadId, expectedTurnId: admission.native!.plan.expectedTurnId })
    const secondConsumed = await waitFor(records, values => values.some(value => value.payload?.item?.client_id === secondMessage.messageId))
    expect(secondConsumed.filter(value => value.payload?.item?.client_id === secondMessage.messageId)).toHaveLength(1)
    expect((await client.statusAgent(session.agentSessionId)).run.acceptedInputBytes).toBe(after.acceptedInputBytes! + 3)
    expect(await screen()).toContain('PRIVATE-DRAFT-KEEP')
    // Real stale-turn rejection from this same manager; it never falls back to turn/start.
    channel = await openNativeSocketChannel(pids.root, await realpath(endpoint), AbortSignal.timeout(4000))
    expect(channel.binding).toMatchObject({ tuiPid: pids.tui, peerPid: pids.backend })
    await channel.request('initialize', { clientInfo: { name: 'agentmux_private_verifier', version: '1' }, capabilities: { experimentalApi: true } }); channel.notify('initialized')
    const stale = await channel.request('turn/steer', { threadId: admission.native!.plan.threadId, expectedTurnId: 'wrong-turn', clientUserMessageId: 'stale-must-not-queue', input: [{ type: 'text', text: 'stale', textElements: [] }] })
    expect(stale.error?.code).toBe(-32600)
    expect((await records()).some(value => value.payload?.item?.client_id === 'stale-must-not-queue')).toBe(false)
    const ambiguityProof: { stage: string; oldThread: string; otherThread: string; dispatched: number }[] = []
    const originalTranscript = session.nativeHandle!.kind === 'provider' ? session.nativeHandle!.transcriptPath! : ''
    const otherUserRoot = async () => {
      const started = await channel!.request('thread/start', { cwd: workspace, model: 'private-model', modelProvider: 'private',
        approvalPolicy: 'never', sandbox: 'read-only', threadSource: 'user' })
      expect(started.error).toBeUndefined()
      const other = (started.result as { thread: { id: string; path: string } }).thread
      expect(other.id).not.toBe(admission.native!.plan.threadId)
      const running = await channel!.request('turn/start', { threadId: other.id, clientUserMessageId: 'private-other-' + other.id,
        input: [{ type: 'text', text: 'Remain busy on this other private root. Do not use tools.', textElements: [] }] })
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
        expect((await records()).some(value => value.payload?.item?.text === 'AMBIGUOUS-MUST-NOT-QUEUE-' + check)).toBe(false)
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
      expect((await records()).some(value => value.payload?.item?.text === 'ROLE-MUST-NOT-QUEUE')).toBe(false)
    } finally { await roleFile.write(Buffer.from('user'), 0, 4, roleOffset); await roleFile.close() }
    await channel.request('turn/interrupt', { threadId: admission.native!.plan.threadId, turnId: admission.native!.plan.expectedTurnId })
    await waitFor(async () => await channel!.request('thread/read', { threadId: admission.native!.plan.threadId, includeTurns: false }),
      response => (response.result as { thread?: { status?: { type?: string } } })?.thread?.status?.type === 'idle')
    const inactive = await channel.request('turn/steer', { threadId: admission.native!.plan.threadId, expectedTurnId: admission.native!.plan.expectedTurnId,
      clientUserMessageId: 'inactive-must-not-queue', input: [{ type: 'text', text: 'inactive', textElements: [] }] })
    expect(inactive.error?.code).toBe(-32600)
    expect((await records()).some(value => value.payload?.item?.client_id === 'inactive-must-not-queue')).toBe(false)
    const idleImmediate = await runCompiledObjectCli(['--endpoint', 'unix://' + join(root, 'control.sock'), 'agent', 'send', '--to-session', session.agentSessionId,
      '--text', 'IDLE-IMMEDIATE-KEPT', '--execution', 'immediate', '--operation-id', 'idle-immediate-retained'], objectCliEnvironment(root, {}), '', 50_000)
    expect(idleImmediate.code).not.toBe(0)
    expect(idleImmediate.stderr).toContain('AGENT_NATIVE_INPUT_WAITING')
    expect((await client.statusAgent(session.agentSessionId)).run).toMatchObject({ runId: original.runId, pid: pids.root, state: 'running' })
    expect((await records()).some(value => value.payload?.item?.text === 'IDLE-IMMEDIATE-KEPT')).toBe(false)
    expect(await screen()).toContain('PRIVATE-DRAFT-KEEP')
    console.log(JSON.stringify({ schema: 'agentmux.native-steer-proof.v1', run: original, pids, binding: channel.binding, nativePlan: admission.native!.plan,
      nativeOutcome: admission.native!.outcome, clientId: delivered.messageId, consumedOnce: true, draftKept: true, ttyBytesUnchanged: true,
    staleErrorCode: stale.error?.code, noActiveErrorCode: inactive.error?.code, ambiguityProof }))
    console.log(JSON.stringify({ schema: 'agentmux.native-steer-cost.v1', preparations, secondSendMs, rawAckMs,
      independentMessagesConsumedOnce: [delivered.messageId, secondMessage.messageId], sameActor: true }))
  } finally {
    await channel?.close(); await rpc?.dispose(); await control.stop()
    if (session) await client.stopAgent(session.agentSessionId, session.run)
    await client.dispose(); terminal.dispose(); daemon.kill('SIGTERM')
    const timer = setTimeout(() => daemon.kill('SIGKILL'), 2000)
    try { await daemonClosed } finally { clearTimeout(timer) }
    for (const stream of streams) stream.destroy(); model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
}, 90_000)
