import { createExecutionProofCleanup } from '../../../packages/core/scripts/fixtures/execution-proof-cleanup.mjs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { AgentMuxFileAgentSessionStore, connectLocalAgentMux } from '../../../packages/core/dist/index.js'
import { startToolCores, stopToolCores } from './fixtures/space-agent-cli/tool-cores.mjs'
import { runProbeProcess, listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'

const execFile = promisify(execFileCallback)
const desktop = path.resolve(import.meta.dirname, '..')
const root = path.resolve(desktop, '../..')
const fixture = path.join(desktop, 'scripts/fixtures/space-agent-cli')
const toolMode = process.argv.includes('--tool-workspace')
assert(process.argv.slice(3).every(arg => arg === '--tool-workspace'), 'Only the explicit --tool-workspace scene flag is accepted.')
const evidence = path.resolve(process.argv[2] ?? path.join(root, '.tmp/space-agent-cli/last'))
const require = createRequire(path.join(desktop, 'package.json'))
const { build } = await import(pathToFileURL(require.resolve('vite')).href)
// Resolve the existing Host public exports to this candidate source, as other private Desktop proofs do.
// The installed Host dist may omit source-owned .mjs modules; do not repair shared dist during verification.
const hostExports = JSON.parse(await fs.readFile(path.join(root, 'apps/host/package.json'), 'utf8')).exports
const hostDependencyAliases = ['yaml', 'luxon'].map(name => ({ find: name, replacement: require.resolve(name) }))
const hostAliases = Object.entries(hostExports).map(([key, target]) => ({
  find: new RegExp('^@agentmux/host' + key.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'),
  replacement: path.join(root, 'apps/host', target.import.replace('./dist/', './src/').replace(/\.js$/, '.ts'))
}))
const coreExports = JSON.parse(await fs.readFile(path.join(root, 'packages/core/package.json'), 'utf8')).exports
const coreAliases = Object.entries(coreExports).map(([key, target]) => ({
  find: new RegExp('^@agentmux/core' + (key === '.' ? '' : key.slice(1)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'),
  replacement: path.join(root, 'packages/core', target.import)
}))
const electron = process.env.AGENTMUX_PROOF_ELECTRON_PATH ?? require('electron')
const privateRoot = await fs.realpath(await fs.mkdtemp(path.join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'amx-space-')))
const hash = value => createHash('sha256').update(value).digest('hex')
const receipt = { privateRoot, schema: 'agentmux.space-agent-cli.native.v1', passed: false, phases: [], inputs: null, inputsAfter: null, tools: null, toolsAfter: null, cleanup: null,
  limitations: ['Private ordinary Electron generations share one private ctxmux daemon and private durable AgentSession store.',
    'Actual CLI bin/dist, Control socket, production Desktop IPC bridge, Renderer API, App/Store/WorkspaceWorkbench/SessionPane/TerminalView, Main resource owners and public Core are exercised.',
    'The native Provider process is the repository fake Codex CLI; it emits authenticated hooks and a real native handle. No upstream Provider version is claimed.',
    'Optional warm shell creation is excluded at the private API boundary; all four task Agents and their terminal consumers are real.',
    'A successful empty first startup snapshot and an owner exit after real localStorage intent admission are private boundary faults. No production outage is claimed.',
    'Electron flushStorageData has no disk ACK. The original Core spatial commit acknowledges durableWriteFile/directory sync; Core graph facts and UI request/preferences remain separately observed.',
    'No user App, profile, Session, Run, config or shared Runtime is accessed.'] }
const files = async directory => (await Promise.all((await fs.readdir(directory, { withFileTypes: true })).map(entry => entry.isDirectory()
  ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]))).flat()
const sourceFiles = [new URL(import.meta.url).pathname, path.join(desktop, 'scripts/probe-process.mjs'),
  path.join(desktop, 'scripts/fixtures/terminal-wheel/xterm-instrumented.ts'), ...await files(fixture),
  ...await files(path.join(desktop, 'src')), ...await files(path.join(root, 'apps/host/src')), ...await files(path.join(root, 'packages/core/src')),
  ...await files(path.join(root, 'packages/core/dist')), ...await files(path.join(root, 'packages/core/vendor/ctxmux')),
  path.join(root, 'packages/core/package.json'), path.join(root, 'packages/core/scripts/build.mjs'), path.join(root, 'packages/core/scripts/fixtures/execution-proof-cleanup.mjs'),
  path.join(root, 'packages/core/test/fixtures/fake-codex-cli.mjs'), path.join(root, 'pnpm-lock.yaml')]
const criticalConsumers = new Set(['apps/desktop/src/main/runtime-controller.ts', 'apps/desktop/src/main/control-ipc-bridge.ts',
  'apps/desktop/src/renderer/src/lib/api.ts', 'apps/desktop/src/renderer/src/lib/control-api.ts',
  'apps/desktop/src/renderer/src/lib/space-agent-control.ts', 'apps/desktop/src/renderer/src/lib/desktop-spatial-state.ts',
  'apps/desktop/src/renderer/src/lib/workbench-tabs.ts', 'apps/desktop/src/renderer/src/lib/session-state.ts',
  'apps/desktop/src/shared/contracts.ts', 'apps/desktop/src/shared/space-addresses.ts'])
// This fixture imports compiled Core. Concurrent unconsumed Core source is provenance,
// not the identity of the running artifact; bin/dist/vendor remain exact inputs.
const creationConsumer = name => name.startsWith('packages/core/') && !name.startsWith('packages/core/src/') || criticalConsumers.has(name)
const hashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file => [path.relative(root, file), hash(await fs.readFile(file))])))
const previousEnvironment = new Map(['AGENTMUX_RUNTIME_DIRECTORY', 'AGENTMUX_STATE_DIRECTORY', 'AGENTMUX_MESSAGE_QUEUE_PATH', 'AGENTMUX_SPATIAL_STATE_STORE'].map(name => [name, process.env[name]]))
let client
const toolOwners = []
const toolCleanup = createExecutionProofCleanup(evidence)
await fs.mkdir(evidence, { recursive: true })
try {
  process.env.AGENTMUX_SPATIAL_STATE_STORE = path.join(privateRoot, 'runtime', 'state', 'spatial-state.json')
  receipt.inputs = await hashes()
  if (toolMode) receipt.limitations = ['Single machine; two real isolated Headless Core/ctxmux owners connected through explicitly injected Unix endpoints (not SSH). Two real Electron processes share the original durable workface and native Agent/helper Runs; no model turn is submitted.', 'Compiled CLI -> public RPC -> DesktopControlIpcBridge -> production Renderer space control/store -> RuntimeController -> real AgentExecutionBindingService/Coordinator -> original native helper Runs and Agent Session.', 'Fixture IPC is a bounded private sender boundary, not the entire production registerIpc installation. No model tool effect, WAN or visual-quality qualification is claimed here.', 'Tool data effects and original native conversation recovery are separately qualified by packages/core/scripts/verify-execution-binding.mjs, not simulated here.', 'No user App, profile, Session, Run or shared Runtime is accessed.']
  receipt.tools = { electron: { path: electron, sha256: hash(await fs.readFile(electron)) } }
  for (const directory of ['repo', 'caller', 'other', 'topics', 'directory']) await fs.mkdir(path.join(privateRoot, directory))
  await execFile('git', ['init', '-b', 'main', path.join(privateRoot, 'repo')])
  await fs.writeFile(path.join(privateRoot, 'repo/input.txt'), 'Private proof source\n')
  await execFile('git', ['-C', path.join(privateRoot, 'repo'), 'add', 'input.txt'])
  await execFile('git', ['-C', path.join(privateRoot, 'repo'), '-c', 'user.name=Private proof', '-c', 'user.email=proof@invalid', 'commit', '-m', 'Private input'])
  await fs.mkdir(path.join(privateRoot, 'node_modules/@agentmux'), { recursive: true })
  await fs.symlink(path.join(root, 'packages/core'), path.join(privateRoot, 'node_modules/@agentmux/core'))
  const coreRequire = createRequire(path.join(root, 'packages/core/package.json'))
  await fs.mkdir(path.join(privateRoot, 'node_modules/@noble'), { recursive: true })
  await fs.symlink(path.dirname(coreRequire.resolve('@noble/hashes/utils.js')), path.join(privateRoot, 'node_modules/@noble/hashes'))
  await fs.copyFile(path.join(root, 'packages/core/test/fixtures/fake-codex-cli.mjs'), path.join(privateRoot, 'fake-codex-cli.mjs'))
  let reusedRenderer = false
  if (toolMode && process.env.AGENTMUX_PROOF_RENDERER_RECEIPT) {
    const previous = JSON.parse(await fs.readFile(process.env.AGENTMUX_PROOF_RENDERER_RECEIPT, 'utf8'))
    const relevant = name => creationConsumer(name) && !name.startsWith('apps/desktop/src/main/') || name.startsWith('apps/host/src/') || name === 'pnpm-lock.yaml' ||
      name.startsWith('apps/desktop/scripts/fixtures/') && !name.endsWith('/main.ts') && !name.endsWith('/tool-cores.mjs')
    const exact = Object.entries(receipt.inputs).filter(([name]) => relevant(name))
    assert(exact.length > 100 && exact.every(([name, digest]) => previous.inputs?.[name] === digest), 'A retained renderer must belong to these exact current source/compiled inputs')
    const retained = path.join(previous.privateRoot, 'renderer')
    await fs.cp(retained, path.join(privateRoot, 'renderer'), { recursive: true, errorOnExist: true })
    receipt.rendererReuse = { receipt: path.resolve(process.env.AGENTMUX_PROOF_RENDERER_RECEIPT), originalDirectory: retained, qualifiedInputs: exact.length }
    reusedRenderer = true
  }
  if (!reusedRenderer) await build({ configFile: false, root: fixture, base: './', logLevel: 'error', worker: { format: 'es' },
    define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"', __TERMINAL_WHEEL_UMD_URL__: '"unused"' },
    resolve: { alias: [...coreAliases, ...hostAliases, ...hostDependencyAliases, { find: /^@xterm\/xterm$/, replacement: path.join(desktop, 'scripts/fixtures/terminal-wheel/xterm-instrumented.ts') }] },
    build: { target: 'esnext', minify: false, cssMinify: false, outDir: path.join(privateRoot, 'renderer'), emptyOutDir: true } })
  await build({ configFile: false, root: fixture, logLevel: 'error', resolve: { alias: [...hostAliases, ...hostDependencyAliases] },
    ssr: { noExternal: ['zod'] },
    build: { ssr: path.join(fixture, 'main.ts'), target: 'node22', outDir: path.join(privateRoot, 'main'), emptyOutDir: true,
      rollupOptions: { external: ['electron', '@agentmux/core', /^@agentmux\/core\//], output: { format: 'es', entryFileNames: 'main.mjs' } } } })
  await build({ configFile: false, root: fixture, logLevel: 'error', ssr: { noExternal: true },
    build: { ssr: path.join(fixture, 'preload.ts'), target: 'node22', outDir: path.join(privateRoot, 'preload'), emptyOutDir: true,
      rollupOptions: { external: ['electron'], output: { format: 'cjs', entryFileNames: 'preload.cjs' } } } })
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  for (const name of Object.keys(env)) if (name.startsWith('AGENTMUX_') || name.startsWith('CTXMUX_')) delete env[name]
  Object.assign(env, { AGENTMUX_RUNTIME_DIRECTORY: path.join(privateRoot, 'runtime'),
    AGENTMUX_STATE_DIRECTORY: path.join(privateRoot, 'runtime', 'state'),
    AGENTMUX_SPATIAL_STATE_STORE: path.join(privateRoot, 'runtime', 'state', 'spatial-state.json'),
    AGENTMUX_MESSAGE_QUEUE_PATH: path.join(privateRoot, 'messages.ndjson') })
  receipt.builtInputs = Object.fromEntries(await Promise.all((await files(path.join(privateRoot, 'renderer'))).concat(await files(path.join(privateRoot, 'main')), await files(path.join(privateRoot, 'preload'))).map(async file => [path.relative(privateRoot, file), hash(await fs.readFile(file))])))
  if (toolMode) await startToolCores(privateRoot, path.join(root, 'packages/core'), evidence, toolOwners, toolCleanup)
  for (const phase of toolMode ? ['tool-workspace', 'tool-workspace-restore'] : ['seed', 'restore', 'empty-restore', 'admission', 'after-admission']) {
    const phaseRoot = path.join(privateRoot, `phase-${phase}`)
    await fs.mkdir(phaseRoot)
    await fs.rm(path.join(evidence, `${phase}.json`), { force: true })
    const stderr = []
    const exit = await runProbeProcess(electron, [path.join(privateRoot, 'main/main.mjs'), path.join(privateRoot, 'renderer/index.html'),
      privateRoot, phase, path.join(privateRoot, 'preload/preload.cjs'), evidence, process.execPath, path.join(root, 'packages/core/bin/amux'), phaseRoot],
      { temporaryRoot: phaseRoot, cwd: root, env, timeoutMs: 150000, onSpawn: (_identity, child) => { if (toolMode) toolCleanup.trackChild({ name: phase, base: phaseRoot }, 'electron', child) }, onLine: line => { stderr.push(line.slice(0, 1800)); process.stderr.write(`${phase}: ${line.slice(0, 350)}\n`) } })
    const entry = { phase, exit, stderr }; receipt.phases.push(entry)
    await fs.writeFile(path.join(evidence, `${phase}-stderr.log`), stderr.join('\n'))
    const native = JSON.parse(await fs.readFile(path.join(evidence, `${phase}.json`), 'utf8')); entry.native = native
    assert.equal(exit.timedOut, false, `${phase} watchdog fired`)
    assert.equal(exit.exitCode, 0, native.failure?.message)
    assert.equal(native.passed, true)
    if (toolMode) {
      if (phase === 'tool-workspace') receipt.toolBinding = native.toolBinding
      else { receipt.toolRestart = native.toolRestart; assert.equal(receipt.toolRestart.passed, true); assert.notEqual(receipt.phases[0].native.pid, native.pid) }
      continue
    }
    process.env.AGENTMUX_RUNTIME_DIRECTORY = path.join(privateRoot, 'runtime')
    process.env.AGENTMUX_STATE_DIRECTORY = path.join(privateRoot, 'runtime', 'state')
    process.env.AGENTMUX_MESSAGE_QUEUE_PATH = path.join(privateRoot, 'messages.ndjson')
    client ??= await connectLocalAgentMux({ store: new AgentMuxFileAgentSessionStore(path.join(privateRoot, 'agent-sessions.json')) })
    receipt.runtimeIdentity = client.runtimeIdentity()
    const current = (await client.listRuns()).filter(run => run.state === 'running').map(run => ({ runId: run.runId, pid: run.pid }))
    assert.equal(current.length, 4, 'All four private Agents remain healthy')
    if (phase === 'seed') { receipt.originalRuns = current; receipt.originalSessions = native.persisted }
    else {
      assert.deepEqual(current, receipt.originalRuns, 'Every private owner restart retains exact original Run IDs and PIDs')
      assert.deepEqual(native.persisted, receipt.originalSessions, 'Original Session IDs, creation facts, execution cwd and native handles survive independently')
      receipt.survivingRuns = current
    }
  }
  if (!toolMode) {
  assert.equal(new Set(receipt.phases.map(phase => phase.native.pid)).size, 5)
  assert.ok(receipt.phases.find(one => one.phase === 'restore').native.restartProjectionNavigation,
    'A real restarted owner consumes Open Session without changing the moved projection graph')
  assert.equal(receipt.phases.find(one => one.phase === 'empty-restore').native.emptySnapshotRetained, true)
  assert.ok(receipt.phases.find(one => one.phase === 'after-admission').native.admissionOnlyReconciled)
  }
  receipt.inputsAfter = await hashes()
  receipt.toolsAfter = { electron: { path: electron, sha256: hash(await fs.readFile(electron)) } }
  assert.deepEqual(receipt.toolsAfter, receipt.tools, 'Private Electron tool changed during verification')
  receipt.sourceChanges = Object.keys(receipt.inputsAfter).filter(name => receipt.inputsAfter[name] !== receipt.inputs[name])
  if (toolMode) receipt.coreConsumption = { kind: 'compiled-artifact', sourceCorrespondence: 'unconfirmed-without-a-build-receipt',
    unconsumedSourceChanges: receipt.sourceChanges.filter(name => name.startsWith('packages/core/src/')),
    hashes: Object.fromEntries(Object.entries(receipt.inputs).filter(([name]) => name.startsWith('packages/core/dist/'))) }
  if (toolMode) assert.deepEqual(receipt.sourceChanges.filter(name => creationConsumer(name) || name.startsWith('apps/desktop/scripts/fixtures/space-agent-cli/')), [], 'Creation consumer changed during private verification')
  else assert.deepEqual(receipt.inputsAfter, receipt.inputs, 'Source changed during private verification')
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  const errors = toolMode ? await stopToolCores(toolOwners, evidence, toolCleanup) : []
  try {
    if (!toolMode && !client && receipt.phases.length > 0) {
      process.env.AGENTMUX_RUNTIME_DIRECTORY = path.join(privateRoot, 'runtime')
      process.env.AGENTMUX_STATE_DIRECTORY = path.join(privateRoot, 'runtime', 'state')
      process.env.AGENTMUX_MESSAGE_QUEUE_PATH = path.join(privateRoot, 'messages.ndjson')
      client = await connectLocalAgentMux({ store: new AgentMuxFileAgentSessionStore(path.join(privateRoot, 'agent-sessions.json')) })
    }
    if (client) { for (const run of await client.listRuns()) if (run.state === 'running') await client.stopTerminal({ runId: run.runId }); await client.dispose() }
  } catch (error) { errors.push(error.message) }
  if (!toolMode) try { await stopProbeProcesses(process.pid + 1_000_000_000, privateRoot) } catch (error) { errors.push(error.message) }
  receipt.cleanup = { errors, remaining: toolMode ? toolCleanup.report.records.filter(record => record.kind === 'child' && !record.closed).map(record => record.childPid) : await listProbeProcesses(-1, privateRoot), temporaryRootRemoved: false, ...(toolMode ? { report: path.join(evidence, 'cleanup.json') } : {}) }
  if (errors.length || receipt.cleanup.remaining.length) receipt.passed = false
  if (receipt.cleanup.remaining.length === 0 && (!toolMode || receipt.passed)) { await fs.rm(privateRoot, { recursive: true, force: true }); receipt.cleanup.temporaryRootRemoved = true }
  for (const [name, value] of previousEnvironment) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
  await fs.writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2))
}
assert.deepEqual(receipt.cleanup.errors, [])
assert.deepEqual(receipt.cleanup.remaining, [])
if (!toolMode || receipt.passed) assert.equal(receipt.cleanup.temporaryRootRemoved, true)
assert.equal(receipt.passed, true, receipt.failure?.message)
console.log(JSON.stringify({ passed: true, phases: receipt.phases.map(phase => ({ phase: phase.phase, pid: phase.native.pid })), survivingRuns: receipt.survivingRuns, cleanup: receipt.cleanup }))
