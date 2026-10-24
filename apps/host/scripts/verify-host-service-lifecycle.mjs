import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { stopProbeProcesses } from '../../desktop/scripts/probe-process.mjs'
import assertCoreDistBuiltFromCurrentSource from '../../../vitest.dist-freshness.ts'

assert.equal(process.platform, 'darwin', 'This qualification requires the actual macOS service manager')
await assertCoreDistBuiltFromCurrentSource()
const root = resolve(import.meta.dirname, '../../..'), exec = promisify(execFile)
const mutation = process.argv.find(value => value.startsWith('--mutation='))?.split('=')[1]
const fixture = await mkdtemp(join(tmpdir(), 'amx-service-'))
const runtime = join(fixture, 'r'), state = join(fixture, 's'), main = join(fixture, 'out/main'), assets = join(fixture, 'out/mobile')
const storePath = join(state, 'sessions.json'), socketPath = join(runtime, 'control.sock')
const corePath = join(root, 'packages/core/dist/index.js'), hostPath = join(root, 'apps/host/src/host.ts')
const environment = { AGENTMUX_RUNTIME_DIRECTORY: runtime, AGENTMUX_STATE_DIRECTORY: state }
const sleep = ms => new Promise(yes => setTimeout(yes, ms))
const until = async (read, accept, label, budget = 20_000) => {
  const deadline = Date.now() + budget
  let value, last
  while (Date.now() < deadline) {
    try { value = await read(); if (accept(value)) return value } catch (error) { last = error }
    await sleep(50)
  }
  throw new Error(`${label} was not confirmed`, { cause: last ?? value })
}
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex')
const sources = ['apps/host/src/macos-service.ts', 'apps/host/src/index.ts', 'apps/host/src/host.ts',
  'packages/core/src/headless-runtime.ts', 'apps/desktop/src/main/desktop-host.ts', 'apps/desktop/scripts/package-semantic-host.mjs']
const sourceDigests = Object.fromEntries(await Promise.all(sources.map(async path => [path, hash(await readFile(join(root, path)))])))
const artifactPaths = [...['index', 'hosted', 'headless-runtime', 'public-rpc-client', 'control-endpoint-listener-worker', 'note-merge-worker']
  .map(name => 'packages/core/dist/' + name + '.js'), 'packages/core/vendor/ctxmux/' + process.platform + '-' + process.arch + '/bin/ctxmuxd']
const artifacts = async () => Object.fromEntries(await Promise.all(artifactPaths.map(async path => [path, hash(await readFile(join(root, path)))])))
const candidateIdentity = async () => {
  const git = async (...args) => (await exec('git', args, { cwd: root, encoding: 'utf8' })).stdout.trim()
  const [commit, tree, mainCommit, status] = await Promise.all([
    git('rev-parse', 'HEAD'), git('rev-parse', 'HEAD^{tree}'), git('rev-parse', 'main'),
    git('status', '--porcelain', '--untracked-files=normal')])
  await git('merge-base', '--is-ancestor', commit, 'main')
  const mainTree = await git('rev-parse', mainCommit + '^{tree}')
  return { commit, tree, mainCommit, mainTree, inMain: true, clean: status === '' }
}
const receiptDirectory = join(root, '.local/state/mobile-independent-host/service'), receiptPath = join(receiptDirectory, 'receipt.json')
const qualification = mutation ? null : { schema: 'agentmux.host-service-qualification.v1',
  candidate: await candidateIdentity(), artifacts: await artifacts(), sources: sourceDigests,
  environment: { platform: process.platform, architecture: process.arch, node: process.versions.node },
  scope: 'Private macOS GUI service, actual Desktop connector and production Node Host entry, original public RPC, official ctxmux and original terminal Run. The HTTP asset is a private placeholder; formal Mobile UI is qualified separately. No user App, physical phone, cloud, logout or shutdown qualification.',
  platform: { command: 'node apps/host/scripts/verify-host-service-lifecycle.mjs' + (process.argv.includes('--mutations') ? ' --mutations' : ''), passed: false, status: 'running', checks: [], mutants: {} }, compiled: {} }
if (qualification) {
  await mkdir(receiptDirectory, { recursive: true, mode: 0o700 })
  await writeFile(receiptPath, JSON.stringify(qualification, null, 2) + '\n', { mode: 0o600 })
}
let baseline
let service, managed, client, run, native, owner
let core, hosted, rpc
const clients = []
try {
  for (const directory of [runtime, state, main, assets]) await mkdir(directory, { mode: 0o700, recursive: true })
  await writeFile(join(fixture, 'package.json'), JSON.stringify({type:'module'}))
  await symlink(join(root, 'apps/host/node_modules'), join(fixture, 'node_modules'), 'dir')
  const html = '<!doctype html><title>Independent Host</title><p>original mobile bytes</p>'
  await writeFile(join(assets, 'index.html'), html)
  const manifest = { schema: 'agentmux.mobile-web-release.v1', buildId: 'private-service',
    files: [{ path: 'index.html', bytes: Buffer.byteLength(html), digest: hash(html) }] }
  await writeFile(join(assets, 'mobile-release.json'), JSON.stringify({ ...manifest, digest: hash(JSON.stringify(manifest)) }))

  let source = await readFile(join(root, 'apps/host/src/macos-service.ts'), 'utf8')
  if (mutation === 'restart') {
    assert.ok(source.includes('<key>KeepAlive</key><true/>'))
    source = source.replace('<key>KeepAlive</key><true/>', '<key>KeepAlive</key><false/>')
  }
  if (mutation === 'stop-fence') {
    const original = "if (current.owner.runtimeId !== expected.owner.runtimeId || current.owner.ownerInstanceId !== expected.owner.ownerInstanceId ||"
    assert.ok(source.includes(original))
    source = source.replace(original, 'if (false && (current.owner.runtimeId !== expected.owner.runtimeId || current.owner.ownerInstanceId !== expected.owner.ownerInstanceId ||')
      .replace('current.storePath !== expected.storePath) throw failure(', 'current.storePath !== expected.storePath)) throw failure(')
  }
  const serviceModule = join(fixture, 'service.mjs')
  await build({ stdin: { contents: source, resolveDir: join(root, 'apps/host/src'), sourcefile: 'macos-service.ts', loader: 'ts' },
    outfile: serviceModule, bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node24' })
  managed = await import(pathToFileURL(serviceModule).href)
  if (qualification) qualification.compiled.service = hash(await readFile(serviceModule))
  if (mutation) console.log(JSON.stringify({ mutation, originalSourceSHA256: sourceDigests['apps/host/src/macos-service.ts'],
    evaluatedSourceSHA256: hash(source) }))
  core = await import(pathToFileURL(corePath).href)
  hosted = await import(pathToFileURL(join(root, 'packages/core/dist/hosted.js')).href)
  const worker = join(main, 'agentmux-host.js')
  await build({ entryPoints: [join(root, 'apps/host/src/index.ts')], outfile: worker, bundle: true, packages: 'external',
    platform: 'node', format: 'esm', target: 'node24',
    // This guard runs before any product owner can touch a non-fixture namespace.
    banner: { js: `if (process.env.AGENTMUX_RUNTIME_DIRECTORY !== ${JSON.stringify(runtime)} || process.env.AGENTMUX_STATE_DIRECTORY !== ${JSON.stringify(state)} || process.env.AGENTMUX_AGENT_SESSION_STORE !== ${JSON.stringify(storePath)}) throw Error('The private namespace is required');` },
    plugins: [{ name: 'private-listen-port', setup(context) {
      context.onResolve({ filter: /^\.\/host\.js$/ }, args => args.importer === join(root, 'apps/host/src/index.ts')
        ? { path: 'private-listen-port', namespace: 'private-host' } : undefined)
      context.onLoad({ filter: /.*/, namespace: 'private-host' }, () => ({ loader: 'ts', resolveDir: root,
        contents: `import {startAgentMuxHost as start,agentMuxHostStore} from ${JSON.stringify(hostPath)};export {agentMuxHostStore};export const startAgentMuxHost=options=>start({...options,mobilePort:0});` }))
    } }] })
  if (qualification) qualification.compiled.entrypoint = hash(await readFile(worker))
  service = managed.macosHostService({ executable: process.execPath, entrypoint: worker, storePath, socketPath,
    mobileBuildDirectory: assets, workspaceMoveHelper: join(fixture, 'resources/bin/agentmux-workspace-move'), environment })
  assert.ok(!JSON.stringify(service.environment).includes('AGENTMUX_AGENT_SESSION_ID'))
  assert.equal(service.environment.AGENTMUX_RUNTIME_DIRECTORY, runtime)
  assert.equal(service.environment.AGENTMUX_STATE_DIRECTORY, state)

  // The launcher is an independent short-lived process, like Desktop. Its exit cannot
  // retain a JavaScript timer or child reference as an accidental service supervisor.
  const desktop = join(main, 'desktop-host.mjs')
  await build({ entryPoints: [join(root, 'apps/desktop/src/main/desktop-host.ts')], outfile: desktop,
    bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node24',
    plugins: [{ name: 'qualified-service-module', setup(context) {
      context.onResolve({ filter: /^@agentmux\/host\/macos-service$/ }, () => ({ path: serviceModule, external: true }))
    } }] })
  if (qualification) qualification.compiled.connector = hash(await readFile(desktop))
  const launcher = join(fixture, 'launcher.mjs')
  await writeFile(launcher, `import {connectDesktopAgentMuxHost} from ${JSON.stringify(pathToFileURL(desktop).href)};import {AgentMuxFileAgentSessionStore} from ${JSON.stringify(pathToFileURL(corePath).href)};const client=await connectDesktopAgentMuxHost({id:'local',kind:'local'},new AgentMuxFileAgentSessionStore(${JSON.stringify(storePath)}));await client.readAgentSessions();await client.dispose();`)
  const launchEnvironment = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_'))), ...environment }
  const launched = spawn(process.execPath, [launcher], { env: launchEnvironment, stdio: ['ignore', 'pipe', 'pipe'] })
  let launcherErrors = ''; launched.stderr.on('data', bytes => { launcherErrors += bytes })
  const [launchExit] = await once(launched, 'exit')
  assert.equal(launchExit, 0, launcherErrors)
  owner = await managed.inspectMacosHostService(service)
  assert.notEqual(owner.process.pid, launched.pid)
  assert.equal(owner.owner.processId, owner.process.pid)
  assert.equal((await managed.macosHostServiceRegistration(service)).pid, owner.process.pid)

  const connect = async () => {
    const transport = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } })
    clients.push(transport)
    const consumer = await hosted.connectHostedAgentMux({ rpc: transport, expectedStorePath: storePath,
      expectedRuntimeId: owner.owner.runtimeId })
    clients.push(consumer)
    return { consumer, transport }
  }
  ;({ consumer: client, transport: rpc } = await connect())
  await client.connectRuntime()
  native = client.runtimeIdentity()
  run = await client.createTerminal({ command: process.execPath, args: ['-e', 'process.stdin.pipe(process.stdout)', '--', join(fixture, 'terminal')], workspacePath: fixture, createOperationId: 'private-service-terminal' })
  const sameRun = async () => {
    const original = (await client.listRuns()).find(value => value.runId === run.runId)
    assert.equal(original.state, 'running'); assert.equal(original.pid, run.pid)
    assert.equal(client.runtimeIdentity().instanceId, native.instanceId)
    return original
  }
  await sameRun()
  const publication = async expected => {
    const lines = (await readFile(service.logPath, 'utf8')).trim().split('\n')
    return lines.flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
      .findLast(value => value.protocol === 'jsonrpc-2.0' && value.owner.ownerInstanceId === expected.owner.ownerInstanceId)
  }
  const page = async expected => {
    const ready = await until(() => publication(expected), Boolean, 'actual Host publication')
    const url = new URL(ready.mobileAccess.origin); url.hostname = '127.0.0.1'
    const response = await fetch(url)
    assert.equal(response.status, 200); assert.ok((await response.text()).includes('original mobile bytes'))
    return url.origin
  }
  const firstOrigin = await page(owner)
  assert.equal((await managed.inspectMacosHostService(service)).owner.ownerInstanceId, owner.owner.ownerInstanceId,
    'Ending the Desktop-like launcher preserves the same live Host')
  await assert.rejects(managed.stopMacosHostService(service, { ...owner,
    owner: { ...owner.owner, ownerInstanceId: 'another-owner' } }), /owner changed/)
  await sameRun(); assert.equal((await fetch(firstOrigin)).status, 200)

  const original = owner
  process.kill(owner.process.pid, 'SIGKILL')
  owner = await until(() => managed.inspectMacosHostService(service), value => value.owner.ownerInstanceId !== original.owner.ownerInstanceId,
    'platform automatic Host recovery').catch(async failure => {
      let registration
      try { registration = await managed.macosHostServiceRegistration(service) }
      catch { throw failure }
      // A deadline alone proves no mutation rejection. Only the exact platform
      // registration can confirm this job remained loaded without a process.
      if (!registration || registration.pid !== null) throw failure
      try { assert.notEqual(registration.pid, null, 'platform automatic Host recovery was not confirmed') }
      catch (assertion) {
        if (!(assertion instanceof assert.AssertionError)) throw assertion
        console.log(JSON.stringify({ stage: 'host-recovery-assertion', mutation: mutation ?? null, registration,
          assertion: { name: assertion.name, code: assertion.code, message: assertion.message,
            actual: assertion.actual, expected: assertion.expected, operator: assertion.operator } }))
        throw assertion
      }
    })
  assert.equal(owner.owner.runtimeId, original.owner.runtimeId)
  ;({ consumer: client, transport: rpc } = await connect())
  await client.connectRuntime(); await sameRun(); await page(owner)

  // Public shutdown ends the whole original process. The platform's running intent
  // may restart it; this RPC is not a maintenance bootout of the registered service.
  const beforeShutdown = owner
  const result = await rpc.call('runtime.owner.shutdown', { fence: {
    runtimeId: owner.owner.runtimeId, ownerInstanceId: owner.owner.ownerInstanceId } })
  assert.equal(result.accepted, true)
  await until(() => managed.inspectMacosHostProcess(beforeShutdown.process.pid), value => !value || value.birth !== beforeShutdown.process.birth,
    'complete original Host shutdown')
  owner = await until(() => managed.inspectMacosHostService(service), value => value.owner.ownerInstanceId !== beforeShutdown.owner.ownerInstanceId,
    'platform convergence after owner shutdown')
  ;({ consumer: client, transport: rpc } = await connect())
  await client.connectRuntime(); await sameRun(); await page(owner)

  await managed.stopMacosHostService(service, owner)
  assert.equal(await managed.macosHostServiceRegistration(service), null, 'Maintenance removes the job before any image replacement')
  assert.equal(await managed.inspectMacosHostProcess(run.pid) !== null, true, 'Platform job cleanup preserves the original independent Run')
  owner = await managed.ensureMacosHostService(service)
  ;({ consumer: client, transport: rpc } = await connect())
  await client.connectRuntime(); await sameRun(); await page(owner)
  assert.equal(owner.owner.runtimeId, original.owner.runtimeId)
  await client.stopTerminal({ runId: run.runId })
  run = undefined
  for (const [path, digest] of Object.entries(sourceDigests)) assert.equal(hash(await readFile(join(root, path))), digest,
    'The qualified source changed during this lifecycle proof: ' + path)
  baseline = { passed: true, sources: sourceDigests,
    checks: ['launcher-exit', 'same-Host-HTTP', 'wrong-owner-retained', 'crash-recovery', 'same-Runtime-and-Run', 'whole-owner-shutdown', 'bootout-before-restart'] }
  console.log(JSON.stringify(baseline))
} finally {
  for (const value of clients.reverse()) await value.dispose().catch(() => {})
  if (service) {
    // This exact unique label was created by this fixture. Cleanup has no user target.
    await exec('/bin/launchctl', ['bootout', service.target]).catch(() => {})
    assert.equal(await managed.macosHostServiceRegistration(service), null, 'The private platform job must be gone before removing its namespace')
  }
  await stopProbeProcesses(process.pid + 1_000_000_000, fixture)
  await rm(fixture, { recursive: true, force: true })
}

if (process.argv.includes('--mutations')) {
  for (const name of ['restart', 'stop-fence']) {
    const failed = await exec(process.execPath, [import.meta.filename, `--mutation=${name}`], { timeout: 90_000, maxBuffer: 128 * 1024 })
      .then(() => null, error => { if (error.killed || error.signal) throw error; return error })
    assert.ok(failed, `The real lifecycle proof must reject ${name}`)
    const observations = String(failed.stdout).trim().split('\n').flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
    const evaluated = observations.find(value => value.mutation === name && value.evaluatedSourceSHA256)
    assert.ok(evaluated && evaluated.originalSourceSHA256 !== evaluated.evaluatedSourceSHA256,
      `The actual service mutation must be evaluated: ${name}`)
    const failure = name === 'restart' ? 'platform automatic Host recovery was not confirmed' : 'Missing expected rejection.'
    assert.ok(String(failed.stderr).includes('AssertionError [ERR_ASSERTION]: ' + failure),
      `The actual lifecycle assertion must reject ${name}: ${failed.stderr}`)
    const recovery = name === 'restart' ? observations.find(value => value.stage === 'host-recovery-assertion' && value.mutation === name) : null
    if (name === 'restart') {
      assert.ok(recovery, 'The actual recovery assertion must report its authoritative registration observation')
      assert.deepEqual(recovery.registration, { pid: null })
      assert.deepEqual(recovery.assertion, { name: 'AssertionError', code: 'ERR_ASSERTION', message: failure,
        actual: null, expected: null, operator: 'notStrictEqual' })
    }
    assert.ok(Number.isInteger(failed.code) && failed.code !== 0, 'The mutant must finish with an actual failing exit code')
    const rejected = { mutation: name, originalSourceSHA256: evaluated.originalSourceSHA256,
      evaluatedSourceSHA256: evaluated.evaluatedSourceSHA256, exitCode: failed.code, assertion: failure, rejected: failed.code !== 0,
      ...(recovery ? { registration: recovery.registration, assertionError: recovery.assertion } : {}) }
    qualification.platform.mutants[name] = rejected
    console.log(JSON.stringify(rejected))
  }
  console.log('Host lifecycle mutations rejected: restart, stop-fence')
}
if (qualification) {
  const current = await candidateIdentity()
  const original = qualification.candidate
  const unchanged = current.commit === original.commit && current.tree === original.tree && current.clean === original.clean
  qualification.candidate = { ...original, clean: current.clean && original.clean, unchanged }
  for (const [path, digest] of Object.entries(sourceDigests)) assert.equal(hash(await readFile(join(root, path))), digest,
    'The qualified source changed during the complete lifecycle proof: ' + path)
  assert.deepEqual(await artifacts(), qualification.artifacts, 'Executed Core or native artifacts changed during the lifecycle proof')
  qualification.platform.checks = baseline.checks
  qualification.platform.passed = baseline.passed
  qualification.platform.status = process.argv.includes('--mutations') ? 'baseline-and-mutations-confirmed' : 'baseline-confirmed'
  qualification.platform.cleanup = 'The actual baseline and mutant processes completed the original private job/process cleanup assertions before this receipt was written.'
  await writeFile(receiptPath, JSON.stringify(qualification, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify({ qualificationReceipt: '.local/state/mobile-independent-host/service/receipt.json', candidate: qualification.candidate,
    platform: qualification.platform.status }))
}
