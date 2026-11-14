// Run current source in separate processes; no package dist, user Runtime or real Agent is used.
import assert from 'node:assert/strict'
import { fork, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { registerHooks, createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const script = fileURLToPath(import.meta.url), core = resolve(dirname(script), '..')
const check = (condition, message) => assert.ok(condition, `T004: ${message}`)
const mutation = process.env.AGENTMUX_OWNER_RELEASE_MUTATION ?? 'candidate'
const sha = value => createHash('sha256').update(value).digest('hex')
process.umask(0o077)

function sourceLoader() {
  const ts = createRequire(join(core, 'package.json'))('typescript')
  registerHooks({
    resolve(specifier, context, next) {
      if ((specifier.startsWith('.') || specifier.startsWith('/')) && specifier.endsWith('.js') && context.parentURL?.startsWith('file:')) {
        const path = fileURLToPath(new URL(specifier, context.parentURL)), source = path.slice(0, -3) + '.ts'
        if (!existsSync(path) && existsSync(source)) return { url: pathToFileURL(source).href, shortCircuit: true }
      }
      return next(specifier, context)
    },
    load(url, context, next) {
      if (!url.startsWith('file:') || !url.endsWith('.ts')) return next(url, context)
      const path = fileURLToPath(url)
      let source = readFileSync(path, 'utf8')
      const replace = (from, to) => { check(source.includes(from), `mutation anchor ${mutation}`); source = source.replace(from, to) }
      if (path === join(core, 'src/agent-session-store.ts')) {
        if (mutation === 'memory-release') replace('(reservation.preparedSession || reservation.restart || reservation.resolution)', '(reservation.restart || reservation.resolution)')
        if (mutation === 'file-release') replace('(item.preparedSession || item.restart || item.resolution)', '(item.restart || item.resolution)')
        if (mutation === 'schema') replace('!preparedSession && !restart && !resolution', '!restart && !resolution')
      }
      if (path === join(core, 'src/client.ts') && mutation === 'premature-release')
        replace('await this.recovery.dispose()', 'await this.registry.releaseReopenOwner(); await this.recovery.dispose()')
      return { format: 'module', shortCircuit: true, source: ts.transpileModule(source, { fileName: path,
        compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true, esModuleInterop: true } }).outputText }
    }
  })
}

if (process.argv.includes('--probe') || process.argv.includes('--custody-child')) {
  sourceLoader()
  const root = process.env.AGENTMUX_OWNER_RELEASE_ROOT
  check(root, 'isolated root required')
  process.env.AGENTMUX_MESSAGE_QUEUE_PATH = join(root, 'messages.ndjson')
  process.env.AGENTMUX_STATE_DIRECTORY = join(root, 'state')
  process.env.AGENTMUX_RUNTIME_DIRECTORY = join(root, 'runtime')
  const { AgentMuxClient } = await import('../src/client.ts')
  const {AgentMuxMemoryAgentSessionStore, AgentMuxFileAgentSessionStore, normalizeStoredAgentSession} = await import('../src/agent-session-store.ts');
const { agentLifecycleOperationIdentity } = await import('../src/agent-session-identity.ts')
  const { hashAgentCapability, hookBindingIdentity } = await import('../src/agent-capability.ts')
  const { normalizeAgentContinuityPolicy } = await import('../src/agent-session-recovery/continuity-contract.ts')

  async function prepare(store, id) {
    const client = new AgentMuxClient({ store }), sid = `owner-release-${id}`, oid = 'original-resume'
    const operationId = agentLifecycleOperationIdentity('resume', sid, oid), run = { runId: `old-${id}` }
    const nativeTarget = { kind: 'provider', providerId: 'claude', sessionId: `native-${id}` }
    const session = normalizeStoredAgentSession({ kind: 'agent', agentSessionId: sid, providerId: 'claude', executorId: 'proof',
      hostId: 'local', workspacePath: root, run, retiredRuns: [], nativeHandle: nativeTarget, createdAt: 1, updatedAt: 1,
      hookBindingId: 'old-binding', hookToken: 'old-token' })
    await store.compareAndSwap(null, session)
    const reservation = { kind: 'resume', reservationId: `reservation-${id}`, ownerId: client.registry.lifecycleOwnerId,
      ownerPid: process.pid, expiresAt: 1, agentSessionId: sid, expectedRun: run, operationId }
    await store.reserveLifecycle(reservation)
    const continuity = { operationId: oid, agentSessionId: sid, trigger: 'manual', previousRun: run, admittedAt: 1,
      observedAt: 1, rechecks: 0, kind: 'starting', reason: 'explicit-request', evidence: { kind: 'run-ended', state: 'exited', observedAt: 1 },
      nativeTarget, policy: normalizeAgentContinuityPolicy() }
    const capability = 'c'.repeat(43), token = 't'.repeat(43)
    const preparedSession = normalizeStoredAgentSession({ ...session, hookBindingId: hookBindingIdentity(operationId), hookToken: token,
      capabilityHash: hashAgentCapability(capability), continuity, continuityOperations: { [oid]: continuity } })
    const request = { program: '/bin/true', args: [], cwd: root, initial_size: { cols: 80, rows: 24 }, declared_inputs: [], env: {
      AGENTMUX_LIFECYCLE_OPERATION_ID: operationId, AGENTMUX_AGENT_SESSION_ID: sid, AGENTMUX_PROVIDER_ID: 'claude', AGENTMUX_EXECUTOR_ID: 'proof',
      AGENTMUX_AGENT_CAPABILITY: capability, AGENTMUX_HOOK_TOKEN: token } }
    const preparedDispatch = { prepared: { createOperationId: operationId, workspacePath: root, launch: JSON.stringify({ createOperationId: operationId, request }) },
      runtime: { runtimeId: 'isolated-runtime', instanceId: 'isolated-instance', buildIdentity: 'proof-build', protocolVersion: 25 }, nativeTarget }
    await store.prepareResume(reservation, preparedSession, preparedDispatch)
    const original = await store.readLifecycleReservation(sid)
    return { client, sid, run, original, request, preparedDispatch }
  }

  async function readReleased(store, sid) {
    try { return await store.readLifecycleReservation(sid) }
    catch { assert.fail('T004: released prepared resume remains readable by the official schema') }
  }
  if (process.argv.includes('--custody-child')) {
    const store = new AgentMuxFileAgentSessionStore(join(root, 'custody.sqlite')), state = await prepare(store, 'custody')
    process.send({ kind: 'ready', sid: state.sid, owner: state.original.ownerId })
    process.on('message', async message => {
      if (message === 'dispose') { await state.client.dispose(); process.send({ kind: 'disposed' }) }
      if (message === 'exit') process.exit(0)
    })
  } else {
    const rows = []
    for (const type of ['memory', 'file']) {
      const store = type === 'memory' ? new AgentMuxMemoryAgentSessionStore() : new AgentMuxFileAgentSessionStore(join(root, `${type}.sqlite`))
      const state = await prepare(store, type), next = new AgentMuxClient({ store })
      check((await next.registry.claimStaleLifecycles()).length === 0, `${type} live owner cannot be stolen after lease expiry`)
      check(await next.registry.stoppablePreparedResume(state.sid, state.run) === null, `${type} live owner cannot be fenced`)
      // An actual continuity queue operation holds public dispose until its owning work settles.
      let release, entered
      const pending = new Promise(resolve => { release = resolve }), started = new Promise(resolve => { entered = resolve })
      const work = state.client.recovery.continuitySupervisor.serialize(state.sid, async () => { entered(); await pending })
      await started
      let disposed = false
      const disposing = state.client.dispose().then(() => { disposed = true })
      await new Promise(resolve => setTimeout(resolve, 25))
      check(!disposed, `${type} dispose waits for the original in-flight continuity operation`)
      check(!(await readReleased(store, state.sid)).ownerReleased, `${type} custody retained before settlement`)
      release(); await work
      try { await disposing }
      catch { assert.fail('T004: public dispose must persist a schema-valid ordinary prepared owner release') }
      const after = await readReleased(store, state.sid)
      check(after.ownerReleased === true, `${type} ordinary prepared resume released by public dispose`)
      assert.deepEqual(after.preparedDispatch, state.original.preparedDispatch)
      assert.deepEqual(after.preparedSession, state.original.preparedSession)
      check(after.operationId === state.original.operationId, `${type} original operation retained`)
      const claims = await next.registry.claimStaleLifecycles()
      check(claims.length === 1, `${type} successor claims the same saved operation`)
      // Exercise the real Core Stop fence consumer with only its external Native leaf controlled.
      const calls = []
      next.kernel.observePreparedStartRetirement = async (key, runtime) => {
        assert.equal(key, after.operationId); assert.deepEqual(runtime, state.preparedDispatch.runtime)
        calls.push('observe'); return { outcome: 'missing', runtime }
      }
      next.kernel.retirePreparedStart = async (request, key, runtime) => {
        assert.deepEqual(request, state.request); assert.equal(key, after.operationId); assert.deepEqual(runtime, state.preparedDispatch.runtime)
        calls.push('retire'); return { outcome: 'retired', runtime }
      }
      const fence = await next.recovery.fencePreparedResumeForStop(state.sid, state.run)
      check(fence?.witness.fence === 'retired', `${type} successor reaches exact original fence consumer`)
      assert.deepEqual(calls, ['observe', 'retire'])
      await next.dispose()
      rows.push({ store: type, liveOwnerRefused: true, settlementBeforeRelease: true, preservedOriginalDispatch: true, successorExactFence: true })
    }
    // A separate process stays alive after disposing its Client: numeric PID liveness cannot mask an explicit release.
    const child = fork(script, ['--custody-child'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    let childError = ''; child.stderr.on('data', value => { childError += value })
    const receive = kind => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`T004: child ${kind} timed out: ${childError}`)), 15_000)
      const onExit = code => { clearTimeout(timer); reject(new Error(`T004: child exited ${code}: ${childError}`)) }
      const onMessage = message => { if (message.kind === kind) { clearTimeout(timer); child.off('exit', onExit); child.off('message', onMessage); resolve(message) } }
      child.once('exit', onExit); child.on('message', onMessage)
    })
    try {
      const ready = await receive('ready'), store = new AgentMuxFileAgentSessionStore(join(root, 'custody.sqlite'))
      const next = new AgentMuxClient({ store })
      check((await next.registry.claimStaleLifecycles()).length === 0, 'cross-process live owner refused')
      const disposed = receive('disposed'); child.send('dispose'); await disposed
      process.kill(child.pid, 0)
      const original = await readReleased(store, ready.sid)
      check(original.ownerReleased === true, 'cross-process public dispose releases even while PID is alive')
      const claimed = await next.registry.claimStaleLifecycles()
      check(claimed.length === 1 && claimed[0].agentSessionId === ready.sid, 'cross-process successor exact claim')
      assert.deepEqual(claimed[0].preparedDispatch, original.preparedDispatch)
      await next.dispose(); child.send('exit')
      rows.push({ crossProcess: true, originalPidStillAlive: true, realPublicDispose: true, exactClaim: true })
    } finally { if (child.exitCode === null) child.kill() }
    console.log(JSON.stringify({ pass: true, rows, runtimeConnected: false, nativeLeaf: 'controlled only for exact Stop fence', physicalStarts: 0 }))
  }
} else {
  check(process.argv.length === 2, 'no proof options accepted')
  const scratch = await mkdtemp(join(tmpdir(), 'amux-release-'))
  const results = []
  try {
    for (const variant of ['candidate', 'memory-release', 'file-release', 'schema', 'premature-release']) {
      const root = join(scratch, variant); await mkdir(root)
      const result = spawnSync(process.execPath, [script, '--probe'], { encoding: 'utf8', timeout: 45_000, maxBuffer: 1024 * 1024,
        env: { ...process.env, AGENTMUX_OWNER_RELEASE_ROOT: root, AGENTMUX_OWNER_RELEASE_MUTATION: variant } })
      if (variant === 'candidate') { assert.equal(result.status, 0, result.stderr); results.push({ variant, ...JSON.parse(result.stdout.trim()) }) }
      else {
        check(result.status !== 0 && result.stderr.includes('AssertionError') && result.stderr.includes('T004:'), `mutation ${variant} fails a behavioral assertion: ${result.stderr}`)
        results.push({ variant, rejected: true, assertion: result.stderr.match(/T004: [^\n]+/u)?.[0] })
      }
    }
    const sources = ['src/agent-session-store.ts', 'src/client.ts', 'src/agent-session-recovery/service.ts', 'src/agent-session-recovery/supervisor.ts', 'src/agent-session-recovery/lifecycle.ts', 'scripts/verify-resume-owner-release.mjs']
    const receipt = { verdict: 'pass', executedAt: new Date().toISOString(), sourceHashes: Object.fromEntries(await Promise.all(sources.map(async path => [path, sha(await readFile(join(core, path)))]))),
      results, scope: 'Real public Client.dispose, Memory/File schema, separate-process custody, actual Core exact-fence consumer with controlled Native leaf. No real Runtime or Agent starts.', cleanup: 'owned temporary roots removed in finally' }
    if (process.env.AGENTMUX_RELIABILITY_EVIDENCE_DIRECTORY) {
      await mkdir(process.env.AGENTMUX_RELIABILITY_EVIDENCE_DIRECTORY, { recursive: true, mode: 0o700 })
      await writeFile(join(process.env.AGENTMUX_RELIABILITY_EVIDENCE_DIRECTORY, 'resume-owner-release.private.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 })
    }
    console.log(JSON.stringify(receipt, null, 2))
  } finally { await rm(scratch, { recursive: true, force: true }) }
}
