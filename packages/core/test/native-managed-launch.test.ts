import { codexFrontendSocketPath, observeCodexTerminalFrontend, reconnectCodexTerminalFrontend, CODEX_ACTOR_ID_ENV, CODEX_ACTOR_LIFECYCLE_ENV } from '../src/providers/codex-managed-frontend.js'
import { fixturePath as _historyFixturePath } from "./helpers/fixture-values.js"
import { afterEach, expect, it, vi } from 'vitest'
import { access, mkdtemp, writeFile, rm, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { nativeResumeSource } from './helpers/native-resume-source.js'
import { prepareCodexManagedLaunch } from '../src/providers/codex-native-input.js'
import { CODEX_NATIVE_TOKEN_ENV, runCodexManaged, type CodexManagedRunPlan } from '../src/providers/codex-managed-run.js'
import { nativeProcessTcpListeners } from '../src/agent-native-process.js'
import { CODEX_LAUNCH_OPTIONS, resolveLaunchOptionArgv } from '../src/agent-launch-option.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllEnvs() })
async function command(version = 'codex-cli 0.163.0') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amux-native-plan-'))); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'native-fixture')
  await writeFile(path, '#!/usr/bin/env node\nconsole.log(' + JSON.stringify(version) + ')\n', { mode: 0o700 })
  return { root, path }
}

it.runIf(process.platform === 'darwin')('qualifies create, preserving the original Provider invocation and Electron Node contract in the final launch plan', async () => {
  const f = await command(), original = { command: f.path, args: ['--no-alt-screen', '--model', 'original-model', '--dangerously-bypass-hook-trust', '--', 'Original initial prompt'], env: { ORIGINAL_FIXTURE: 'kept' } }
  const prepared = await prepareCodexManagedLaunch(original, 'original-lifecycle', { kind: 'create', prompt: 'Original initial prompt' })
  expect(prepared.nativeActor?.launch).toEqual({ command: original.command, args: original.args })
  expect(prepared.nativeActor?.lifecycleOperationId).toBe('original-lifecycle'); expect(prepared.nativeActor?.token).toMatch(/^[a-f0-9]{64}$/u)
  expect(prepared.nativeActor?.frontendControl).toBe(true)
  expect(prepared.plan.env).toMatchObject({ ORIGINAL_FIXTURE: 'kept', ELECTRON_RUN_AS_NODE: '1', [CODEX_NATIVE_TOKEN_ENV]: prepared.nativeActor!.token })
  expect(prepared.plan.command).toBe(process.execPath)
  const helper = JSON.parse(prepared.plan.args[1]!)
  expect(helper).toEqual({ command: original.command, serverConfig: [], frontendArgs: ['--no-alt-screen', '--dangerously-bypass-hook-trust'], create: { model: 'original-model' } })
  expect(JSON.stringify(prepared.plan.args)).not.toContain(prepared.nativeActor!.token)
  expect(original.env).toEqual({ ORIGINAL_FIXTURE: 'kept' })
})

it.runIf(process.platform === 'darwin')('keeps unsupported argv/version and unqualified resume/fork on their original TTY plan without inventing a native capability', async () => {
  const f = await command(), plan = { command: f.path, args: ['--dangerously-bypass-hook-trust'], env: {} }
  for (const kind of ['resume', 'fork'] as const) expect(await prepareCodexManagedLaunch(plan, 'original-lifecycle', { kind })).toEqual({ plan })
  for (const args of [['resume'], ['resume', '--last'], ['resume', 'named-session'], ['resume', '--all'], ['resume', '00000000-0000-4000-8000-000000000001', '--unknown-flag'], ['fork', '00000000-0000-4000-8000-000000000001']]) {
    const unsupported = { ...plan, args }; expect(await prepareCodexManagedLaunch(unsupported, 'original-lifecycle', { kind: 'resume' })).toEqual({ plan: unsupported })
  }
  for (const args of [['--add-dir', _historyFixturePath("original/workspace")], ['agents'], ['exec', 'original prompt'], ['--unknown-flag']]) {
    const unsupported = { ...plan, args }; expect(await prepareCodexManagedLaunch(unsupported, 'original-lifecycle', { kind: 'create' })).toEqual({ plan: unsupported })
  }
  const old = await command('codex-cli 0.162.0'), unsupported = { ...plan, command: old.path }
  expect(await prepareCodexManagedLaunch(unsupported, 'original-lifecycle', { kind: 'create' })).toEqual({ plan: unsupported })
})

it.runIf(process.platform === 'darwin').each([false, true])('prepares normal Core permission selections before TUI resume, with prompt=%s and the exact original native actor invocation', async withPrompt => {
  const f = await command(), sid = '00000000-0000-4000-8000-000000000001', prompt = 'Original resume prompt'
  const choices = (id: string) => [undefined, ...CODEX_LAUNCH_OPTIONS.find(option => option.id === id)!.choices.map(choice => choice.id)]
  for (const sandbox of choices('sandbox')) for (const approval of choices('approval')) {
    const permissionArgv = resolveLaunchOptionArgv('codex', CODEX_LAUNCH_OPTIONS, { ...(sandbox ? { sandbox } : {}), ...(approval ? { approval } : {}) })
    const args = ['--dangerously-bypass-hook-trust', '--no-alt-screen', '--model', 'original-model', ...permissionArgv,
      '-C', f.root, '--enable', 'original-feature', 'resume', sid, ...(withPrompt ? ['--', prompt] : [])]
    const original = { command: f.path, args, env: { ORIGINAL_FIXTURE: 'kept' } }
    const prepared = await prepareCodexManagedLaunch(original, 'original-resume-lifecycle', { kind: 'resume', ...(withPrompt ? { prompt } : {}) })
    expect(prepared.nativeActor?.launch).toEqual({ command: original.command, args })
    expect(prepared.nativeActor?.lifecycleOperationId).toBe('original-resume-lifecycle')
    expect(JSON.parse(prepared.plan.args[1]!)).toEqual({ command: original.command, serverConfig: ['--enable', 'original-feature'], frontendArgs: ['--dangerously-bypass-hook-trust', '--no-alt-screen'],
      resume: { threadId: sid, model: 'original-model', cwd: f.root, ...(sandbox ? { sandbox } : {}), ...(approval ? { approvalPolicy: approval } : {}) } })
    expect(prepared.plan.env).toMatchObject({ ...original.env, [CODEX_NATIVE_TOKEN_ENV]: prepared.nativeActor!.token })
    expect(original.args).toEqual(args)
  }
}, 40_000)

it.runIf(process.platform === 'darwin')('retains an exact prompt even when its text is a flag or configuration value and gives each resume its own actor', async () => {
  const f = await command(), sid = '00000000-0000-4000-8000-000000000001'
  for (const prompt of ['--dangerously-bypass-hook-trust', '--sandbox', 'read-only']) {
    const args = ['--sandbox', 'read-only', '--ask-for-approval', 'on-request', '--dangerously-bypass-hook-trust', 'resume', sid, '--', prompt]
    const original = { command: f.path, args, env: {} }
    const a = await prepareCodexManagedLaunch(original, 'first-resume', { kind: 'resume', prompt })
    const b = await prepareCodexManagedLaunch(original, 'second-resume', { kind: 'resume', prompt })
    expect(a.nativeActor?.launch.args).toEqual(args)
    expect(JSON.parse(a.plan.args[1]!).resume).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'on-request' })
    expect(b.nativeActor?.actorId).not.toBe(a.nativeActor!.actorId)
    expect(b.nativeActor?.token).not.toBe(a.nativeActor!.token)
  }
})

it.runIf(process.platform === 'darwin')('does not qualify custom profile/config, ambiguous permission values or duplicate flags', async () => {
  const f = await command(), sid = '00000000-0000-4000-8000-000000000001'
  for (const tail of [['-p', 'original-profile'], ['--config', 'approval_policy="never"'], ['--config=model="original"'],
    ['--sandbox', 'future-policy'], ['--ask-for-approval', 'future-policy'], ['-s', 'read-only', '--sandbox', 'workspace-write'], ['-a', 'never', '--ask-for-approval', 'on-request'], ['--sandbox']]) {
    const plan = { command: f.path, args: [...tail, 'resume', sid], env: {} }
    expect(await prepareCodexManagedLaunch(plan, 'original-resume-lifecycle', { kind: 'resume' })).toEqual({ plan })
  }
})

it.runIf(process.platform === 'darwin')('qualifies the configured bypass for create and transfers its exact native policy on resume', async () => {
  const f = await command(), sid = '00000000-0000-4000-8000-000000000001', flag = '--dangerously-bypass-approvals-and-sandbox'
  const create = { command: f.path, args: [flag, '--dangerously-bypass-hook-trust', '--', 'Original initial prompt'], env: {} }
  const first = await prepareCodexManagedLaunch(create, 'original-create', { kind: 'create', prompt: 'Original initial prompt' })
  expect(first.nativeActor?.launch).toEqual({ command: create.command, args: create.args })
  expect(JSON.parse(first.plan.args[1]!)).toEqual({ command: create.command, serverConfig: [], frontendArgs: ['--dangerously-bypass-hook-trust'], create: { sandbox: 'danger-full-access', approvalPolicy: 'never' } })
  for (const prompt of ['Original continuation', flag]) {
    const args = [flag, '--dangerously-bypass-hook-trust', '--model', 'original-model', '-C', '.', 'resume', sid, '--', prompt]
    const next = await prepareCodexManagedLaunch({ ...create, args }, 'original-resume', { kind: 'resume', prompt })
    const actualArgs = args
    expect(next.nativeActor?.launch).toEqual({ command: create.command, args: actualArgs })
    expect(JSON.parse(next.plan.args[1]!)).toEqual({ command: create.command, serverConfig: [], frontendArgs: ['--dangerously-bypass-hook-trust'],
      resume: { threadId: sid, sandbox: 'danger-full-access', approvalPolicy: 'never', model: 'original-model', cwd: '.' } })
  }
})

it.runIf(process.platform === 'darwin')('keeps duplicate or mixed bypass permission forms on their complete original launch', async () => {
  const f = await command(), sid = '00000000-0000-4000-8000-000000000001', flag = '--dangerously-bypass-approvals-and-sandbox'
  for (const tail of [[flag], ['--sandbox', 'read-only'], ['--ask-for-approval', 'never'], ['--profile', 'original-profile'], ['-c', 'model="original"']]) {
    for (const args of [[flag, ...tail], [...tail, flag]]) for (const kind of ['create', 'resume'] as const) {
      const plan = { command: f.path, args: [...args, ...(kind === 'resume' ? ['resume', sid] : [])], env: {} }
      expect(await prepareCodexManagedLaunch(plan, 'original-lifecycle', { kind })).toEqual({ plan })
    }
  }
})

it.runIf(process.platform === 'darwin')('does not strip a misplaced resume prompt or upgrade a different native version', async () => {
  const f = await command(), sid = '00000000-0000-4000-8000-000000000001', args = ['--model', 'original-model', 'resume', sid, 'Original resume prompt']
  const plan = { command: f.path, args, env: {} }
  expect(await prepareCodexManagedLaunch(plan, 'original-resume-lifecycle', { kind: 'resume', prompt: 'Original resume prompt' })).toEqual({ plan })
  const old = await command('codex-cli 0.162.0'), unsupported = { ...plan, command: old.path, args: ['resume', sid] }
  expect(await prepareCodexManagedLaunch(unsupported, 'original-resume-lifecycle', { kind: 'resume' })).toEqual({ plan: unsupported })
  const relative = { ...plan, args: ['-C', 'original-relative-workspace', 'resume', sid] }
  const prepared = await prepareCodexManagedLaunch(relative, 'relative-resume-lifecycle', { kind: 'resume' })
  expect(JSON.parse(prepared.plan.args[1]!).resume.cwd).toBe('original-relative-workspace')
})

it.runIf(process.platform === 'darwin' || process.platform === 'linux')('reads an actual ephemeral loopback listener including native lsof descriptor boundaries in the exact original process group', async () => {
  const child = spawn(process.execPath, ['--eval', 'const net=require("node:net");const server=net.createServer();server.listen(0,"127.0.0.1",()=>process.send({port:server.address().port}));'], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  cleanup.push(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit') } })
  const [receipt] = await once(child, 'message')
  const result = await nativeProcessTcpListeners(child.pid!, new AbortController().signal).then(listeners => ({ listeners, error: null }), error => ({ listeners: null, error }))
  expect(result.error).toBeNull()
  expect(result.listeners).toEqual([{ processId: child.pid, endpoint: `ws://127.0.0.1:${receipt.port}` }])
})

it('never replaces a failed frozen native bootstrap with an embedded TUI', async () => {
  const f = await command(), marker = join(f.root, 'unexpected-tui')
  vi.stubEnv(CODEX_NATIVE_TOKEN_ENV, 'a'.repeat(64))
  vi.stubEnv(CODEX_ACTOR_ID_ENV, 'original-actor'); vi.stubEnv(CODEX_ACTOR_LIFECYCLE_ENV, 'original-lifecycle')
  await expect(runCodexManaged({ command: process.execPath, frontendArgs: [], serverConfig: ['--eval', 'process.exit(7)'], create: {} })).resolves.toBe(7)
  await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
})

async function nativeLifecycleFixture(response: 'confirmed' | 'wrong-policy' | 'wrong-thread' | 'not-direct' = 'confirmed') {
  const f = await command(), script = join(f.root, 'native-lifecycle.mjs'), log = join(f.root, 'requests.jsonl'), marker = join(f.root, 'tui.json'), gate = join(f.root, 'policy-ready'), connection = join(f.root, 'connection.json')
  const sid = '00000000-0000-4000-8000-000000000001'
  const expected = { thread: { id: response === 'wrong-thread' ? 'foreign-thread' : sid, sessionId: 'original-loaded-session', canAcceptDirectInput: response !== 'not-direct' },
    approvalPolicy: 'on-request', sandbox: { type: response === 'wrong-policy' ? 'workspaceWrite' : 'readOnly' }, model: 'original-model', cwd: f.root }
  await writeFile(script, `#!/usr/bin/env node
import NativeWebSocket from ${JSON.stringify(createRequire(import.meta.url).resolve('ws'))}
const { WebSocketServer } = NativeWebSocket
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
const args=process.argv.slice(2), log=${JSON.stringify(log)}, marker=${JSON.stringify(marker)}, gate=${JSON.stringify(gate)}, connection=${JSON.stringify(connection)}
if(args.includes('--version')) {console.log('codex-cli 0.163.0');process.exit(0)}
if(args.includes('app-server')) {
  setInterval(()=>writeFileSync(marker+'.heartbeat',String(Date.now())),20)
  const server=new WebSocketServer({port:0,host:'127.0.0.1'})
  server.on('connection',(ws,req)=>{
    if(req.headers.authorization!=='Bearer '+process.env.${CODEX_NATIVE_TOKEN_ENV}) process.exit(9)
    writeFileSync(connection,JSON.stringify({open:true}))
    ws.on('close',()=>writeFileSync(connection,JSON.stringify({open:false})))
    ws.on('message',async bytes=>{
      const request=JSON.parse(String(bytes));appendFileSync(log,JSON.stringify(request)+'\\n')
      if(!Object.hasOwn(request,'id'))return
      if(request.method==='thread/resume')while(!existsSync(gate))await new Promise(done=>setTimeout(done,10))
      ws.send(JSON.stringify({jsonrpc:'2.0',id:request.id,result:request.method==='account/read'?{account:null,requiresOpenaiAuth:false}:['thread/resume','thread/read'].includes(request.method)?${JSON.stringify(expected)}:{}}))
    })
  })
} else {
  appendFileSync(marker+'.events',JSON.stringify({args})+'\\n')
  writeFileSync(marker,JSON.stringify({args,connected:existsSync(connection)?JSON.parse(readFileSync(connection,'utf8')).open:false,requests:existsSync(log)?readFileSync(log,'utf8').trim().split('\\n').map(JSON.parse):[]}))
}
`, { mode: 0o700 })
  vi.stubEnv(CODEX_NATIVE_TOKEN_ENV, 'a'.repeat(64))
  vi.stubEnv(CODEX_ACTOR_ID_ENV, 'original-actor'); vi.stubEnv(CODEX_ACTOR_LIFECYCLE_ENV, 'original-lifecycle')
  const plan: CodexManagedRunPlan = { command: script, serverConfig: [], frontendArgs: [],
    resume: { threadId: sid, sandbox: 'read-only', approvalPolicy: 'on-request', model: 'original-model', cwd: f.root } }
  return { ...f, log, marker, gate, plan }
}

async function runNativeLifecycle(f: Awaited<ReturnType<typeof nativeLifecycleFixture>>, settlementGate?: string) {
  const entry = join(f.root, 'managed-entry.mjs')
  await build({ entryPoints: [new URL('../src/providers/codex-managed-run.ts', import.meta.url).pathname], outfile: entry,
    bundle: true, platform: 'node', format: 'esm', target: 'node24',
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    plugins: [{ name: 'exact-native-resume-source', setup(b) { b.onLoad({ filter: /\.ts$/ }, async ({ path }) => {
      let contents = nativeResumeSource(await readFile(path, 'utf8'), path)
      // Schedule-only fault injection: let the OS exit happen before the tail consumes its latch.
      if (settlementGate && path.endsWith('/codex-managed-run.ts')) contents = contents.replace('    const ended = await backendExit',
        '    while (!require(\'node:fs\').existsSync(' + JSON.stringify(settlementGate) + ') && !stopping) await new Promise(resolve => setTimeout(resolve, 10))\n    const ended = await backendExit')
      return { contents, loader: 'ts' }
    }) } }]
  })
  const child = spawn(process.execPath, [entry, JSON.stringify(f.plan)], { cwd: f.root, env: process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) {
    process.kill(-child.pid!, 'SIGTERM')
    const timer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL') } catch {} }, 1000)
    try { await once(child, 'close') } finally { clearTimeout(timer) }
  }
    await rm(codexFrontendSocketPath('a'.repeat(64)), { force: true })
  })
  let stderr = ''
  child.stderr.on('data', bytes => { stderr += String(bytes) })
  child.stdout.resume()
  return { child, stop: () => child.kill('SIGTERM'), completed: new Promise<{ exitCode: number | null; stderr: string }>((resolve, reject) => {
    child.once('error', reject); child.once('close', exitCode => resolve({ exitCode, stderr }))
  }) }
}

it.runIf(process.platform === 'darwin')('starts the real child TUI only after authenticated native resume confirms its exact policy and keeps that original subscription', async () => {
  const f = await nativeLifecycleFixture()
  f.plan.resume!.cwd = '.' // Core service and actual child Run cwd differ.
  const { completed, stop } = await runNativeLifecycle(f)
  try {
    await expect.poll(async () => await readFile(f.log, 'utf8').then(text => text.includes('thread/resume'), () => false) ||
      await readFile(f.marker).then(() => true, () => false), { timeout: 10_000 }).toBe(true)
    await expect(readFile(f.marker)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await writeFile(f.gate, 'ready') }
  await expect.poll(() => readFile(f.marker, 'utf8').then(() => true, () => false), { timeout: 10_000 }).toBe(true)
  stop()
  await expect(completed).resolves.toEqual({ exitCode: 1, stderr: '' })
  const actual = JSON.parse(await readFile(f.marker, 'utf8'))
  expect(actual.connected).toBe(true)
  expect(actual.requests.filter((row: { method: string }) => row.method !== 'initialized').map((row: { method: string }) => row.method)).toEqual(['initialize', 'account/read', 'thread/resume'])
  expect(actual.requests.find((row: { method: string }) => row.method === 'thread/resume').params).toEqual({ ...f.plan.resume, cwd: f.root, excludeTurns: true })
  expect(actual.args.slice(4)).toEqual(['resume', f.plan.resume!.threadId, ...f.plan.frontendArgs])
})

it.runIf(process.platform === 'darwin').each([
  { flag: true, prompt: 'Original continuation prompt' },
  { flag: false, prompt: 'Original continuation prompt' },
  { flag: false, prompt: '--dangerously-bypass-hook-trust' }
])('preserves only the original parsed Hook switch on the first real native resume: %j', async ({ flag, prompt }) => {
  const f = await nativeLifecycleFixture()
  const original = { command: f.plan.command, args: [...(flag ? ['--dangerously-bypass-hook-trust'] : []),
    '--sandbox', 'read-only', '--ask-for-approval', 'on-request', '--model', 'original-model', '-C', f.root,
    'resume', f.plan.resume!.threadId, '--', prompt], env: {} }
  const prepared = await prepareCodexManagedLaunch(original, 'original-lifecycle', { kind: 'resume', prompt })
  expect(prepared.nativeActor).toBeDefined()
  f.plan = JSON.parse(prepared.plan.args[1]!)
  await writeFile(f.gate, 'ready')
  const running = await runNativeLifecycle(f)
  await expect.poll(() => readFile(f.marker, 'utf8').then(() => true, () => false), { timeout: 10_000 }).toBe(true)
  running.stop()
  await expect(running.completed).resolves.toEqual({ exitCode: 1, stderr: '' })
  const actual = JSON.parse(await readFile(f.marker, 'utf8'))
  const resume = actual.requests.filter((row: { method: string }) => row.method === 'thread/resume')
  expect(resume).toHaveLength(1)
  expect(resume[0].params).toEqual({ ...f.plan.resume, excludeTurns: true,
    ...(flag ? { config: { bypass_hook_trust: true } } : {}) })
  expect(actual.args.slice(4)).toEqual(['resume', f.plan.resume!.threadId, ...f.plan.frontendArgs])
  expect(original.args).toContain(prompt)
})

it.runIf(process.platform === 'darwin').each(['wrong-policy', 'wrong-thread', 'not-direct'] as const)('keeps the continuation out of TUI on an actual native %s response', async response => {
  const f = await nativeLifecycleFixture(response)
  await writeFile(f.gate, 'ready')
  const running = await runNativeLifecycle(f)
  const context = { processId: running.child.pid!, nativeActor: { protocolId: 'codex-app-server-v2-0.163', actorId: 'original-actor',
    lifecycleOperationId: 'original-lifecycle', token: 'a'.repeat(64), launch: { command: f.plan.command, args: [] } }, workspacePath: f.root, signal: new AbortController().signal }
  let latest: import('../src/agent-terminal-frontend.js').AgentTerminalFrontendObservation | undefined
  await expect.poll(async () => { try { await access(codexFrontendSocketPath(context.nativeActor.token)); return true } catch { return false } }).toBe(true)
  const observation = await observeCodexTerminalFrontend({ ...context, onFrontend: value => { latest = value }, onUnavailable() {} })
  cleanup.push(async () => observation.dispose())
  await expect.poll(() => latest?.initialization?.phase, { timeout: 10_000 }).toBe('unknown')
  expect(latest?.initialization?.failure?.message).toContain('did not confirm')
  await expect(readFile(f.marker)).rejects.toMatchObject({ code: 'ENOENT' })
  running.stop(); await expect(running.completed).resolves.toMatchObject({ exitCode: 1 })
})


it.runIf(process.platform === 'darwin')('keeps the original backend working after exact child exit and reconnects once without replay after a lost receipt', async () => {
  const f = await nativeLifecycleFixture()
  await writeFile(f.gate, 'ready')
  const running = await runNativeLifecycle(f)
  const context = { processId: running.child.pid!, nativeActor: { protocolId: 'codex-app-server-v2-0.163', actorId: 'original-actor',
    lifecycleOperationId: 'original-lifecycle', token: 'a'.repeat(64), launch: { command: f.plan.command, args: ['resume', f.plan.resume!.threadId] } },
    nativeHandle: { kind: 'provider' as const, providerId: 'codex', sessionId: f.plan.resume!.threadId },
    assertCurrent: async () => { expect(running.child.exitCode).toBeNull(); expect(running.child.signalCode).toBeNull() },
    workspacePath: f.root, signal: new AbortController().signal }
  let latest: import('../src/agent-terminal-frontend.js').AgentTerminalFrontendObservation | undefined
  await expect.poll(() => readFile(f.marker, 'utf8').then(() => true, () => false), { timeout: 10_000 }).toBe(true)
  const observer = await observeCodexTerminalFrontend({ ...context, onFrontend: value => { latest = value }, onUnavailable: () => {} })
  cleanup.push(async () => observer.dispose())
  await expect.poll(() => latest?.state).toBe('detached')
  const original = latest!, heartbeat = await readFile(f.marker + '.heartbeat', 'utf8')
  await expect.poll(() => readFile(f.marker + '.heartbeat', 'utf8')).not.toBe(heartbeat)
  expect(running.child.exitCode).toBeNull()
  await expect(reconnectCodexTerminalFrontend(context, { operationId: 'wrong-target', expectedFrontendId: original.frontendId,
    target: { kind: 'native-session', nativeSessionId: 'foreign-native-thread' } })).rejects.toMatchObject({ code: 'AGENT_TERMINAL_FRONTEND_UNCONFIRMED' })
  expect((await readFile(f.marker + '.events', 'utf8')).trim().split('\n')).toHaveLength(1)
  const request = { operationId: 'same-original-reconnect', expectedFrontendId: original.frontendId, target: { kind: 'native-session' as const, nativeSessionId: f.plan.resume!.threadId } }
  // Abandon only the response; the wrapper retains this same original operation.
  const { createConnection } = await import('node:net')
  const { codexFrontendSocketPath } = await import('../src/providers/codex-managed-frontend.js')
  const socket = createConnection(codexFrontendSocketPath(context.nativeActor.token))
  await once(socket, 'connect')
  socket.end(JSON.stringify({ operationId: request.operationId, expectedFrontendId: request.expectedFrontendId, nativeSessionId: request.target.nativeSessionId, method: 'reconnect', token: context.nativeActor.token,
    actorId: context.nativeActor.actorId, lifecycleOperationId: context.nativeActor.lifecycleOperationId, processId: context.processId }) + '\n')
  await expect.poll(async () => (await readFile(f.marker + '.events', 'utf8')).trim().split('\n').length).toBe(2)
  const resumed = await reconnectCodexTerminalFrontend(context, request)
  expect(resumed.frontendId).not.toBe(original.frontendId)
  expect(await reconnectCodexTerminalFrontend(context, request)).toEqual(resumed)
  const events = (await readFile(f.marker + '.events', 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(events).toHaveLength(2)
  expect(events[1].args.slice(4)).toEqual(['resume', request.target.nativeSessionId])
  expect(JSON.stringify(events[1])).not.toContain('Original continuation prompt')
  const prejoins = (await readFile(f.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    .filter(row => row.method === 'thread/resume' && row.params.excludeTurns === false)
  expect(prejoins.length).toBeGreaterThan(0)
  for (const row of prejoins) expect(row.params).toEqual({ threadId: request.target.nativeSessionId, excludeTurns: false })
  await expect.poll(() => latest?.frontendId === resumed.frontendId && latest.state === 'detached', { timeout: 10_000 }).toBe(true)
  await expect(reconnectCodexTerminalFrontend(context, { ...request, operationId: 'stale-reconnect' })).rejects.toThrow('generation changed')
  running.stop()
  await expect(running.completed).resolves.toEqual({ exitCode: 1, stderr: '' })
})


it.runIf(process.platform === 'darwin')('settles the original wrapper when its backend exits by signal during frontend startup', async () => {
  const f = await nativeLifecycleFixture()
  await writeFile(f.gate, 'ready')
  // Hold only the tail's schedule while the exact backend exits by signal.
  const gate = join(f.root, 'settle-backend')
  const running = await runNativeLifecycle(f, gate)
  await expect.poll(() => readFile(f.marker, 'utf8').then(() => true, () => false), { timeout: 10_000 }).toBe(true)
  const listener = (await nativeProcessTcpListeners(running.child.pid!, new AbortController().signal))[0]!
  process.kill(listener.processId, 'SIGTERM')
  await expect.poll(async () => (await nativeProcessTcpListeners(running.child.pid!, new AbortController().signal)).length).toBe(0)
  await writeFile(gate, 'consume original backend exit')
  await expect(running.completed).resolves.toEqual({ exitCode: 1, stderr: '' })
})
