import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentMuxClientEvent } from '../../src/types.js'

const selectedCoreEntry = process.env.AGENTMUX_GROK_CORE_ENTRY
const privateDeployment = process.env.AGENTMUX_GROK_PRIVATE_DEPLOYMENT
const restartCoreEntry = process.env.AGENTMUX_GROK_RESTART_CORE_ENTRY
const { AgentMuxClient, AgentMuxFileAgentSessionStore, AgentManagedHookInstaller, AgentProviderRegistry } =
  (selectedCoreEntry ? await import(/* @vite-ignore */ selectedCoreEntry) : await import('../../src/index.js')) as typeof import('../../src/index.js')

const exec = promisify(execFile)
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'"
const profile = '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))'
type Receipt = { input: Record<string, any>; cwd: string }
const coreMethods = ['connect', 'createAgent', 'statusAgent', 'readAgentSession', 'sessionTimeline',
  'reattachAgent', 'listRuns', 'inspectManagedHooks', 'stopAgent', 'dispose'] as const
type CoreApi = Pick<InstanceType<typeof AgentMuxClient>, typeof coreMethods[number]>
function privateCoreHost(entry: string, env: Record<string, string>, storePath: string, receipts: string,
  publish: (event: AgentMuxClientEvent) => void) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../fixtures/grok-hook-core-host.mjs', import.meta.url)), entry,
    JSON.stringify({ storePath, receipts })], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  let sequence = 0, stderr = ''
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  const closed = once(child, 'close')
  child.stderr.on('data', value => { stderr += value.toString() })
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => {
    const message = JSON.parse(line)
    if (message.event) { publish(message.event); return }
    const request = pending.get(message.id)
    if (request) { pending.delete(message.id); message.error ? request.reject(Object.assign(new Error(message.error.message), message.error)) : request.resolve(message.value) }
  })
  void closed.then(([code]) => {
    lines.close()
    for (const request of pending.values()) request.reject(new Error(`Private Core ${child.pid} exited ${code}: ${stderr}`))
    pending.clear()
  })
  const call = (method: string, args: unknown[]) => new Promise<any>((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) { reject(new Error('Private Core has exited: ' + stderr)); return }
    const id = ++sequence; pending.set(id, { resolve, reject })
    child.stdin.write(JSON.stringify({ id, method, args }) + '\n')
  })
  const client = Object.fromEntries(coreMethods.map(method => [method, (...args: unknown[]) => call(method, args)])) as CoreApi
  client.dispose = async () => {
    if (child.exitCode !== null || child.signalCode !== null) { await closed; return }
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000)
    try { await call('dispose', []); expect((await closed)[0], stderr).toBe(0) } finally { clearTimeout(timer) }
  }
  return { client, pid: child.pid!, closed }
}
afterEach(() => vi.unstubAllEnvs())
async function observedValue<T>(read: () => Promise<T>, accepts: (value: T) => boolean, timeout = 15_000): Promise<T> {
  const deadline = Date.now() + timeout
  let value = await read()
  while (!accepts(value) && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 25)); value = await read() }
  return value
}

// Installed native CLI + real model/tool protocol, real public Core create, FileStore, installer,
// ctxmuxd and authenticated Hook ingress. The model is private and deterministic. This is a
// headless proof; no existing Session, real credential, TUI completion or user permission is used.
it.runIf(Boolean(process.env.AGENTMUX_GROK_NATIVE_BINARY))('routes actual Grok headless Hooks into its original Core Run and leaves an outside invocation passive', async () => {
  const selected = process.env.AGENTMUX_GROK_NATIVE_BINARY
  expect(selected, 'Select an installed Grok artifact explicitly or with the verification script').toBeTruthy()
  const binary = await realpath(selected!)
  if (selectedCoreEntry) {
    expect(privateDeployment, 'Compiled source-removal proof requires its own explicit private deployment').toBeTruthy()
    expect(isAbsolute(privateDeployment!)).toBe(true)
    expect(basename(privateDeployment!)).toBe('deployment')
    expect(basename(dirname(privateDeployment!))).toMatch(/^amgv-[A-Za-z0-9]+$/u)
    expect(await realpath(privateDeployment!)).toBe(privateDeployment)
    expect(selectedCoreEntry).toBe(pathToFileURL(join(privateDeployment!, 'dist/index.js')).href)
    expect(restartCoreEntry).toBeTruthy(); expect(restartCoreEntry).not.toBe(selectedCoreEntry)
  }
  const root = await realpath(await mkdtemp(join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'amg-')))
  const workspace = join(root, 'workspace'), home = join(root, 'home'), grokHome = join(home, '.grok')
  const runtime = join(root, 'runtime'), storePath = join(root, 'sessions.json'), trace = join(root, 'native.jsonl')
  const launchEnvPath = join(root, 'launch-env.json'), seed = join(workspace, 'hook-seed.txt')
  for (const path of [workspace, home, grokHome, runtime, join(root, 'xdg'), join(root, 'tmp')]) await mkdir(path, { recursive: true })
  await writeFile(trace, ''); await writeFile(seed, 'private-native-hook-tool-result\n')
  const receiptPath = process.env.AGENTMUX_GROK_NATIVE_RECEIPT
  const privateEnv: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, GROK_HOME: grokHome,
    XDG_CONFIG_HOME: join(root, 'xdg'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'),
    XDG_STATE_HOME: join(root, 'state'), TMPDIR: join(root, 'tmp'), LANG: 'en_US.UTF-8', TERM: 'dumb',
    GROK_DISABLE_AUTOUPDATER: '1', GROK_DISABLE_EXPERIMENTS: '1', GROK_ERROR_REPORTING: '0', DISABLE_ERROR_REPORTING: '1',
    GROK_EXTERNAL_OTEL: '0', GROK_SESSION_REGISTRY: '0', DO_NOT_TRACK: '1',
    AGENTMUX_RUNTIME_DIRECTORY: runtime, AGENTMUX_STATE_DIRECTORY: join(root, 'core-state'),
    AGENTMUX_AGENT_SESSION_STORE: storePath, AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'messages.ndjson') }
  // No inherited provider overrides, auth/proxy variables, Node options, or AgentMux identity.
  for (const key of Object.keys(process.env)) vi.stubEnv(key, undefined)
  for (const [key, value] of Object.entries(privateEnv)) vi.stubEnv(key, value)
  const { stdout: version } = await exec('/usr/bin/sandbox-exec', ['-p', profile, binary, '--version'], { env: privateEnv, cwd: workspace })
  let finish!: () => void
  const completion = new Promise<void>(resolve => { finish = resolve })
  const requests: { url: string | undefined; body: any }[] = []
  const backend = createServer(async (request, response) => {
    let text = ''; for await (const bytes of request) text += bytes
    const body = text ? JSON.parse(text) : undefined; requests.push({ url: request.url, body })
    if (!request.url?.includes('/chat/completions')) {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(request.url?.includes('models') ? { object: 'list', data: [{ id: 'native-hook-probe', object: 'model' }] } : {})); return
    }
    const tool = body.tools?.find((value: any) => value.function?.name === 'read_file')?.function
    const result = body.messages?.find((message: any) => message.role === 'tool')
    if (tool && result) await completion
    const message = tool && !result ? { role: 'assistant', content: null, tool_calls: [{ id: 'native-read', type: 'function',
      function: { name: 'read_file', arguments: JSON.stringify({ target_file: seed, offset: 1, limit: 20 }) } }] }
      : { role: 'assistant', content: 'native-hook-probe-complete' }
    const finish_reason = message.tool_calls ? 'tool_calls' : 'stop'
    const common = { id: 'private-' + requests.length, created: Math.floor(Date.now() / 1000), model: 'native-hook-probe' }
    if (body.stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const delta = message.tool_calls ? { ...message, tool_calls: message.tool_calls.map((value, index) => ({ index, ...value })) } : message
      for (const [value, reason] of [[delta, null], [{}, finish_reason]]) response.write('data: ' + JSON.stringify({ ...common,
        object: 'chat.completion.chunk', choices: [{ index: 0, delta: value, finish_reason: reason }] }) + '\n\n')
      response.end('data: [DONE]\n\n')
    } else {
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ...common, object: 'chat.completion',
        choices: [{ index: 0, message, finish_reason }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }))
    }
  })
  await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(backend.address() as { port: number }).port}`
  const config = `[cli]\nauto_update=false\nuse_leader=false\nsession_registry=false\nshow_tips=false\n[models]\ndefault="native-hook-probe"\n[model.native-hook-probe]\nmodel="native-hook-probe"\nbase_url="${base}/v1"\napi_key="dummy-key-not-a-credential"\napi_backend="chat_completions"\ncontext_window=128000\nmax_completion_tokens=256\n[endpoints]\ncli_chat_proxy_base_url="${base}"\nmodels_base_url="${base}/v1"\nmodels_list_url="${base}/v1/models"\nxai_api_base_url="${base}/v1"\nfeedback_base_url="${base}"\nmanaged_config_url="${base}/managed"\ntrace_upload_url="${base}/traces"\nweb_base_url="${base}"\n[experiments]\nenabled=false\n[telemetry]\notel_enabled=false\ntrace_upload=false\n[diagnostics]\nerror_reporting=false\n[subagents]\nenabled=false\n[workflows]\nenabled=false\n[toolset.bash]\nlogin_shell_capture=false\n[compat.claude]\nhooks=false\nmcps=false\nagents=false\nrules=false\nskills=false\n[compat.codex]\nhooks=false\nskills=false\n[compat.cursor]\nhooks=false\nmcps=false\nagents=false\nrules=false\nskills=false\n`
  await writeFile(join(grokHome, 'config.toml'), config)
  // Independent read-only native observer preserves the original stdin. It never forwards or
  // signs an event; all Core effects come from the Provider-generated production declaration.
  const observer = join(root, 'observer.mjs')
  await writeFile(observer, `import{appendFileSync}from'node:fs';let text='';for await(const b of process.stdin)text+=b;appendFileSync(${JSON.stringify(trace)},JSON.stringify({input:JSON.parse(text),cwd:process.cwd()})+'\\n');process.stdout.write('{}\\n');`)
  const observerEvents = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']
  await mkdir(join(grokHome, 'hooks'))
  await writeFile(join(grokHome, 'hooks', 'native-observer.json'), JSON.stringify({ hooks: Object.fromEntries(observerEvents.map(name =>
    [name, [{ ...(name.includes('ToolUse') ? { matcher: '.*' } : {}), hooks: [{ type: 'command', command: process.execPath, args: [observer], timeout: 10 }] }]])) }))
  const launcher = join(root, 'grok'), capture = join(root, 'capture.mjs')
  await writeFile(capture, `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(launchEnvPath)},JSON.stringify({environment:process.env,pid:process.ppid}),{mode:0o600});`)
  await writeFile(launcher, `#!/bin/sh\n${quote(process.execPath)} ${quote(capture)}\nexec /usr/bin/sandbox-exec -p ${quote(profile)} ${quote(binary)} "$@"\n`, { mode: 0o700 })
  const provider = new AgentProviderRegistry().get('grok')
  const events: AgentMuxClientEvent[] = []
  let store = new AgentMuxFileAgentSessionStore(storePath)
  const core = () => {
    const value = new AgentMuxClient({ providers: [provider], store, hookInstaller: new AgentManagedHookInstaller(join(root, 'receipts')) })
    value.onEvent(event => { events.push(event) }); return value
  }
  const coreHosts: ReturnType<typeof privateCoreHost>[] = []
  const compiledCore = (entry: string) => {
    const host = privateCoreHost(entry, privateEnv, storePath, join(root, 'receipts'), event => { events.push(event) })
    coreHosts.push(host); return host.client
  }
  let client: CoreApi = selectedCoreEntry ? compiledCore(selectedCoreEntry) : core()
  const daemonBinary = privateDeployment ? join(privateDeployment, `vendor/ctxmux/${process.platform}-${process.arch}/bin/ctxmuxd`)
    : fileURLToPath(new URL(`../../vendor/ctxmux/${process.platform}-${process.arch}/bin/ctxmuxd`, import.meta.url))
  const daemon = spawn(daemonBinary, [
    '--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(root, 'daemon'), '--readiness-fd', '3'
  ], { env: privateEnv, stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
  let daemonError = ''; daemon.stderr?.on('data', value => { daemonError += value.toString() })
  const daemonClosed = once(daemon, 'close')
  const receipts = async (): Promise<Receipt[]> => (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  let sessionId: string | undefined, originalRun: {runId: string} | undefined, proof: Record<string, unknown> | undefined
  try {
    await Promise.race([once(daemon.stdio[3]!, 'data'), once(daemon, 'exit').then(() => { throw Error('Private ctxmuxd exited: ' + daemonError) })])
    await client.connect()
    const created = await client.createAgent({ agentSessionId: 'native-grok-hook', createOperationId: 'create-native-grok-hook',
      providerId: 'grok', executorId: 'native-grok', workspacePath: workspace, commandOverride: launcher, injectAgentMuxGuide: false,
      env: privateEnv, args: ['--leader-socket', join(root, 'leader.sock'), '--no-subagents', '--tools', 'read_file', '--max-turns', '3',
        '--output-format', 'streaming-json', '--debug-file', join(root, 'native.log'), '-m', 'native-hook-probe', '-p',
        'Read hook-seed.txt with read_file, then reply native-hook-probe-complete.'] })
    sessionId = created.agentSessionId
    const run = created.run; originalRun = run
    await expect.poll(async () => (await receipts()).some(value => value.input.hookEventName === 'post_tool_use'), { timeout: 20_000 }).toBe(true)
    expect(await observedValue(async () => (await store.readMetadata(sessionId!))?.hookReceipt?.eventName,
      value => value === 'post_tool_use')).toBe('post_tool_use')
    const native = await receipts(), nativeId = native[0]!.input.sessionId
    expect(nativeId).toMatch(/^[0-9a-f-]{36}$/u)
    expect(native.every(value => value.input.sessionId === nativeId && value.cwd === workspace)).toBe(true)
    const current = await client.readAgentSession(sessionId)
    expect(current?.run).toEqual(run)
    expect(current?.nativeHandle).toMatchObject({ kind: 'provider', providerId: 'grok', sessionId: nativeId })
    const timeline = await client.sessionTimeline(sessionId)
    const tool = timeline.items.find(value => value.kind === 'tool_call' && value.conversation?.invocations?.some(field => field.invocation.callId === 'native-read'))
    expect(tool).toMatchObject({ status: 'complete', toolName: 'read_file' }); expect(JSON.parse(tool!.toolInput!)).toMatchObject({ target_file: seed })
    expect(JSON.stringify(tool)).toContain('private-native-hook-tool-result')
    expect(events.some(event => event.type === 'agent-timeline' && event.evidence.source === 'native-hook' && event.evidence.run?.runId === run.runId)).toBe(true)
    const installedPath = join(grokHome, 'hooks', 'agentmux-status.json'), installed = await readFile(installedPath, 'utf8')
    const command = JSON.parse(installed).hooks.PreToolUse[0].hooks[0].command as string
    const launched = JSON.parse(await readFile(launchEnvPath, 'utf8')) as { environment: Record<string, string>; pid: number }
    const runEnv = launched.environment
    expect((await client.statusAgent(sessionId)).run).toMatchObject({ runId: run.runId, pid: launched.pid, state: 'running' })
    expect(runEnv.AGENTMUX_ENV).toBe('1'); expect(runEnv.AGENTMUX_PROVIDER_ID).toBe('grok')
    expect(runEnv.AGENTMUX_HOOK_NODE!.startsWith(root + '/')).toBe(true)
    expect(runEnv.AGENTMUX_HOOK_RUNNER!.startsWith(root + '/')).toBe(true)
    expect(runEnv.XAI_API_KEY).toBeUndefined(); expect(runEnv.GROK_AUTH).toBeUndefined(); expect(runEnv.CLAUDE_CONFIG_DIR).toBeUndefined()
    // dispose detaches Core; it does not call stop on the healthy native Run. The second Core
    // restores the exact stored binding and the old launch URL/token, without creating a Run.
    await client.dispose()
    process.kill(launched.pid, 0)
    if (selectedCoreEntry) {
      // Only the runner-created deployment is removed. The original Run's retained interpreter,
      // worker, state, Store, native config and workspace all belong to the separate test root.
      expect(root.startsWith(privateDeployment! + '/')).toBe(false)
      expect(runEnv.AGENTMUX_HOOK_RUNNER!.startsWith(privateDeployment! + '/')).toBe(false)
      expect(() => process.kill(coreHosts[0]!.pid, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }))
      expect((await readFile(join(privateDeployment!, 'bin/agentmux-hook.js'))).length).toBeGreaterThan(0)
      expect((await readFile(join(privateDeployment!, 'dist/agentmux-hook.mjs'))).length).toBeGreaterThan(0)
      await rm(privateDeployment!, { recursive: true, force: true })
      await expect(readFile(join(privateDeployment!, 'bin/agentmux-hook.js'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(join(privateDeployment!, 'dist/agentmux-hook.mjs'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect((await readFile(runEnv.AGENTMUX_HOOK_RUNNER!)).length).toBeGreaterThan(0)
      process.kill(launched.pid, 0)
    }
    store = new AgentMuxFileAgentSessionStore(storePath)
    client = selectedCoreEntry ? compiledCore(restartCoreEntry!) : core(); await client.connect()
    const restored = await client.reattachAgent(sessionId)
    expect(restored.session.run).toEqual(run)
    expect(restored.session.nativeHandle).toEqual(current!.nativeHandle)
    expect((await client.statusAgent(sessionId)).run).toMatchObject({ runId: run.runId, pid: launched.pid, state: 'running' })
    expect((await client.listRuns()).map(value => value.runId)).toEqual([run.runId])
    const inspection = await client.inspectManagedHooks('grok', { workspacePath: workspace, env: privateEnv })
    expect(inspection.status).toBe('installed')
    expect(inspection.targets.map(value => ({ path: value.path, status: value.status }))).toEqual([{ path: installedPath, status: 'current' }])
    const beforeReceipt = (await store.readMetadata(sessionId))!.hookReceipt
    const beforeEvents = events.length
    const outside = { ...native.find(value => value.input.hookEventName === 'pre_tool_use')!.input, toolUseId: 'outside-hook', tool_use_id: 'outside-hook' }
    delete runEnv.AGENTMUX_ENV
    const outsideChild = spawn('/bin/sh', ['-c', command], { cwd: workspace, env: runEnv, stdio: ['pipe', 'pipe', 'pipe'] })
    let outsideOutput = '', outsideError = ''
    outsideChild.stdout.on('data', value => { outsideOutput += value }); outsideChild.stderr.on('data', value => { outsideError += value })
    outsideChild.stdin.end(JSON.stringify(outside))
    expect((await once(outsideChild, 'close'))[0]).toBe(0)
    expect(JSON.parse(outsideOutput)).toEqual({}); expect(outsideError).toBe('')
    // Delivery returns only after this command's ingress; the real native Run remains waiting at
    // the model boundary while this comparison excludes late unrelated native callbacks.
    expect((await store.readMetadata(sessionId))!.hookReceipt).toEqual(beforeReceipt)
    expect(events.slice(beforeEvents).filter(event => event.type === 'agent-timeline' && event.evidence.source === 'native-hook')).toEqual([])
    expect((await client.sessionTimeline(sessionId)).items.some(value => value.conversation?.invocations?.some(field => field.invocation.callId === 'outside-hook'))).toBe(false)
    finish()
    await expect.poll(async () => (await receipts()).some(value => value.input.hookEventName === 'stop' && value.input.reason === 'end_turn'), { timeout: 15_000 }).toBe(true)
    await expect.poll(async () => (await store.readMetadata(sessionId!))?.hookReceipt?.eventName, { timeout: 15_000 }).toBe('stop')
    const final = await client.readAgentSession(sessionId)
    expect(final?.run).toEqual(run); expect(final?.nativeHandle?.sessionId).toBe(nativeId)
    expect(await readFile(installedPath, 'utf8')).toBe(installed)
    expect(requests.flatMap(value => value.body?.messages ?? []).some(value => value.role === 'tool' && value.content.includes('private-native-hook-tool-result'))).toBe(true)
    const actualEvents = (await receipts()).map(value => value.input.hookEventName)
    expect(actualEvents).toEqual(expect.arrayContaining(['session_start', 'user_prompt_submit', 'pre_tool_use', 'post_tool_use', 'stop']))
    proof = { schema: 'agentmux.grok-native-hook-binding.v1', binary, coreEntry: selectedCoreEntry ?? 'current-source',
      compiledPackageConsumer: Boolean(selectedCoreEntry),
      privateDeployment: privateDeployment ?? null, compiledSourceRemovedAfterLaunch: Boolean(selectedCoreEntry),
      ...(selectedCoreEntry ? { firstCorePid: coreHosts[0]!.pid, secondCorePid: coreHosts[1]!.pid,
        firstCoreExitedBeforeSourceRemoval: true } : {}),
      version: version.trim(), scope: 'native-headless', publicCreate: true, privateCtxmux: true, originalRun: run,
      nativeSessionId: nativeId, nativeEvents: actualEvents, coreToolConsumed: true, outsideIngress: false,
      originalPid: launched.pid, coreRecreated: true, sameRunReattached: true, oldLaunchBindingDeliveredStop: true,
      publicDeclarationInspection: true,
      retainedRuntime: true, sharedDeclarationUnchanged: true, requestPaths: requests.map(value => value.url), network: 'localhost-only',
      workerPath: runEnv.AGENTMUX_HOOK_RUNNER, privateRoot: root }
  } finally {
    finish()
    if (sessionId) await client.stopAgent(sessionId, originalRun!).catch(() => {})
    await client.dispose()
    for (const host of coreHosts) await host.client.dispose()
    daemon.kill('SIGTERM'); const timer = setTimeout(() => daemon.kill('SIGKILL'), 2_000)
    try { await daemonClosed } finally { clearTimeout(timer) }
    backend.closeAllConnections(); await new Promise<void>(resolve => backend.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
  if (receiptPath) await writeFile(receiptPath, JSON.stringify({ ...proof, privateRootRemovedAfterTest: true }, null, 2) + '\n', { mode: 0o600 })
}, 75_000)
