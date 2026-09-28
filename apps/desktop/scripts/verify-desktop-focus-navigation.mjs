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
import { sourceUpdateIdentity } from './update-identity.mjs'

const execFile = promisify(execFileCallback)
const desktop = path.resolve(import.meta.dirname, '..')
const root = path.resolve(desktop, '../..')
const fixture = path.join(desktop, 'scripts/fixtures/desktop-focus-navigation')
const evidence = path.resolve(process.argv[2] ?? path.join(root, '.tmp/focus-native-last'))
const diagnosticOnly = process.env.AGENTMUX_FOCUS_PROOF_DIAGNOSTIC === 'delayed-input'
const require = createRequire(path.join(desktop, 'package.json'))
const { build } = await import(pathToFileURL(require.resolve('vite')).href)
const electron = process.env.AGENTMUX_PROOF_ELECTRON_PATH ?? require('electron')
const privateRoot = await fs.realpath(await fs.mkdtemp('/tmp/amx-focus-'))
const privateCore = path.join(privateRoot, 'node_modules/@agentmux/core')
const hash = value => createHash('sha256').update(value).digest('hex')
const files = async directory => (await Promise.all((await fs.readdir(directory, { withFileTypes: true })).map(entry => entry.isDirectory()
  ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]))).flat()
const sourceFiles = [new URL(import.meta.url).pathname, path.join(desktop, 'scripts/probe-process.mjs'),
  path.join(desktop, 'scripts/update-identity.mjs'),
  path.join(desktop, 'scripts/fixtures/terminal-wheel/xterm-instrumented.ts'), ...await files(fixture),
  ...await files(path.join(desktop, 'src')), ...await files(path.join(root, 'packages/core/src')),
  ...await files(path.join(root, 'packages/core/dist')), ...await files(path.join(root, 'packages/core/vendor/ctxmux')),
  ...await files(path.join(root, 'packages/core/bin')), ...await files(path.join(root, 'packages/layout/src')),
  ...await files(path.join(root, 'packages/demand/src')), ...await files(path.join(root, 'packages/demand/dist')),
  path.join(root, 'packages/layout/package.json'),
  path.join(root, 'packages/demand/package.json'),
  path.join(root, 'packages/core/package.json'), path.join(root, 'packages/core/scripts/build.mjs'),
  path.join(root, 'packages/core/test/fixtures/fake-codex-cli.mjs'), path.join(root, 'pnpm-lock.yaml'), electron]
const hashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file => [path.relative(root, file), hash(await fs.readFile(file))])))
const names = ['AGENTMUX_RUNTIME_DIRECTORY', 'AGENTMUX_STATE_DIRECTORY', 'AGENTMUX_MESSAGE_QUEUE_PATH']
const previousEnvironment = new Map(names.map(name => [name, process.env[name]]))
const receipt = { schema: 'agentmux.desktop-focus-navigation.native.v1', passed: false, phases: [],
  scope: diagnosticOnly ? 'diagnostic-delayed-input-only' : 'three-ordinary-generations',
  candidate: null, privateRoot, inputs: null, inputsAfter: null, compiled: null, cleanup: null,
  limitations: [
    'Only this invocation owns the private App profile, Control socket, durable Session store and ctxmux daemon.',
    'Ordinary independent Electron generations load the actual App/Store/Mote/caret owners through the production Control bridge.',
    'The native Provider executable is the repository fake Codex CLI with authenticated hooks and a real Provider native handle; this does not assert upstream Provider behavior.',
    'Renderer API boundaries for config, files and provider discovery are private. Session lifecycle, attachment, bytes, optional warm shells, Scratch resource owner and Demand durability are real.',
    'The empty initial snapshot is one explicit private boundary fault, followed by real canonical reconciliation; no production outage is asserted.',
    'Instant caret is observed again after restart. localStorage write and flush request are not a disk ACK.',
    'Screenshots are capture evidence requiring independent human/Agent visual review; capture success does not sign aesthetic acceptance.'
  ] }
let client
await fs.mkdir(evidence, { recursive: true })
const privateEnvironment = () => {
  process.env.AGENTMUX_RUNTIME_DIRECTORY = path.join(privateRoot, 'runtime')
  process.env.AGENTMUX_STATE_DIRECTORY = path.join(privateRoot, 'runtime', 'state')
  process.env.AGENTMUX_MESSAGE_QUEUE_PATH = path.join(privateRoot, 'messages.ndjson')
}
try {
  const [commit, tree, diff] = await Promise.all([
    execFile('git', ['rev-parse', 'HEAD'], { cwd: root }),
    execFile('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root }),
    execFile('git', ['diff', '--binary', 'HEAD'], { cwd: root, maxBuffer: 32 * 1024 * 1024 })])
  receipt.candidate = { commit: commit.stdout.trim(), tree: tree.stdout.trim(), diffSha256: hash(diff.stdout) }
  receipt.inputs = await hashes()
  for (const directory of ['repo', 'target', 'empty', 'topics']) await fs.mkdir(path.join(privateRoot, directory))
  await execFile('git', ['init', '-b', 'main', path.join(privateRoot, 'repo')])
  await fs.writeFile(path.join(privateRoot, 'repo/input.txt'), 'Private focus proof source\n')
  await execFile('git', ['-C', path.join(privateRoot, 'repo'), 'add', 'input.txt'])
  await execFile('git', ['-C', path.join(privateRoot, 'repo'), '-c', 'user.name=Private proof', '-c', 'user.email=proof@invalid', 'commit', '-m', 'Private input'])
  await execFile('git', ['-C', path.join(privateRoot, 'repo'), 'worktree', 'add', '-b', 'side', path.join(privateRoot, 'repo-side')])
  await fs.mkdir(path.join(privateRoot, 'node_modules/@agentmux'), { recursive: true })
  await fs.mkdir(privateCore)
  // A compiled candidate is immutable for all ordinary processes and public CLI calls.
  // Source SHA remains checked before/after; a peer build cannot replace this loaded artifact.
  for (const name of ['package.json', 'dist', 'bin', 'vendor']) await fs.cp(path.join(root, 'packages/core', name), path.join(privateCore, name), { recursive: true })
  await fs.symlink(path.join(root, 'packages/core/node_modules'), path.join(privateCore, 'node_modules'))
  await fs.symlink(path.join(root, 'packages/demand'), path.join(privateRoot, 'node_modules/@agentmux/demand'))
  await fs.copyFile(path.join(root, 'packages/core/test/fixtures/fake-codex-cli.mjs'), path.join(privateRoot, 'fake-codex-cli.mjs'))
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error',
    define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"', __TERMINAL_WHEEL_UMD_URL__: '"unused"' },
    resolve: { alias: [{ find: /^@xterm\/xterm$/, replacement: path.join(desktop, 'scripts/fixtures/terminal-wheel/xterm-instrumented.ts') }] },
    build: { target: 'esnext', outDir: path.join(privateRoot, 'renderer'), emptyOutDir: true } })
  await build({ configFile: false, root: fixture, logLevel: 'error', ssr: { noExternal: ['zod'] },
    build: { ssr: path.join(fixture, 'main.ts'), target: 'node22', outDir: path.join(privateRoot, 'main'), emptyOutDir: true,
      rollupOptions: { external: ['electron', '@agentmux/core', '@agentmux/demand', /^@agentmux\/core\//],
        output: { format: 'es', entryFileNames: 'main.mjs' } } } })
  receipt.compiled = Object.fromEntries(await Promise.all([...await files(path.join(privateRoot, 'renderer')), ...await files(path.join(privateRoot, 'main'))]
    .map(async file => [path.relative(privateRoot, file), hash(await fs.readFile(file))])))
  receipt.coreArtifact = Object.fromEntries(await Promise.all([path.join(privateCore, 'package.json'), ...await files(path.join(privateCore, 'dist')), ...await files(path.join(privateCore, 'bin')), ...await files(path.join(privateCore, 'vendor'))]
    .map(async file => [path.relative(privateCore, file), hash(await fs.readFile(file))])))
  for (const [file, digest] of Object.entries(receipt.coreArtifact)) assert.equal(digest, receipt.inputs[path.join('packages/core', file)], `Loaded Core candidate: ${file}`)
  receipt.updateIdentity = await sourceUpdateIdentity(root)
  const rendererFiles = Object.fromEntries(Object.entries(receipt.compiled).filter(([file]) => file.startsWith('renderer/')).map(([file, digest]) => [file.slice('renderer/'.length), digest]))
  const rendererId = hash(JSON.stringify({ identity: receipt.updateIdentity, files: Object.entries(rendererFiles).sort() }))
  receipt.rendererRelease = { id: rendererId, identity: receipt.updateIdentity, files: rendererFiles }
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  for (const name of ['AGENTMUX_ENV', 'AGENTMUX_AGENT_SESSION_ID', 'AGENTMUX_AGENT_CAPABILITY', 'AGENTMUX_RUN_ID',
    'AGENTMUX_WORKSPACE_ID', 'AGENTMUX_REGION_ID', 'AGENTMUX_TAB_ID', 'AGENTMUX_VIEW_ID']) delete env[name]
  for (const phase of diagnosticOnly ? ['seed'] : ['seed', 'restore', 'empty-restore']) {
    const phaseRoot = path.join(privateRoot, `phase-${phase}`)
    await fs.mkdir(phaseRoot)
    const stderr = []
    const exit = await runProbeProcess(electron, [path.join(privateRoot, 'main/main.mjs'), path.join(privateRoot, 'renderer/index.html'),
      privateRoot, phase, path.join(fixture, 'preload.cjs'), evidence, process.execPath, path.join(privateCore, 'bin/agentmux'),
      receipt.candidate.commit, receipt.candidate.tree, rendererId, JSON.stringify(receipt.updateIdentity), phaseRoot],
      { temporaryRoot: phaseRoot, cwd: root, env, timeoutMs: 160000,
        onLine: line => { stderr.push(line.slice(0, 2000)); process.stderr.write(`${phase}: ${line.slice(0, 400)}\n`) } })
    const entry = { phase, exit, stderr }; receipt.phases.push(entry)
    await fs.writeFile(path.join(evidence, `${phase}-stderr.log`), stderr.join('\n'))
    const native = await fs.readFile(path.join(evidence, `${phase}.json`), 'utf8').then(JSON.parse).catch(error => ({
      passed: false, failure: { name: error.name, message: `No native phase receipt; see preserved ${phase}-stderr.log: ${error.message}` } }))
    entry.native = native
    assert.equal(exit.timedOut, false, `${phase} watchdog fired`)
    assert.equal(exit.exitCode, 0, native.failure?.message)
    assert.equal(native.passed, true)
    privateEnvironment()
    client ??= await connectLocalAgentMux({ store: new AgentMuxFileAgentSessionStore(path.join(privateRoot, 'agent-sessions.json')) })
    receipt.runtimeIdentity = client.runtimeIdentity()
    const current = (await client.listRuns()).filter(one => one.state === 'running').map(one => ({ runId: one.runId, pid: one.pid,
      kind: one.kind, agentSessionId: one.agentSessionId, workspacePath: one.workspacePath }))
    assert.ok(current.length >= 4, 'All four private Agent Runs survive; optional warm owners are not excluded')
    if (phase === 'seed') {
      const setup = native.steps.find(one => one.name === 'authorized-initial-setup')?.facts
      assert.ok(setup, 'The initial public Agent setup receipt is present')
      const agents = ['source', 'target', 'mote', 'topic'].map(key => setup[key].agent)
      assert.equal(new Set(agents.map(one => one.agentSessionId)).size, 4, 'Four distinct Agent SIDs were actually created')
      for (const one of agents) {
        const running = current.find(run => run.runId === one.runId)
        assert.ok(running && Number.isSafeInteger(running.pid) && running.pid > 0, 'Each created Agent has a live observed Run PID')
        assert.equal(running.kind, 'agent'); assert.equal(running.agentSessionId, one.agentSessionId); assert.equal(running.workspacePath, one.cwd)
      }
      assert.deepEqual(native.persisted.map(one => ({ agentSessionId: one.agentSessionId, runId: one.run.runId,
        workspacePath: one.workspacePath, creation: one.creation })).sort((a, b) => a.agentSessionId.localeCompare(b.agentSessionId)),
        agents.map(one => ({ agentSessionId: one.agentSessionId, runId: one.runId, workspacePath: one.cwd,
          creation: { createOperationId: one.createOperationId, initialPrompt: one.initialPrompt } })).sort((a, b) => a.agentSessionId.localeCompare(b.agentSessionId)),
      'The nonempty durable Session store matches the four actual public setup receipts')
      for (const one of native.persisted) assert.ok(one.nativeHandle && Object.keys(one.nativeHandle).length > 0, 'Each original durable Session has its acquired native handle')
      receipt.originalRuns = current; receipt.originalSessions = native.persisted
    }
    else {
      assert.deepEqual(current, receipt.originalRuns, 'Ordinary restart neither replaces healthy Runs nor creates optional shells')
      assert.deepEqual(native.persisted, receipt.originalSessions, 'SID/native handle/creation/cwd survive independently')
      receipt.survivingRuns = current
    }
  }
  if (!diagnosticOnly) assert.equal(new Set(receipt.phases.map(one => one.native.pid)).size, 3, 'Independent ordinary App processes are observed')
  receipt.inputsAfter = await hashes()
  assert.deepEqual(receipt.inputsAfter, receipt.inputs, 'Source or compiled Core input changed during verification')
  receipt.updateIdentityAfter = await sourceUpdateIdentity(root)
  assert.deepEqual(receipt.updateIdentityAfter, receipt.updateIdentity, 'Loaded production shell/ctxmux identity changed during verification')
  if (diagnosticOnly) receipt.diagnosticPassed = true
  else receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  const errors = []
  try { receipt.inputsAfter ??= await hashes(); receipt.sourceUnchanged = JSON.stringify(receipt.inputsAfter) === JSON.stringify(receipt.inputs) }
  catch (error) { receipt.sourceObservationFailure = error.message }
  try {
    const existingPrivateRuntime = await fs.stat(path.join(privateRoot, 'runtime', 'ctxmux.sock')).then(one => one.isSocket()).catch(() => false)
    if (!client && existingPrivateRuntime) {
      privateEnvironment()
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
assert.equal(diagnosticOnly ? receipt.diagnosticPassed : receipt.passed, true, receipt.failure?.message)
console.log(JSON.stringify({ passed: receipt.passed, diagnosticPassed: receipt.diagnosticPassed, scope: receipt.scope,
  candidate: receipt.candidate, phases: receipt.phases.map(one => ({ phase: one.phase, pid: one.native.pid })), survivingRuns: receipt.survivingRuns, cleanup: receipt.cleanup }))
