import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { appendFile, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createConnection } from 'node:net'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { parseTerminalFrontendObservation, type AgentTerminalFrontendObservation } from '../src/agent-terminal-frontend.js'
import { prepareCodexManagedLaunch } from '../src/providers/codex-native-input.js'
import { codexFrontendSocketPath, openCodexFrontendControl, observeCodexTerminalFrontend, reconnectCodexTerminalFrontend,
  CODEX_NATIVE_TOKEN_ENV, CODEX_ACTOR_ID_ENV, CODEX_ACTOR_LIFECYCLE_ENV } from '../src/providers/codex-managed-frontend.js'
import type { CodexManagedRunPlan } from '../src/providers/codex-managed-run.js'

const cleanups: Array<() => Promise<unknown>> = []
let root: string, worker: string
const sid = '00000000-0000-4000-8000-000000000001'
const mutations: Record<string, [string, string]> = {
  'deadline-preflight': ["nativeConnection.request('account/read', { refreshToken: false }, { retainPending: true })", "nativeConnection.request('account/read', { refreshToken: false })"],
  'drop-preflight-retry': ['if (nativeRequested || nativeSessionId || !live()) return Promise.resolve()', "if (initialization.phase === 'failed' || nativeRequested || nativeSessionId || !live()) return Promise.resolve()"],
  'repeat-unknown': ['if (nativeRequested || nativeSessionId || !live()) return Promise.resolve()', 'if (nativeSessionId || !live()) return Promise.resolve()'],
  'accept-old-frontend': ['frontend.frontendId === expectedId', 'true'],
  'carry-input': ["['resume', nativeSessionId!, ...plan.frontendArgs], frontend.frontendId", "['resume', nativeSessionId!, ...plan.frontendArgs, 'UNAUTHORIZED_INITIAL_INPUT'], frontend.frontendId"],
  'ignore-native-policy': ['expected.approvalPolicy !== undefined && prepared.approvalPolicy !== expected.approvalPolicy ||', '']
}
const rpcMutations: Record<string, [string, string]> = {
  'deadline-initialize': ['options?.retainPendingInitialization ? { retainPending: true } : undefined', 'undefined']
}
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'amux-initialization-')))
  worker = join(root, 'worker.mjs')
  await build({ entryPoints: [new URL('../src/providers/codex-managed-run.ts', import.meta.url).pathname], outfile: worker,
    bundle: true, platform: 'node', format: 'esm', target: 'node24',
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    plugins: [{ name: 'bounded-observer-clock', setup(builder) {
      builder.onLoad({ filter: /codex-(managed-run|native-rpc)\.ts$/ }, async ({ path }) => {
        const original = await readFile(path, 'utf8')
        // Observation time only; keep the original request and every business fact unchanged.
        let contents = original.replace('const INITIALIZATION_OBSERVATION_MS = 8_000', 'const INITIALIZATION_OBSERVATION_MS = 1000')
        const mutation = process.env.AGENTMUX_CODEX_INITIALIZATION_MUTATION
        const change = mutation ? (path.endsWith('codex-managed-run.ts') ? mutations : rpcMutations)[mutation] : undefined
        if (mutation && !mutations[mutation] && !rpcMutations[mutation]) throw new Error('Unknown initialization mutation: ' + mutation)
        if (change) {
          if (contents.split(change[0]).length !== 2) throw new Error('Initialization mutation must match one original implementation site: ' + mutation)
          contents = contents.replace(change[0], change[1])
        }
        if (process.env.AGENTMUX_CODEX_INITIALIZATION_LOADED) await appendFile(process.env.AGENTMUX_CODEX_INITIALIZATION_LOADED,
          JSON.stringify({ path, mutation: change ? mutation : null, originalSHA256: createHash('sha256').update(original).digest('hex'),
            loadedSHA256: createHash('sha256').update(contents).digest('hex') }) + '\n')
        return { loader: 'ts', contents }
      })
    } }] })
})
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of cleanups.splice(0).reverse()) { try { await close() } catch (error) { errors.push(error) } }
  if (errors.length) throw new AggregateError(errors, 'Private initialization cleanup failed')
})
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }) })
async function rows(path: string): Promise<any[]> { return await readFile(path, 'utf8').then(text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)), () => []) }

async function fixture(options: { accountFailure?: boolean; readGate?: 'initialize' | 'account/read'; nativeGate?: boolean; nativeError?: boolean; wrongPolicy?: boolean; resume?: boolean } = {}) {
  const directory = await realpath(await mkdtemp(join(root, 'case-')))
  const executable = join(directory, 'native'), log = join(directory, 'rpc.jsonl'), events = join(directory, 'frontends.jsonl'), heartbeat = join(directory, 'heartbeat.json')
  const fail = join(directory, 'account-failure'), gate = join(directory, 'native-gate'), readGate = join(directory, 'read-gate')
  if (options.accountFailure) await writeFile(fail, 'private preflight error')
  if (options.nativeGate) await writeFile(gate, 'hold original response')
  if (options.readGate) await writeFile(readGate, 'hold original read response')
  await writeFile(executable, `#!/usr/bin/env node
const {createRequire}=require('node:module');const {WebSocketServer}=createRequire(${JSON.stringify(import.meta.url)} )(${JSON.stringify(createRequire(import.meta.url).resolve('ws'))});
const {appendFileSync,existsSync,writeFileSync}=require('node:fs');const args=process.argv.slice(2);
if(args.includes('--version')){console.log('codex-cli 0.163.0');process.exit(0)}
if(args.includes('app-server')){
 setInterval(()=>writeFileSync(${JSON.stringify(heartbeat)},JSON.stringify({pid:process.pid,time:Date.now()})),40);
 let effective;const server=new WebSocketServer({port:0,host:'127.0.0.1'});
 server.on('connection',(socket,req)=>{if(req.headers.authorization!=='Bearer '+process.env.${CODEX_NATIVE_TOKEN_ENV})process.exit(9);
 socket.on('message',async bytes=>{const r=JSON.parse(String(bytes));appendFileSync(${JSON.stringify(log)},JSON.stringify(r)+String.fromCharCode(10));if(!Object.hasOwn(r,'id'))return;
 const reply=result=>socket.send(JSON.stringify({jsonrpc:'2.0',id:r.id,result}));
 const error=(code,message)=>socket.send(JSON.stringify({jsonrpc:'2.0',id:r.id,error:{code,message}}));
 if(r.method===${JSON.stringify(options.readGate ?? '')})while(existsSync(${JSON.stringify(readGate)}))await new Promise(resolve=>setTimeout(resolve,10));
 if(r.method==='initialize')return reply({});
 if(r.method==='account/read')return existsSync(${JSON.stringify(fail)})?error(-32041,'Private original account routing failure'):reply({account:null,requiresOpenaiAuth:false});
 if(r.method==='thread/start'||r.method==='thread/resume'){
  while(existsSync(${JSON.stringify(gate)}))await new Promise(resolve=>setTimeout(resolve,10));
  if(${Boolean(options.nativeError)})return error(-32603,'Private original native mutation result unconfirmed');
  effective??={cwd:r.params.cwd,model:r.params.model??'private-model',approvalPolicy:${options.wrongPolicy ? "'on-request'" : "r.params.approvalPolicy??'on-request'"},sandbox:{type:r.params.sandbox==='read-only'?'readOnly':r.params.sandbox==='danger-full-access'?'dangerFullAccess':'workspaceWrite'}};
  return reply({thread:{id:${JSON.stringify(sid)},sessionId:'private-native-runtime',canAcceptDirectInput:true},...effective});
 }
 if(r.method==='thread/read')return reply({thread:{id:${JSON.stringify(sid)},sessionId:'private-native-runtime',canAcceptDirectInput:true}});
 error(-32601,'Unexpected private method');});});
}else{appendFileSync(${JSON.stringify(events)},JSON.stringify({pid:process.pid,args})+String.fromCharCode(10));process.exitCode=1;}
`, { mode: 0o700 })
  const token = randomBytes(32).toString('hex'), lifecycleOperationId = 'original-lifecycle', actorId = 'original-actor'
  const plan: CodexManagedRunPlan = { command: executable, serverConfig: [], frontendArgs: ['--no-alt-screen'],
    ...(options.resume ? { resume: { threadId: sid, sandbox: 'read-only', approvalPolicy: 'never', model: 'private-model', cwd: directory } as const }
      : { create: { sandbox: 'read-only', approvalPolicy: 'never', model: 'private-model', cwd: directory } as const }) }
  const child = spawn(process.execPath, [worker, JSON.stringify(plan)], { cwd: directory, detached: true,
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, CODEX_HOME: directory,
      [CODEX_NATIVE_TOKEN_ENV]: token, [CODEX_ACTOR_ID_ENV]: actorId, [CODEX_ACTOR_LIFECYCLE_ENV]: lifecycleOperationId }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.resume(); let stderr = ''; child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-8192) })
  const ended = new Promise<void>(resolve => child.once('close', () => resolve()))
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM'); const force = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL') } catch {} }, 1500)
      try { await ended } finally { clearTimeout(force) }
    }
    await rm(codexFrontendSocketPath(token), { force: true }); await rm(directory, { recursive: true, force: true })
  })
  const context = { processId: child.pid!, nativeActor: { protocolId: 'codex-app-server-v2-0.163', actorId, token, lifecycleOperationId,
    frontendControl: true as const, initializationControl: true as const, launch: { command: executable, args: [] } },
    nativeHandle: { kind: 'provider' as const, providerId: 'codex', sessionId: sid },
    assertCurrent: async () => { expect(child.exitCode).toBeNull(); expect(child.signalCode).toBeNull() },
    workspacePath: directory, signal: new AbortController().signal }
  let latest: AgentTerminalFrontendObservation | undefined
  // A socket path can exist just before listen is ready. Wait for the actual
  // read-only authenticated observation, rather than treating path creation as readiness.
  let observer: Awaited<ReturnType<typeof observeCodexTerminalFrontend>> | undefined
  await expect.poll(async () => {
    try { observer = await observeCodexTerminalFrontend({ ...context, onFrontend: value => { latest = value }, onUnavailable() {} }); return true }
    catch { return false }
  }, { timeout: 6000 }).toBe(true)
  cleanups.push(async () => observer?.dispose())
  const wait = async (check: (value: AgentTerminalFrontendObservation) => boolean) => {
    try { await expect.poll(() => latest !== undefined && check(latest), { timeout: 6000 }).toBe(true) }
    catch (cause) { throw new Error(JSON.stringify({ latest, stderr, methods: (await rows(log)).map(row => row.method), exitCode: child.exitCode }), { cause }) }
    return latest!
  }
  return { child, context, plan, log, events, heartbeat, fail, gate, readGate, directory, executable, wait,
    current: () => latest!, stderr: () => stderr, methods: async () => (await rows(log)).map(row => row.method) }
}

it.runIf(process.platform === 'darwin').each(['initialize', 'account/read'] as const)('keeps the original slow %s response beyond ten seconds and automatically continues without a second request', async method => {
  const f = await fixture({ readGate: method })
  await expect.poll(() => f.methods()).toContain(method)
  const original = await f.wait(value => value.initialization?.phase === 'unknown')
  const before = JSON.parse(await readFile(f.heartbeat, 'utf8'))
  expect(original.initialization?.failure?.step).toBe(method === 'initialize' ? 'connection' : 'preflight')
  expect(original.initialization?.native).toEqual({ state: 'not-created' })
  // Real wall time exceeds the former RPC deadline; only the observer clock is shortened.
  await new Promise(resolve => setTimeout(resolve, 10_600))
  expect(f.current().initialization?.phase).toBe('unknown')
  const observed = await reconnectCodexTerminalFrontend(f.context, { operationId: 'same-slow-read', expectedFrontendId: original.frontendId,
    target: { kind: 'initialization', lifecycleOperationId: 'original-lifecycle' } })
  expect(observed.initialization?.phase).toBe('unknown')
  expect((await f.methods()).filter(value => value === method)).toHaveLength(1)
  expect((await f.methods()).filter(value => value === 'thread/start')).toHaveLength(0)
  expect(await rows(f.events)).toHaveLength(0)
  await rm(f.readGate)
  // No reconnect/retry after releasing the response: the original actor receives it.
  const ready = await f.wait(value => value.initialization?.phase === 'ready' && value.state === 'detached')
  expect(ready.initialization?.native).toEqual({ state: 'confirmed', sessionId: sid })
  expect(ready.initialization?.lifecycleOperationId).toBe(original.initialization?.lifecycleOperationId)
  expect((await f.methods()).filter(value => value === 'initialize')).toHaveLength(1)
  expect((await f.methods()).filter(value => value === 'account/read')).toHaveLength(1)
  expect((await f.methods()).filter(value => value === 'thread/start')).toHaveLength(1)
  expect((await f.methods()).some(value => ['turn/start', 'turn/steer', 'thread/queue/add'].includes(value))).toBe(false)
  expect(JSON.parse(await readFile(f.heartbeat, 'utf8')).pid).toBe(before.pid)
  expect(f.child.exitCode).toBeNull()
}, 30_000)

it.runIf(process.platform === 'darwin')('retains the original running backend after account failure and retries its exact initialization without any Prompt or duplicate native creation', async () => {
  const f = await fixture({ accountFailure: true })
  const original = await f.wait(value => value.initialization?.phase === 'failed')
  expect(original.state).toBe('starting'); expect(original.exitCode).toBeUndefined()
  expect(original.initialization).toMatchObject({ lifecycleOperationId: 'original-lifecycle', native: { state: 'not-created' },
    failure: { step: 'preflight', code: -32041, message: 'Private original account routing failure' } })
  expect((await f.methods()).filter(method => method === 'thread/start')).toHaveLength(0)
  const before = JSON.parse(await readFile(f.heartbeat, 'utf8'))
  const request = { operationId: 'continue-original', expectedFrontendId: original.frontendId,
    target: { kind: 'initialization' as const, lifecycleOperationId: 'original-lifecycle' } }
  expect((await reconnectCodexTerminalFrontend(f.context, request)).initialization?.phase).toBe('failed')
  await rm(f.fail)
  expect((await reconnectCodexTerminalFrontend(f.context, request)).initialization).toMatchObject({ phase: 'ready', native: { state: 'confirmed', sessionId: sid } })
  await f.wait(value => value.state === 'detached')
  await expect.poll(async () => JSON.parse(await readFile(f.heartbeat, 'utf8')).time).not.toBe(before.time)
  expect(JSON.parse(await readFile(f.heartbeat, 'utf8')).pid).toBe(before.pid); expect(f.child.exitCode).toBeNull()
  await reconnectCodexTerminalFrontend(f.context, request)
  expect((await f.methods()).filter(method => method === 'thread/start')).toHaveLength(1)
  expect((await rows(f.events)).map(row => row.args.slice(4))).toEqual([['resume', sid, '--no-alt-screen']])
  expect((await f.methods()).some(method => ['turn/start', 'turn/steer', 'thread/queue/add'].includes(method))).toBe(false)
})

it.runIf(process.platform === 'darwin')('keeps one original thread/start pending through reader timeouts and accepts its late exact response without resending', async () => {
  const f = await fixture({ nativeGate: true })
  await expect.poll(() => f.methods()).toContain('thread/start')
  const original = f.current()
  const request = { operationId: 'observe-original', expectedFrontendId: original.frontendId,
    target: { kind: 'initialization' as const, lifecycleOperationId: 'original-lifecycle' } }
  const observed = await reconnectCodexTerminalFrontend(f.context, request)
  expect(observed.initialization?.phase).toBe('unknown')
  expect(observed.initialization?.native.state).toBe('unknown')
  expect(observed.initialization?.failure?.step).toBe('native-session')
  expect((await f.methods()).filter(method => method === 'thread/start')).toHaveLength(1)
  expect(await rows(f.events)).toHaveLength(0)
  await rm(f.gate)
  await f.wait(value => value.initialization?.phase === 'ready' && value.state === 'detached')
  expect((await reconnectCodexTerminalFrontend(f.context, request)).initialization?.native).toEqual({ state: 'confirmed', sessionId: sid })
  expect((await f.methods()).filter(method => method === 'thread/start')).toHaveLength(1)
  expect(await rows(f.events)).toHaveLength(1)
})

it.runIf(process.platform === 'darwin')('does not repeat a native mutation whose error supplies no not-applied evidence', async () => {
  const f = await fixture({ nativeError: true }), original = await f.wait(value => value.initialization?.phase === 'unknown' && value.initialization.failure?.code === -32603)
  expect(original.initialization?.failure).toMatchObject({ step: 'native-session', code: -32603 })
  for (const operationId of ['original-reader', 'another-reader']) await reconnectCodexTerminalFrontend(f.context, {
    operationId, expectedFrontendId: original.frontendId, target: { kind: 'initialization', lifecycleOperationId: 'original-lifecycle' }
  })
  expect((await f.methods()).filter(method => method === 'thread/start')).toHaveLength(1)
  expect(await rows(f.events)).toHaveLength(0); expect(f.child.exitCode).toBeNull()
})

it.runIf(process.platform === 'darwin')('requires exact native configuration before starting a TUI', async () => {
  const f = await fixture({ wrongPolicy: true })
  const original = await f.wait(value => value.initialization?.phase === 'unknown' && value.initialization.failure?.message.includes('effective configuration') === true)
  expect(original.initialization?.failure?.message).toContain('effective configuration')
  expect(await rows(f.events)).toHaveLength(0); expect(f.child.exitCode).toBeNull()
})

it.runIf(process.platform === 'darwin')('resumes the original native object before TUI attachment and fences wrong generations and changed duplicate requests', async () => {
  const f = await fixture({ resume: true }), original = await f.wait(value => value.state === 'detached')
  const native = (await rows(f.log)).filter(row => row.method === 'thread/resume')
  expect(native).toHaveLength(1); expect(native[0].params).toMatchObject({ threadId: sid, cwd: f.directory, sandbox: 'read-only', approvalPolicy: 'never', model: 'private-model' })
  expect((await f.methods()).filter(method => method === 'thread/start')).toHaveLength(0)
  await expect(reconnectCodexTerminalFrontend(f.context, { operationId: 'wrong-generation', expectedFrontendId: 'foreign-generation',
    target: { kind: 'native-session', nativeSessionId: sid } })).rejects.toThrow('generation changed')
  const request = { operationId: 'original-reconnect', expectedFrontendId: original.frontendId, target: { kind: 'native-session' as const, nativeSessionId: sid } }
  const result = await reconnectCodexTerminalFrontend(f.context, request)
  expect(await reconnectCodexTerminalFrontend(f.context, request)).toEqual(result)
  await expect(reconnectCodexTerminalFrontend(f.context, { ...request, target: { kind: 'native-session', nativeSessionId: 'another-thread' } })).rejects.toMatchObject({ code: 'AGENT_TERMINAL_FRONTEND_UNCONFIRMED' })
  await expect.poll(async () => (await rows(f.events)).length).toBe(2)
  expect((await rows(f.events)).map(row => row.args.slice(4))).toEqual([['resume', sid, '--no-alt-screen'], ['resume', sid, '--no-alt-screen']])
  const prejoins = (await rows(f.log)).filter(row => row.method === 'thread/resume' && row.params.excludeTurns === false)
  expect(prejoins.length).toBeGreaterThan(0)
  for (const row of prejoins) expect(row.params).toEqual({ threadId: sid, excludeTurns: false })
  expect(f.child.exitCode).toBeNull()
})

it.runIf(process.platform === 'darwin')('freezes an exact post-launch plan without carrying input, while retaining unsupported profile argv as the original CLI capability', async () => {
  const f = await fixture({ accountFailure: true })
  const original = { command: f.executable, args: ['--model', 'private-model', '-C', '.', '--sandbox', 'read-only', '-a', 'never', '--no-alt-screen', '--', 'ORIGINAL_INITIAL_PROMPT'], env: {} }
  const prepared = await prepareCodexManagedLaunch(original, 'another-original-lifecycle', { kind: 'create', prompt: 'ORIGINAL_INITIAL_PROMPT' })
  expect(prepared.promptDelivery).toBe('post-launch'); expect(prepared.nativeActor?.initializationControl).toBe(true)
  expect(prepared.nativeActor?.launch).toEqual({ command: original.command, args: original.args })
  const plan = JSON.parse(prepared.plan.args[1]!)
  expect(plan.create).toEqual({ model: 'private-model', cwd: '.', sandbox: 'read-only', approvalPolicy: 'never' })
  expect(JSON.stringify(plan)).not.toContain('ORIGINAL_INITIAL_PROMPT'); expect(plan.args).toBeUndefined()
  const unsupported = { ...original, args: ['--profile', 'original-profile', '--', 'ORIGINAL_INITIAL_PROMPT'] }
  expect(await prepareCodexManagedLaunch(unsupported, 'profile-original', { kind: 'create', prompt: 'ORIGINAL_INITIAL_PROMPT' })).toEqual({ plan: unsupported })
})

it('validates initialization source identity, native confirmation and original failure fields', () => {
  const base = { frontendId: 'original-frontend', state: 'starting', backendState: 'running', source: 'managed-process', observedAt: 1,
    initialization: { lifecycleOperationId: 'original-lifecycle', phase: 'failed', native: { state: 'not-created' }, failure: { step: 'preflight', code: -32041, message: 'Original raw native reason' } } }
  expect(parseTerminalFrontendObservation(base)).toEqual(base)
  for (const initialization of [{ ...base.initialization, lifecycleOperationId: '' }, { ...base.initialization, phase: 'ready' },
    { ...base.initialization, native: { state: 'not-created', sessionId: 'guessed' } },
    { ...base.initialization, failure: { step: 'guessed', message: 'same diagnostic text' } }]) {
    expect(() => parseTerminalFrontendObservation({ ...base, initialization })).toThrow('initialization observation is invalid')
  }
})

it('keeps the original frozen actor native-session wire at the actual low-level control server and requires an explicit initialization capability', async () => {
  const token = randomBytes(32).toString('hex'), packets: any[] = []
  const frontend: AgentTerminalFrontendObservation = { frontendId: 'original-frontend', state: 'attached', backendState: 'running', source: 'managed-process', observedAt: 1 }
  const server = await openCodexFrontendControl(token, { actorId: 'original-actor', lifecycleOperationId: 'original-lifecycle', processId: process.pid }, {
    current: () => frontend, reconnect: async request => { packets.push(request); return frontend }
  })
  cleanups.push(() => server.close())
  const context = { processId: process.pid, nativeActor: { protocolId: 'codex-app-server-v2-0.163', actorId: 'original-actor', token,
    lifecycleOperationId: 'original-lifecycle', frontendControl: true as const, launch: { command: 'private', args: [] } },
    assertCurrent: async () => {}, workspacePath: root, signal: new AbortController().signal }
  // Wire compatibility only: an already running actor consumes this exact legacy
  // packet. Provider prejoin is exercised by the real detached actor tests above.
  const socket = createConnection(codexFrontendSocketPath(token)); await once(socket, 'connect')
  const received = once(socket, 'data')
  const wire = { method: 'reconnect', token, actorId: context.nativeActor.actorId, lifecycleOperationId: context.nativeActor.lifecycleOperationId,
    processId: context.processId, operationId: 'original', expectedFrontendId: 'original-frontend', nativeSessionId: sid }
  socket.end(JSON.stringify(wire) + '\n')
  expect(JSON.parse(String((await received)[0])).frontend).toEqual(frontend)
  expect(wire).not.toHaveProperty('target'); expect(wire).not.toHaveProperty('initializationOperationId')
  expect(packets).toEqual([{ operationId: 'original', expectedFrontendId: 'original-frontend', target: { kind: 'native-session', nativeSessionId: sid } }])
  await expect(reconnectCodexTerminalFrontend(context, { operationId: 'unsupported', expectedFrontendId: 'original-frontend',
    target: { kind: 'initialization', lifecycleOperationId: 'original-lifecycle' } })).rejects.toThrow('did not declare')
  expect(packets).toHaveLength(1)
})
