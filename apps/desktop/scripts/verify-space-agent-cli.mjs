import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { AgentMuxFileAgentSessionStore, connectLocalAgentMux } from '../../../packages/core/dist/index.js'
import { runProbeProcess, listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'

const execFile = promisify(execFileCallback)
const desktop = path.resolve(import.meta.dirname, '..')
const root = path.resolve(desktop, '../..')
const fixture = path.join(desktop, 'scripts/fixtures/space-agent-cli')
const evidence = path.resolve(process.argv[2] ?? path.join(root, '.tmp/space-agent-cli/last'))
const require = createRequire(path.join(desktop, 'package.json'))
const { build } = await import(pathToFileURL(require.resolve('vite')).href)
const electron = process.env.AGENTMUX_PROOF_ELECTRON_PATH ?? require('electron')
const privateRoot = await fs.realpath(await fs.mkdtemp('/tmp/amx-space-'))
const hash = value => createHash('sha256').update(value).digest('hex')
const receipt = { schema: 'agentmux.space-agent-cli.native.v1', passed: false, phases: [], inputs: null, inputsAfter: null, cleanup: null,
  limitations: ['Private ordinary Electron generations share one private ctxmux daemon and private durable AgentSession store.',
    'Actual CLI bin/dist, Control socket, production Desktop IPC bridge, Renderer API, App/Store/WorkspaceWorkbench/SessionPane/TerminalView, Main resource owners and public Core are exercised.',
    'The native Provider process is the repository fake Codex CLI; it emits authenticated hooks and a real native handle. No upstream Provider version is claimed.',
    'Optional warm shell creation is excluded at the private API boundary; all four task Agents and their terminal consumers are real.',
    'A successful empty first startup snapshot and an owner exit after real localStorage intent admission are private boundary faults. No production outage is claimed.',
    'Electron flushStorageData has no disk ACK. Receipts continue to say diskDurability=unconfirmed; the later independent process read is separately observed.',
    'No user App, profile, Session, Run, config or shared Runtime is accessed.'] }
const files = async directory => (await Promise.all((await fs.readdir(directory, { withFileTypes: true })).map(entry => entry.isDirectory()
  ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]))).flat()
const sourceFiles = [new URL(import.meta.url).pathname, path.join(desktop, 'scripts/probe-process.mjs'),
  path.join(desktop, 'scripts/fixtures/terminal-wheel/xterm-instrumented.ts'), ...await files(fixture),
  ...await files(path.join(desktop, 'src')), ...await files(path.join(root, 'packages/core/src')),
  ...await files(path.join(root, 'packages/core/dist')), ...await files(path.join(root, 'packages/core/vendor/ctxmux')),
  path.join(root, 'packages/core/package.json'), path.join(root, 'packages/core/scripts/build.mjs'),
  path.join(root, 'packages/core/test/fixtures/fake-codex-cli.mjs'), path.join(root, 'pnpm-lock.yaml'), electron]
const hashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file => [path.relative(root, file), hash(await fs.readFile(file))])))
const previousEnvironment = new Map(['AGENTMUX_RUNTIME_DIRECTORY', 'AGENTMUX_STATE_DIRECTORY', 'AGENTMUX_MESSAGE_QUEUE_PATH'].map(name => [name, process.env[name]]))
let client
await fs.mkdir(evidence, { recursive: true })
try {
  receipt.inputs = await hashes()
  for (const directory of ['repo', 'caller', 'other', 'topics', 'directory']) await fs.mkdir(path.join(privateRoot, directory))
  await execFile('git', ['init', '-b', 'main', path.join(privateRoot, 'repo')])
  await fs.writeFile(path.join(privateRoot, 'repo/input.txt'), 'Private proof source\n')
  await execFile('git', ['-C', path.join(privateRoot, 'repo'), 'add', 'input.txt'])
  await execFile('git', ['-C', path.join(privateRoot, 'repo'), '-c', 'user.name=Private proof', '-c', 'user.email=proof@invalid', 'commit', '-m', 'Private input'])
  await fs.mkdir(path.join(privateRoot, 'node_modules/@agentmux'), { recursive: true })
  await fs.symlink(path.join(root, 'packages/core'), path.join(privateRoot, 'node_modules/@agentmux/core'))
  await fs.copyFile(path.join(root, 'packages/core/test/fixtures/fake-codex-cli.mjs'), path.join(privateRoot, 'fake-codex-cli.mjs'))
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error',
    define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"', __TERMINAL_WHEEL_UMD_URL__: '"unused"' },
    resolve: { alias: [{ find: /^@xterm\/xterm$/, replacement: path.join(desktop, 'scripts/fixtures/terminal-wheel/xterm-instrumented.ts') }] },
    build: { target: 'esnext', outDir: path.join(privateRoot, 'renderer'), emptyOutDir: true } })
  await build({ configFile: false, root: fixture, logLevel: 'error',
    ssr: { noExternal: ['zod'] },
    build: { ssr: path.join(fixture, 'main.ts'), target: 'node22', outDir: path.join(privateRoot, 'main'), emptyOutDir: true,
      rollupOptions: { external: ['electron', '@agentmux/core', /^@agentmux\/core\//], output: { format: 'es', entryFileNames: 'main.mjs' } } } })
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  for (const phase of ['seed', 'restore', 'empty-restore', 'admission', 'after-admission']) {
    const phaseRoot = path.join(privateRoot, `phase-${phase}`)
    await fs.mkdir(phaseRoot)
    await fs.rm(path.join(evidence, `${phase}.json`), { force: true })
    const stderr = []
    const exit = await runProbeProcess(electron, [path.join(privateRoot, 'main/main.mjs'), path.join(privateRoot, 'renderer/index.html'),
      privateRoot, phase, path.join(fixture, 'preload.cjs'), evidence, process.execPath, path.join(root, 'packages/core/bin/agentmux'), phaseRoot],
      { temporaryRoot: phaseRoot, cwd: root, env, timeoutMs: 150000, onLine: line => { stderr.push(line.slice(0, 1800)); process.stderr.write(`${phase}: ${line.slice(0, 350)}\n`) } })
    const entry = { phase, exit, stderr }; receipt.phases.push(entry)
    await fs.writeFile(path.join(evidence, `${phase}-stderr.log`), stderr.join('\n'))
    const native = JSON.parse(await fs.readFile(path.join(evidence, `${phase}.json`), 'utf8')); entry.native = native
    assert.equal(exit.timedOut, false, `${phase} watchdog fired`)
    assert.equal(exit.exitCode, 0, native.failure?.message)
    assert.equal(native.passed, true)
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
  assert.equal(new Set(receipt.phases.map(phase => phase.native.pid)).size, 5)
  assert.ok(receipt.phases.find(one => one.phase === 'restore').native.restartProjectionNavigation,
    'A real restarted owner consumes Open Session without changing the moved projection graph')
  assert.equal(receipt.phases.find(one => one.phase === 'empty-restore').native.emptySnapshotRetained, true)
  assert.ok(receipt.phases.find(one => one.phase === 'after-admission').native.admissionOnlyReconciled)
  receipt.inputsAfter = await hashes()
  assert.deepEqual(receipt.inputsAfter, receipt.inputs, 'Source changed during private verification')
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  const errors = []
  try {
    if (!client && receipt.phases.length > 0) {
      process.env.AGENTMUX_RUNTIME_DIRECTORY = path.join(privateRoot, 'runtime')
      process.env.AGENTMUX_STATE_DIRECTORY = path.join(privateRoot, 'runtime', 'state')
      process.env.AGENTMUX_MESSAGE_QUEUE_PATH = path.join(privateRoot, 'messages.ndjson')
      client = await connectLocalAgentMux({ store: new AgentMuxFileAgentSessionStore(path.join(privateRoot, 'agent-sessions.json')) })
    }
    if (client) { for (const run of await client.listRuns()) if (run.state === 'running') await client.stopTerminal({ runId: run.runId }); await client.dispose() }
  } catch (error) { errors.push(error.message) }
  try { await stopProbeProcesses(process.pid + 1_000_000_000, privateRoot) } catch (error) { errors.push(error.message) }
  receipt.cleanup = { errors, remaining: await listProbeProcesses(-1, privateRoot), temporaryRootRemoved: false }
  if (receipt.cleanup.remaining.length === 0) { await fs.rm(privateRoot, { recursive: true, force: true }); receipt.cleanup.temporaryRootRemoved = true }
  for (const [name, value] of previousEnvironment) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
  await fs.writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2))
}
assert.deepEqual(receipt.cleanup.errors, [])
assert.deepEqual(receipt.cleanup.remaining, [])
assert.equal(receipt.cleanup.temporaryRootRemoved, true)
assert.equal(receipt.passed, true, receipt.failure?.message)
console.log(JSON.stringify({ passed: true, phases: receipt.phases.map(phase => ({ phase: phase.phase, pid: phase.native.pid })), survivingRuns: receipt.survivingRuns, cleanup: receipt.cleanup }))
