import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const core = join(root, 'packages/core'), require = createRequire(join(core, 'package.json'))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
// Short, private Unix sockets. This fixture never discovers or connects to the user's namespace.
const fixture = await mkdtemp('/tmp/amxo-'), runtime = join(fixture, 'r'), state = join(fixture, 's')
const source = join(core, 'src/capsule-run-manager.ts'), candidate = join(fixture, 'manager.mjs')
const entry = join(fixture, 'owner.mjs'), binding = join(state, 'capsule-service.json')
const daemonPath = join(core, 'vendor/ctxmux', `${process.platform}-${process.arch}`, 'bin/ctxmuxd')
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_'))),
  AGENTMUX_RUNTIME_DIRECTORY: runtime, AGENTMUX_STATE_DIRECTORY: state,
  AGENTMUX_AGENT_SESSION_STORE: join(state, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(state, 'messages.ndjson') }
const receipt = { schema: 'agentmux.capsule-observation-proof.v1', passed: false,
  boundary: 'Current CapsuleRunManager source compiled without overlays; actual compiled Core RPC/server/client/CLI, pinned ctxmux and Capsule processes. Dependency hashes identify the consumed generation; this is not a claim that every concurrent Core change was built.',
  source: { path: 'packages/core/src/capsule-run-manager.ts', sha256: sha(await readFile(source)) },
  artifacts: {}, checks: [] }
let daemon, host, servicePid, runtimeEntry
const owned = new Set()
async function fingerprint(path) { receipt.artifacts[path] = sha(await readFile(path)) }
async function ready(child, stream, label) {
  return await new Promise((yes, no) => {
    let output = '', errors = ''
    const timer = setTimeout(() => no(new Error(`${label} readiness timed out: ${errors}`)), 20_000)
    child.stderr.on('data', data => { errors += data })
    child.once('error', error => { clearTimeout(timer); no(error) })
    child.once('exit', code => { clearTimeout(timer); no(new Error(`${label} exited ${code}: ${errors}`)) })
    stream.on('data', data => { output += data; if (label === 'Native' || output.includes('\n')) { clearTimeout(timer); yes(output) } })
  })
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const closed = once(child, 'close'), deadline = setTimeout(() => child.kill('SIGKILL'), 5000)
  child.kill('SIGTERM'); try { await closed } finally { clearTimeout(deadline) }
}
async function start() {
  host = spawn(process.execPath, [entry], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); owned.add(host)
  await ready(host, host.stdout, 'Core public owner')
}
let sequence = 0
async function owner(action) {
  const id = ++sequence
  return await new Promise((yes, no) => {
    const timer = setTimeout(() => { host.off('message', received); no(new Error(`Owner ${action} timed out`)) }, 15_000)
    const received = result => { if (result.id !== id) return; clearTimeout(timer); host.off('message', received)
      result.error ? no(new Error(result.error)) : yes(result.value) }
    host.on('message', received); host.send({ id, action })
  })
}
async function cli(action, input) {
  const args = [join(core, 'bin/amux'), 'capsule', ...action.split('.')]
  if (input !== undefined) args.push('--input', '-')
  return await new Promise((yes, no) => {
    const child = spawn(process.execPath, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); no(new Error('Private CLI timed out')) }, 15_000)
    child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data })
    child.once('error', error => { clearTimeout(timer); no(error) })
    child.once('close', code => { clearTimeout(timer); try { yes({ code, ...JSON.parse(stdout || stderr) }) }
      catch { no(new Error(`CLI returned no protocol result: ${stderr}`)) } })
    child.stdin.end(input === undefined ? '' : JSON.stringify(input))
  })
}
async function call(action, input) {
  const response = await cli(action, input)
  assert.equal(response.code, 0, `${action}: ${JSON.stringify(response)}`); assert.equal(response.ok, true)
  return response.result
}
async function until(read, accept, label) {
  for (let i = 0; i < 100; i++) { const value = await read(); if (accept(value)) return value
    await new Promise(done => setTimeout(done, 100)) }
  assert.fail(label)
}
async function unchanged(label, read) {
  const before = await readFile(binding), runs = await owner('runs')
  const value = await read()
  assert.deepEqual(await readFile(binding), before, `${label} must preserve original binding bytes`)
  assert.deepEqual(await owner('runs'), runs, `${label} must not start or stop Native Runs`)
  receipt.checks.push(label); return value
}
try {
  await mkdir(runtime, { mode: 0o700 }); await mkdir(join(state, 'ctxmux'), { recursive: true, mode: 0o700 })
  // Compile the owning implementation and bind every dependency to the existing production artifact.
  // No lifecycle method is mocked or replaced. Scheduling starts only when the fixture explicitly asks
  // the original manager to start, so a read cannot be mistaken for an independent background turn.
  const { build } = await import(require.resolve('esbuild'))
  await build({ entryPoints: [source], outfile: candidate, bundle: true, platform: 'node', format: 'esm', target: 'node22',
    plugins: [{ name: 'actual-core-dependencies', setup(build) { build.onResolve({ filter: /.*/ }, async args => {
      if (args.kind === 'entry-point' || args.pluginData?.resolving) return null
      if (args.path.startsWith('node:')) return { path: args.path, external: true }
      const path = args.path.startsWith('./') ? join(core, 'dist', args.path)
        : (await build.resolve(args.path, { resolveDir: dirname(source), kind: 'import-statement', pluginData: { resolving: true } })).path
      if (args.path === '@agentmux/capsule/runtime') runtimeEntry = path
      await fingerprint(path); return { path, external: true }
    }) } }] })
  receipt.candidateSha256 = sha(await readFile(candidate))
  await fingerprint(daemonPath); await fingerprint(join(core, 'vendor/ctxmux', `${process.platform}-${process.arch}`, 'manifest.json'))
  for (const file of await readdir(join(core, 'dist'))) if (file.endsWith('.js')) await fingerprint(join(core, 'dist', file))
  assert.ok(runtimeEntry, 'Actual Capsule runtime package must be consumed')
  for (const file of await readdir(dirname(runtimeEntry))) if (file.endsWith('.js')) await fingerprint(join(dirname(runtimeEntry), file))
  const url = name => JSON.stringify(pathToFileURL(join(core, 'dist', name)).href)
  await writeFile(entry, `import { AgentMuxClient } from ${url('client.js')};
import { AgentMuxMemoryAgentSessionStore } from ${url('agent-session-store.js')};
import { AgentMuxControlServer } from ${url('public-rpc-server.js')};
import { CapsuleRunManager } from ${JSON.stringify(pathToFileURL(candidate).href)};
const client = new AgentMuxClient({ providers: [], store: new AgentMuxMemoryAgentSessionStore() });
await client.connectRuntime();
const manager = new CapsuleRunManager(client, process.env.AGENTMUX_STATE_DIRECTORY);
const server = new AgentMuxControlServer({ coreClients: () => [{ hostId: 'local', client }], capsules: manager, capsuleRuntime: manager.runtime });
await server.start(); process.stdout.write(JSON.stringify({ pid: process.pid }) + '\\n');
process.on('message', async ({ id, action }) => { try {
  const value = action === 'runs' ? (await client.listRuns()).map(run => ({ runId: run.runId, state: run.state })).sort((a,b) => a.runId.localeCompare(b.runId))
    : action === 'lifecycle' ? (manager.start(), true) : (() => { throw new Error('Unknown fixture action') })();
  process.send({ id, value });
} catch (error) { process.send({ id, error: String(error) }); } });
process.once('SIGTERM', async () => { await server.stop(); await manager.dispose(); await client.dispose(); process.exit(0); });
`)
  daemon = spawn(daemonPath, ['--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(state, 'ctxmux'), '--readiness-fd', '3'],
    { env, stdio: ['ignore', 'ignore', 'pipe', 'pipe'] }); owned.add(daemon)
  await ready(daemon, daemon.stdio[3], 'Native'); await start()
  assert.equal((await call('runtime.inspect')).phase, 'unconfigured'); assert.deepEqual(await owner('runs'), [])
  const content = join(fixture, 'content'); await mkdir(content); await writeFile(join(content, 'index.html'), '<html>original-capsule-observation-page</html>')
  const created = await call('create', { operationId: 'original-create', sourcePath: content, mode: 'injected' })
  assert.equal(created.status, 'committed')
  const first = await until(() => call('runtime.inspect'), v => v.phase === 'running', 'Explicit domain mutation starts original service')
  servicePid = first.runtime.pid
  await unchanged('healthy runtime inspect is read-only', () => call('runtime.inspect'))
  await unchanged('original operation query is read-only', async () => {
    const value = await call('operation.inspect', { operationId: 'original-create' }); assert.equal(value.operation.operationId, 'original-create')
  })
  // Restart only this fixture's public owner. No scheduling is installed by the fixture until asked.
  await stop(host); await start()
  const attached = await unchanged('owner restart inspection retains exact Run and runtime', () => call('runtime.inspect'))
  assert.deepEqual(attached.run, first.run); assert.deepEqual(attached.runtime, first.runtime)
  process.kill(servicePid, 'SIGKILL'); servicePid = undefined
  await until(() => owner('runs'), runs => runs.some(run => run.runId === first.run.runId && run.state !== 'running'), 'Native confirms original service termination')
  const terminal = await unchanged('terminal Run inspection cannot replace original generation', () => call('runtime.inspect'))
  assert.equal(terminal.phase, 'unavailable'); assert.deepEqual(terminal.run, first.run)
  await unchanged('original operation query cannot replace terminal generation', async () => {
    const result = await cli('operation.inspect', { operationId: 'original-create' }); assert.notEqual(result.code, 0)
    assert.equal(result.error.code, 'CAPSULE_RUNTIME_UNAVAILABLE')
  })
  await owner('lifecycle')
  const recovered = await until(() => call('runtime.inspect'), v => v.phase === 'running' && v.run.runId !== first.run.runId, 'Original desired lifecycle remains reachable')
  servicePid = recovered.runtime.pid; assert.equal(recovered.runtime.runtimeId, first.runtime.runtimeId)
  assert.ok((await (await fetch(created.endpoint.url)).text()).includes('original-capsule-observation-page'))
  receipt.checks.push('independent desired lifecycle recovers original namespace and page')
  await call('runtime.stop', { operationId: 'original-stop', expectedRevision: recovered.revision, expectedRun: { runId: recovered.run.runId } })
  const stopped = await until(() => call('runtime.inspect'), v => v.phase === 'stopped', 'Explicit Stop remains reachable'); servicePid = undefined
  await stop(host); await start()
  assert.equal((await unchanged('stopped intent survives actual owner restart', () => call('runtime.inspect'))).phase, 'stopped')
  await call('runtime.start', { operationId: 'explicit-resume', expectedRevision: stopped.revision })
  const resumed = await until(() => call('runtime.inspect'), v => v.phase === 'running', 'Explicit Start remains reachable')
  servicePid = resumed.runtime.pid; assert.equal(resumed.runtime.runtimeId, first.runtime.runtimeId)
  assert.notEqual(resumed.run.runId, recovered.run.runId)
  receipt.checks.push('explicit Start and Stop remain reachable through compiled CLI and actual RPC')
  // Recreate the durable checkpoint after dispatch but before binding confirmation, using the
  // actual original prepared launch and Native Run. No invented identity or resend is involved.
  const checkpoint = JSON.parse(await readFile(binding, 'utf8'))
  checkpoint.run = null; checkpoint.launchPhase = 'dispatched'
  await writeFile(binding, JSON.stringify(checkpoint) + '\n')
  const confirmed = await unchanged('dispatched Start observation preserves its unconfirmed binding', () => call('runtime.inspect'))
  assert.deepEqual(confirmed.run, resumed.run); assert.deepEqual(confirmed.runtime, resumed.runtime)
  await call('runtime.stop', { operationId: 'stop-observed-start', expectedRevision: confirmed.revision, expectedRun: { runId: confirmed.run.runId } })
  assert.equal((await until(() => call('runtime.inspect'), v => v.phase === 'stopped', 'Observed original Run remains explicitly stoppable')).phase, 'stopped')
  servicePid = undefined
  receipt.checks.push('explicit Stop accepts the exact observed original creation without read-side binding writes')
  const terminalCheckpoint = JSON.parse(await readFile(binding, 'utf8'))
  terminalCheckpoint.run = null; terminalCheckpoint.launchPhase = 'dispatched'; terminalCheckpoint.stop = null; terminalCheckpoint.stopPhase = null
  await writeFile(binding, JSON.stringify(terminalCheckpoint) + '\n')
  const terminalCreation = await unchanged('terminal dispatched creation is observed without binding confirmation writes', () => call('runtime.inspect'))
  assert.equal(terminalCreation.phase, 'stopped')
  await call('runtime.start', { operationId: 'resume-terminal-creation', expectedRevision: terminalCreation.revision })
  const finalRun = await until(() => call('runtime.inspect'), v => v.phase === 'running' && v.run.runId !== terminalCreation.run.runId,
    'Explicit Start adopts Native terminal creation and creates one next generation')
  servicePid = finalRun.runtime.pid; assert.equal(finalRun.runtime.runtimeId, first.runtime.runtimeId)
  receipt.checks.push('explicit Start remains reachable after observing the original dispatched creation terminal')
  assert.equal(sha(await readFile(source)), receipt.source.sha256, 'Concurrent owning source changed; rerun')
  for (const [path, digest] of Object.entries(receipt.artifacts)) assert.equal(sha(await readFile(path)), digest, `Concurrent artifact changed: ${path}`)
  receipt.passed = true
} finally {
  if (host?.exitCode === null && host?.signalCode === null) try {
    const current = await call('runtime.inspect')
    if (current.desired === 'running') await call('runtime.stop', { operationId: 'fixture-cleanup', expectedRevision: current.revision, expectedRun: current.run ? { runId: current.run.runId } : null })
  } catch {}
  await stop(host)
  if (servicePid) try { process.kill(servicePid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
  for (const child of owned) await stop(child)
  const output = process.argv.indexOf('--output')
  if (output >= 0) { assert.ok(process.argv[output + 1]); await writeFile(resolve(process.argv[output + 1]), JSON.stringify(receipt, null, 2) + '\n') }
  await rm(fixture, { recursive: true, force: true })
}
process.stdout.write(JSON.stringify({ passed: receipt.passed, checks: receipt.checks, candidateSha256: receipt.candidateSha256 }) + '\n')
