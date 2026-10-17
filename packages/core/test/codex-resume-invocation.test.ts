import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { JSONRPCClient } from 'json-rpc-2.0'
import { activateRuntime } from '../node_modules/@ctxmux/sdk/dist/index.js'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { AgentMuxHostExecutorOwner } from '../src/executor-owner.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { prepareCodexManagedLaunch } from '../src/providers/codex-native-input.js'
import { runProcess } from '../src/process-runner.js'
import { runSourceObjectCli } from './helpers/source-object-cli.js'
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'
import { offlineEndpoint } from './helpers/codex-offline-endpoint.js'

vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, fork: ((path: string | URL, args: readonly string[], options: import('node:child_process').ForkOptions) =>
    actual.fork(String(path).endsWith('/control-endpoint-listener-worker.js')
      ? fileURLToPath(new URL('../src/control-endpoint-listener-worker.ts', import.meta.url)) : path, args, options)) as typeof actual.fork }
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })
const provider = new AgentProviderRegistry().get('codex'), sid = '00000000-0000-4000-8000-000000000001'

it.each(['resume', 'fork'] as const)('the actual wrapper routes the appended native %s action', async kind => {
  const context = { workspacePath: process.cwd(), args: ['as-ops', '--mode=best-effort', '--', '--yolo'], env: {}, commandOverride: 'codexL',
    nativeHandle: { kind: 'provider' as const, providerId: 'codex', sessionId: sid } }
  const plan = kind === 'resume' ? provider.buildResumeLaunch(context) : provider.buildForkLaunch!(context)
  const result = await runProcess(plan.command, [...plan.args, '--help'], { cwd: context.workspacePath, env: plan.env, timeoutMs: 5000 })
  expect(result.exitCode, result.stderr).toBe(0); expect(result.stdout).toContain('Usage: codex ' + kind)
})

it.each(['--version', 'resume', sid, 'quoted "text"\nand another line'])('keeps launcher routing and exact prompt data across native actions: %s', prompt => {
  for (const args of [[], ['--model', 'resume'], ['as-ops', '--mode=best-effort', '--', '--yolo']]) {
    const context = { workspacePath: process.cwd(), prompt, args, env: { ORIGINAL: 'kept' }, commandOverride: 'configured-launcher',
      nativeHandle: { kind: 'provider' as const, providerId: 'codex', sessionId: sid } }
    for (const [kind, plan] of [['create', provider.buildLaunch(context)], ['resume', provider.buildResumeLaunch(context)],
      ['fork', provider.buildForkLaunch!(context)]] as const) {
      expect(plan.command).toBe(context.commandOverride); expect(plan.env).toEqual(context.env)
      expect(plan.args).toEqual([...args, '--dangerously-bypass-hook-trust', ...(kind === 'create' ? [] : [kind, sid]), '--', prompt])
    }
  }
})

it.runIf(process.platform === 'darwin')('managed resume parses only its fixed footer, keeping option values and prompts distinct', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amux-invocation-')))
  try {
    const command = join(root, 'native-fixture')
    await writeFile(command, '#!/usr/bin/env node\nconsole.log("codex-cli 0.163.0")\n', { mode: 0o700 })
    for (const prompt of ['resume', '--version', sid]) {
      const plan = provider.buildResumeLaunch({ workspacePath: root, nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: sid },
        commandOverride: command, args: ['--model', 'resume', '--sandbox', 'read-only'], env: {}, prompt })
      const prepared = await prepareCodexManagedLaunch(plan, 'original-resume', { kind: 'resume', prompt })
      expect(prepared.nativeActor, 'Normal native resume must retain its managed actor').toBeDefined()
      expect(JSON.parse(prepared.plan.args[1]!).resume).toEqual({ threadId: sid, model: 'resume', sandbox: 'read-only' })
      expect(prepared.nativeActor?.launch.args).toEqual(['--model', 'resume', '--dangerously-bypass-hook-trust', 'resume', sid, '--', prompt])
      const wrapper = { ...plan, args: ['as-ops', '--mode=best-effort', '--', ...plan.args] }
      expect(await prepareCodexManagedLaunch(wrapper, 'original-resume', { kind: 'resume', prompt })).toEqual({ plan: wrapper })
    }
    for (const flag of ['--model', '--cd', '--enable', '--sandbox']) {
      const context = { workspacePath: root, nativeHandle: { kind: 'provider' as const, providerId: 'codex', sessionId: sid }, commandOverride: command,
        args: [flag], env: {}, prompt: 'Exact prompt' }
      for (const kind of ['create', 'resume'] as const) {
        const plan = kind === 'create' ? provider.buildLaunch(context) : provider.buildResumeLaunch(context)
        expect(await prepareCodexManagedLaunch(plan, 'original-invalid', { kind, prompt: context.prompt })).toEqual({ plan })
      }
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

it.runIf(process.platform === 'darwin')('source CLI resumes CodexL on a real private Run and consumes the original native context', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amux-native-resume-'))), home = join(root, 'home')
  const runtime = join(root, 'runtime'), state = join(root, 'state')
  for (const path of [home, runtime, state]) await mkdir(path, { mode: 0o700 })
  for (const name of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(name)) vi.stubEnv(name, undefined)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', runtime); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', state)
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  const inputs: string[] = [], { endpoint, sockets, requests } = await offlineEndpoint(home, inputs, root)
  const env = { CODEX_HOME: home, HOME: root, TERM: 'xterm-256color' }, args = ['as-ops', '--mode=best-effort', '--', '--no-daemon', '--no-alt-screen']
  const seed = spawn('codexL', ['as-ops', '--mode=global', '--', 'app-server', '--stdio'], { cwd: root,
    env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  let carry = '', diagnostic = '', closed = false
  const events: any[] = [], native = new JSONRPCClient(request => new Promise<void>((resolve, reject) =>
    seed.stdin.write(JSON.stringify(request) + '\n', error => error ? reject(error) : resolve())))
  seed.stderr.on('data', bytes => { diagnostic += bytes.toString() })
  const exited = new Promise<void>(resolve => seed.once('close', () => { closed = true; native.rejectAllPendingRequests(diagnostic); resolve() }))
  seed.stdout.on('data', bytes => {
    carry += bytes.toString()
    for (let newline; (newline = carry.indexOf('\n')) >= 0;) {
      const line = carry.slice(0, newline); carry = carry.slice(newline + 1)
      if (line.trim()) { const value = JSON.parse(line); if (value.method) events.push(value); else native.receive(value) }
    }
  })
  const call = (method: string, params: Record<string, unknown>) => native.timeout(10_000).request(method, params) as Promise<any>
  let activation: Awaited<ReturnType<typeof activateRuntime>> | undefined, client: AgentMuxClient | undefined, server: AgentMuxControlServer | undefined
  try {
    await call('initialize', { clientInfo: { name: 'agentmux_resume_proof', version: '1' }, capabilities: { experimentalApi: true } }); native.notify('initialized', {}, undefined)
    const original = await call('thread/start', { cwd: root, threadSource: 'user', modelProvider: 'private_queue', model: 'private-queue', approvalPolicy: 'never', sandbox: 'read-only' })
    const first = await call('turn/start', { threadId: original.thread.id, input: [{ type: 'text', text: 'PRIVATE_QUEUE_ORIGINAL_CONTEXT' }] })
    await vi.waitFor(() => expect(events.some(event => event.method === 'turn/completed' && event.params.turn.id === first.turn.id)).toBe(true), { timeout: 10_000 })
    const saved = await call('thread/read', { threadId: original.thread.id, includeTurns: false })
    seed.stdin.end(); await exited
    activation = await activateRuntime({ executable: fileURLToPath(new URL(`../vendor/ctxmux/${process.platform}-${process.arch}/bin/ctxmuxd`, import.meta.url)),
      socketPath: join(runtime, 'ctxmux.sock'), stateDir: join(state, 'ctxmux'), env: { AGENTMUX_AGENT_SESSION_ID: undefined, AGENTMUX_AGENT_CAPABILITY: undefined },
      timeoutMs: 5000, childDisposition: { mode: 'detached', stdout: 'ignore', stderr: 'pipe' } })
    const owner = new AgentMuxHostExecutorOwner({ path: join(root, 'executors.json'), runtimeId: 'private-host', catalog: () => [provider.catalog] })
    await owner.configure({ executorId: 'original-executor', config: { providerId: 'codex', label: 'Original native launcher', command: 'codexL', args, env, injectAgentMuxGuide: false } })
    const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
    client = new AgentMuxClient({ store, hostExecutorOwner: owner }); await client.connect()
    const inner = client as any, ended = await inner.kernel.start({ operationKey: 'original-run', program: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root, env: {} })
    await vi.waitFor(async () => expect((await inner.kernel.status(ended.runId)).state.type).toBe('exited'))
    const handle = { kind: 'provider' as const, providerId: 'codex', sessionId: original.thread.id, transcriptPath: saved.thread.path }
    await store.compareAndSwap(null, { kind: 'agent', agentSessionId: 'original-session', providerId: 'codex', executorId: 'original-executor', hostId: 'local',
      workspacePath: root, run: { runId: ended.runId }, retiredRuns: [], nativeHandle: handle, hookBindingId: 'original-binding', hookToken: 'original-token', createdAt: 1, updatedAt: 1 })
    await inner.registry.load('local')
    server = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), coreClients: () => [{ hostId: 'local', client: client! }] }); await server.start()
    const cliEnv = objectCliEnvironment(root)
    const resumed = await runSourceObjectCli(['--endpoint', 'unix://' + server.path, 'agent', 'resume', '--session', 'original-session', '--operation-id', 'original-resume'], cliEnv)
    expect(resumed.code, resumed.stderr).toBe(0)
    const current = client.agentSession('original-session')
    expect(current.nativeHandle).toEqual(handle); expect(current.run.runId).not.toBe(ended.runId)
    expect(current.continuity?.kind).toBe('resumed')
    await client.writeAgent({ agentSessionId: current.agentSessionId, expectedRun: current.run, source: 'user', data: '\x1b[200~PRIVATE_QUEUE_RESUMED_CONTEXT\x1b[201~' })
    await client.writeAgent({ agentSessionId: current.agentSessionId, expectedRun: current.run, source: 'user', data: '\r' })
    try {
      await vi.waitFor(() => expect(inputs.at(-1)).toContain('PRIVATE_QUEUE_RESUMED_CONTEXT'), { timeout: 15_000, interval: 100 })
    } catch (error) {
      const evidence = fileURLToPath(new URL('../../../.tmp/provider-native-capabilities/resume', import.meta.url))
      await mkdir(evidence, { recursive: true })
      await writeFile(join(evidence, 'native-failure.json'), JSON.stringify({ session: client.agentSession(current.agentSessionId),
        replay: (await client.readRunReplay(current.run)).replay.map(chunk => chunk.data).join(''), diagnostic }, null, 2))
      throw error
    }
    const transcript = await readFile(handle.transcriptPath, 'utf8')
    expect(transcript).toContain('PRIVATE_QUEUE_ORIGINAL_CONTEXT'); expect(transcript).toContain('PRIVATE_QUEUE_RESUMED_CONTEXT')
    type NativeInput = Array<{ role: string; content: Array<{ text?: string }> }>
    const resumedRequest = [...requests].reverse().find(request => (request.input as NativeInput).some(item => item.role === 'user' &&
      item.content?.some(part => part.text === 'PRIVATE_QUEUE_RESUMED_CONTEXT')))
    expect(resumedRequest, 'The original resumed turn must reach the protocol endpoint').toBeDefined()
    const nativeInput = resumedRequest!.input as NativeInput
    for (const [role, text] of [['user', 'PRIVATE_QUEUE_ORIGINAL_CONTEXT'], ['assistant', 'PRIVATE_QUEUE_COMPLETE'], ['user', 'PRIVATE_QUEUE_RESUMED_CONTEXT']]) {
      expect(nativeInput.some(item => item.role === role && item.content.some(part => part.text === text))).toBe(true)
    }
    expect((await client.refreshAgentSession(current.agentSessionId, current.run)).nativeHandle).toEqual(handle)
    const inspected = await runSourceObjectCli(['--endpoint', 'unix://' + server.path, 'agent', 'inspect', '--session', 'original-session'], cliEnv)
    expect(inspected.code, inspected.stderr).toBe(0); expect(inspected.stdout).toContain(original.thread.id)
    await client.dispose(); client = new AgentMuxClient({ store, hostExecutorOwner: owner }); await client.connect()
    expect(client.agentSession(current.agentSessionId).run).toEqual(current.run)
    expect(client.agentSession(current.agentSessionId).nativeHandle).toEqual(handle)
  } finally {
    if (!closed) { seed.kill('SIGTERM'); await exited }
    await server?.stop(); await client?.dispose()
    if (activation) {
      for (const run of await activation.client.list()) { if (run.state.type === 'running') await activation.client.stop(await activation.client.prepareStop(run.id)); await activation.client.remove(run.id) }
      await activation.shutdown(); await activation.dispose()
    }
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => endpoint.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
