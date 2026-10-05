import { fixturePath as _reshape_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ts from 'typescript'
import { CtxmuxClient } from '../../../packages/core/node_modules/@ctxmux/sdk/dist/index.js'
import { createPrivateRuntimeScope } from '../scripts/package-runtime-upgrade.mjs'

const core = resolve(import.meta.dirname, '../../../packages/core')
const roots: string[] = [], children: ChildProcess[] = [], records: unknown[] = []
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch (error) {
  if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error } }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function wait(check: () => Promise<void>) {
  const end = Date.now() + 10_000
  for (;;) { try { await check(); return } catch (error) { if (Date.now() > end) throw error; await sleep(20) } }
}
async function scope() { const scope = await createPrivateRuntimeScope(core); roots.push(scope.directory); return scope }
async function daemon(scope: Awaited<ReturnType<typeof createPrivateRuntimeScope>>, state = scope.stateDirectory) {
  await mkdir(state, { recursive: true, mode: 0o700 })
  const child = spawn(scope.daemonPath, ['--socket', scope.socketPath, '--state-dir', state], { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''; child.stderr!.on('data', data => { stderr += data })
  children.push(child)
  const client = new CtxmuxClient({ socketPath: scope.socketPath })
  await wait(async () => { expect(child.exitCode, stderr).toBeNull(); expect(await client.runtimeInfo()).toHaveProperty('daemonInstanceId') })
  return { child, client }
}
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  // Corrective cleanup owns direct children created by this private test, independently of the
  // production cleanup under test. It never searches processes or touches default Runtime/Run IDs.
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) {
    const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit
  }
  if (process.env.T008_EVIDENCE_DIRECTORY) {
    await mkdir(process.env.T008_EVIDENCE_DIRECTORY, { recursive: true })
    await writeFile(join(process.env.T008_EVIDENCE_DIRECTORY, 'actual-native.json'), JSON.stringify(records, null, 2) + '\n')
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe.runIf(process.platform === 'darwin')('private cleanup consumes the qualified native owner', () => {
  it('binds native birth to libproc starttime independently of display locale and timezone', async () => {
    const own = await scope(), { child } = await daemon(own)
    const before = await own.observeOwner()
    expect(before.birth).toMatch(/^[1-9][0-9]*:[0-9]{1,6}$/)
    vi.stubEnv('TZ', 'Pacific/Kiritimati'); vi.stubEnv('LC_ALL', 'zh_CN.UTF-8')
    const after = await own.observeOwner()
    expect(after.birth).toBe(before.birth); expect(after.pid).toBe(child.pid)
    const exit = once(child, 'exit'), receipt = await own.cleanup(); await exit
    expect(receipt.birth).toBe(before.birth); expect(alive(child.pid!)).toBe(false)
    records.push({ test: 'kernel-birth-display-independent', before, after, receipt,
      nativeExit: { code: child.exitCode, signal: child.signalCode } })
  }, 30_000)
  it('confirms only its original daemon exit, preserving a peer daemon and an argv lookalike', async () => {
    const own = await scope(), peer = await scope(), a = await daemon(own), b = await daemon(peer)
    const lookalike = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', '--', own.daemonPath, own.socketPath], { stdio: 'ignore' })
    children.push(lookalike)
    const original = await own.observeOwner(); expect(original.pid).toBe(a.child.pid)
    expect(original.state.directory).toBe(own.stateDirectory)
    const observedOwner = structuredClone(original)
    // A consumer editing observation metadata cannot mutate the handle's retained owner.
    original.pid = b.child.pid!; original.state.directory = peer.stateDirectory
    const exit = once(a.child, 'exit')
    const outcome = await own.cleanup().then(receipt => ({ receipt }), error => ({ error }))
    expect(outcome).toHaveProperty('receipt')
    const receipt = (outcome as { receipt: any }).receipt; await exit
    expect(receipt).toMatchObject({ status: 'exited', pid: a.child.pid, signals: ['SIGTERM'], exitConfirmed: true })
    expect(alive(a.child.pid!)).toBe(false); expect(alive(b.child.pid!)).toBe(true); expect(alive(lookalike.pid!)).toBe(true)
    expect(await b.client.runtimeInfo()).toHaveProperty('daemonInstanceId')
    records.push({ test: 'own-only-exit', observedOwner, consumerMutation: original, receipt, nativeExit: { code: a.child.exitCode, signal: a.child.signalCode },
      peerPid: b.child.pid, peerAlive: alive(b.child.pid!), lookalikePid: lookalike.pid, lookalikeAlive: alive(lookalike.pid!) })
  }, 30_000)

  it('refuses a socket serving another private state and retains the profile and live daemon', async () => {
    const own = await scope(), other = await scope(), { child } = await daemon(own, other.stateDirectory)
    const result = await own.cleanup().then(receipt => ({ receipt }), error => ({ error }))
    expect(result).toHaveProperty('error.code', 'PRIVATE_RUNTIME_CLEANUP_UNCONFIRMED')
    expect(alive(child.pid!)).toBe(true); expect((await stat(own.directory)).isDirectory()).toBe(true)
    records.push({ test: 'foreign-state-refused', daemonPid: child.pid, daemonAlive: alive(child.pid!),
      cleanup: 'error' in result ? { code: result.error.code, cause: result.error.cause?.message, detail: result.error.detail } : result })
  }, 30_000)

  it('does not mistake a missing socket observation for confirmation that no daemon exists', async () => {
    const own = await scope()
    await expect(own.cleanup()).rejects.toMatchObject({ code: 'PRIVATE_RUNTIME_CLEANUP_UNCONFIRMED' })
    expect((await stat(own.directory)).isDirectory()).toBe(true)
    records.push({ test: 'missing-owner-retained', directory: own.directory })
  })

  it('rechecks the original process before signalling a replacement socket owner', async () => {
    const own = await scope(), first = await daemon(own)
    const original = await own.observeOwner()
    const exit = once(first.child, 'exit'); first.child.kill('SIGTERM'); await exit
    const replacement = await daemon(own)
    const outcome = await own.cleanup().then(receipt => ({ receipt }), error => ({ error }))
    expect(outcome).toHaveProperty('error.code', 'PRIVATE_RUNTIME_CLEANUP_UNCONFIRMED')
    expect(alive(replacement.child.pid!)).toBe(true)
    expect(await replacement.client.runtimeInfo()).toHaveProperty('daemonInstanceId')
    records.push({ test: 'replacement-owner-retained', original, replacementPid: replacement.child.pid,
      replacementAlive: true, outcome: 'error' in outcome ? { code: outcome.error.code, cause: outcome.error.cause?.message } : outcome })
  }, 30_000)

  it('reobserves the serving owner before signalling an original process that is still alive', async () => {
    const own = await scope(), other = await scope(), original = await daemon(own)
    await own.observeOwner()
    await rename(own.socketPath, join(own.directory, 'original.sock'))
    const replacement = await daemon(own, other.stateDirectory)
    const outcome = await own.cleanup().then(receipt => ({ receipt }), error => ({ error }))
    expect(outcome).toHaveProperty('error.code', 'PRIVATE_RUNTIME_CLEANUP_UNCONFIRMED')
    expect(alive(original.child.pid!)).toBe(true); expect(alive(replacement.child.pid!)).toBe(true)
    records.push({ test: 'fresh-owner-before-signal', originalPid: original.child.pid, replacementPid: replacement.child.pid,
      originalAlive: true, replacementAlive: true })
  }, 30_000)

  it('waits for actual native exit rather than treating a successful signal as cleanup', async () => {
    const own = await scope(), { child } = await daemon(own)
    await own.observeOwner()
    // Control only SIGTERM's write acknowledgement: the actual qualified daemon keeps
    // serving. Owner reads, liveness, the later SIGKILL and the process exit are real.
    const kill = process.kill.bind(process)
    let acknowledge!: () => void
    const acknowledged = new Promise<void>(resolve => { acknowledge = resolve })
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === child.pid && signal === 'SIGTERM') { acknowledge(); return true }
      return kill(pid, signal)
    })
    let settled = false
    const exit = once(child, 'exit'), cleanup = own.cleanup().then(receipt => ({ receipt }), error => ({ error }))
      .finally(() => { settled = true })
    await acknowledged; await sleep(200)
    expect(settled).toBe(false); expect(alive(child.pid!)).toBe(true)
    expect(await new CtxmuxClient({ socketPath: own.socketPath }).runtimeInfo()).toHaveProperty('daemonInstanceId')
    const outcome = await cleanup; expect(outcome).toHaveProperty('receipt')
    const receipt = (outcome as { receipt: any }).receipt; await exit
    expect(receipt).toMatchObject({ status: 'exited', pid: child.pid, signals: ['SIGTERM', 'SIGKILL'], exitConfirmed: true })
    expect(alive(child.pid!)).toBe(false)
    records.push({ test: 'actual-exit-after-signal', controlledTermAcknowledgement: true, receipt,
      nativeExit: { code: child.exitCode, signal: child.signalCode } })
  }, 30_000)
})

const packageSource = await readFile(new URL('../scripts/package-macos.mjs', import.meta.url), 'utf8')
const ast = ts.createSourceFile('package-macos.mjs', packageSource, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS)
const functions = ast.statements.filter(ts.isFunctionDeclaration)
const body = (name: string) => { const f = functions.find(node => node.name?.text === name); expect(f?.body).toBeDefined(); return f!.getText(ast) }
// Execute the actual packaging consumer. LaunchServices/App presentation is the controlled
// boundary; the Core daemon factory, owner checks, signals and native exit are actual production.
it.runIf(process.platform === 'darwin').each([false, true])('actual launch smoke cleanup unavailable=%s preserves exact native facts', async unavailable => {
  const root = await realpath(await mkdtemp(_reshape_fixturePath("tmp/amx-pkg-native-"))); roots.push(root)
  const app = join(root, 'AgentMux.app'), packagedCore = join(app, 'Contents/Resources/app/node_modules/@agentmux/core')
  await mkdir(join(app, 'Contents/MacOS'), { recursive: true }); await mkdir(resolve(packagedCore, '..'), { recursive: true })
  await symlink(core, packagedCore)
  await writeFile(join(app, 'Contents/MacOS/AgentMux'), 'controlled presentation fixture; never executed')
  const verification = join(root, 'verification'); await mkdir(verification)
  const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version
  let created: Awaited<ReturnType<typeof createPrivateRuntimeScope>> | undefined
  const create = async (path: string) => { created = await createPrivateRuntimeScope(path); roots.push(created.directory);
    return unavailable ? { ...created, cleanup: async () => { throw Object.assign(new Error('Controlled owner observation unavailable'),
      { code: 'PRIVATE_RUNTIME_CLEANUP_UNCONFIRMED' }) } } : created }
  const launchSpawn: typeof spawn = ((command: string, args: string[], options: any) => {
    if (command !== 'open') return spawn(command, args, options)
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_|ELECTRON_)/u.test(key)))
    for (let i = 0; i < args.length; i++) if (args[i] === '--env') {
      const next = args[++i]!, split = next.indexOf('='); environment[next.slice(0, split)] = next.slice(split + 1)
    }
    environment.AGENTMUX_MESSAGE_QUEUE_PATH = join(environment.AGENTMUX_DESKTOP_USER_DATA!, 'messages.ndjson')
    environment.AGENTMUX_AGENT_SESSION_STORE = join(environment.AGENTMUX_DESKTOP_USER_DATA!, 'sessions.json')
    const program = `import { AgentMuxClient, AgentMuxMemoryAgentSessionStore } from ${JSON.stringify(pathToFileURL(join(packagedCore, 'dist/index.js')).href)};
      import { writeFile } from 'node:fs/promises';
      const client = new AgentMuxClient({store:new AgentMuxMemoryAgentSessionStore()});
      await client.connect(); await client.dispose();
      await writeFile(process.env.AGENTMUX_DESKTOP_READY_FILE,JSON.stringify(${JSON.stringify({ productName: 'AgentMux', version, packaged: true, executable: join(app, 'Contents/MacOS/AgentMux') })}));`
    const child = spawn(process.execPath, ['--input-type=module', '-e', program], { ...options, env: environment }); children.push(child); return child
  }) as typeof spawn
  const run = new Function('spawn', `return (${body('run')})`)(launchSpawn)
  const waitForPath = new Function('pathExists', `return (${body('waitForPath')})`)(async (path: string) => stat(path).then(() => true, () => false))
  const dependencies = { realpath, join, mkdir, readFile, writeFile, rm, sep, process, PRODUCT_NAME: 'AgentMux', manifest: { version },
    createPrivateRuntimeScope: create, processIdsForApplication: async () => [],
    scopedProcesses: async () => ({ nodeModes: [], ownershipObservation: { identities: new Map() } }), run, waitForPath,
    waitForProcessExit: async () => [], cleanupProcessScope: async () => [],
    pathExists: async (path: string) => stat(path).then(() => true, () => false),
    assert: (value: unknown, message: string) => { if (!value) throw new Error(message) } }
  const consume = new Function(...Object.keys(dependencies), `return (${body('verifyLaunchServices')})`)(...Object.values(dependencies))
  let productCleanupConfirmed = false
  try {
    if (unavailable) {
      await expect(consume(app, verification)).rejects.toBeInstanceOf(AggregateError)
      expect((await stat(created!.directory)).isDirectory()).toBe(true)
      const owner = await created!.observeOwner(); expect(alive(owner.pid)).toBe(true)
      records.push({ test: 'packaging-unknown-retained', owner, directoryRetained: true, daemonAlive: true })
    } else {
      await consume(app, verification)
      const receipt = JSON.parse(await readFile(join(verification, 'runtime-cleanup.json'), 'utf8'))
      expect(receipt).toMatchObject({ status: 'exited', signals: ['SIGTERM'], exitConfirmed: true })
      expect(alive(receipt.pid)).toBe(false)
      const profile = await stat(created!.directory).then(() => ({ exists: true }), error => ({ exists: false, code: error.code }))
      expect(profile).toMatchObject({ exists: false, code: 'ENOENT' })
      productCleanupConfirmed = true
      records.push({ test: 'packaging-consumer', packageSourceSha256: createHash('sha256').update(packageSource).digest('hex'), receipt,
        producer: 'controlled LaunchServices invokes real private Core factory; no installed App or user Run' })
    }
  } finally {
    // Corrective cleanup uses the same qualified scope only after the product observation.
    if (created && !productCleanupConfirmed) {
      try { await created.cleanup() }
      catch (error) {
        // Unknown cleanup must also preserve this test's private diagnostics.
        // Never delete the profile merely because a corrective observation failed.
        const index = roots.indexOf(created.directory); if (index >= 0) roots.splice(index, 1)
        records.push({ test: 'corrective-cleanup-unconfirmed', directory: created.directory, error: String(error) })
        throw error
      }
    }
  }
}, 30_000)
