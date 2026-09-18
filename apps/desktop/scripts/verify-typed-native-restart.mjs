import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { AgentMuxFileAgentSessionStore, connectLocalAgentMux } from '../../../packages/core/dist/index.js'
import { runProbeProcess, listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'
const desktop = path.resolve(import.meta.dirname, '..')
const root = path.resolve(desktop, '../..')
const fixture = path.join(desktop, 'scripts/fixtures/typed-native-restart')
const evidence = path.join(root, '.tmp/typed-native-restart/last')
const require = createRequire(path.join(desktop, 'package.json'))
const { build } = await import(pathToFileURL(require.resolve('vite')).href)
const electron = process.env.AGENTMUX_PROOF_ELECTRON_PATH ?? require('electron')
const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmux-typed-native-'))
const hash = value => createHash('sha256').update(value).digest('hex')
const receipt = { schema: 'agentmux.typed-native-restart.v1', passed: false, phases: [], inputs: null, inputsAfter: null, cleanup: null,
  limitations: ['Real private Electron process restart and production App/Store/SessionPane/TerminalView are exercised.',
    'All private Agent Runs, attachment, replay, resize, input and stop use the existing RuntimeController and Core public APIs.',
    'One private workface is seeded. Chromium sends real keyboard events through production TerminalView and public Core; no physical keyboard is claimed.', 'The real ctxmux ACK is deliberately lost at the private Core adapter boundary once. This is fault injection, not an observed network outage.', 'The native CLI is the repository fixture, not an upstream Provider version; permission has no invocation identity, so completion remains unconfirmed.',
    'No user App, user profile, user Session, user Run or user provider configuration is accessed.'] }
const files = async directory => (await Promise.all((await fs.readdir(directory, { withFileTypes: true })).map(entry => entry.isDirectory()
  ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]))).flat()
const sourceFiles = [new URL(import.meta.url).pathname, path.join(desktop, 'scripts/probe-process.mjs'),
  path.join(desktop, 'scripts/fixtures/terminal-wheel/xterm-instrumented.ts'), ...await files(fixture),
  ...await files(path.join(desktop, 'src')), ...await files(path.join(root, 'packages/core/src')),
  ...await files(path.join(root, 'packages/core/dist')), ...await files(path.join(root, 'packages/core/vendor/ctxmux')),
  path.join(root, 'packages/core/package.json'), path.join(root, 'packages/core/scripts/build.mjs'),
  path.join(root, 'packages/core/test/fixtures/fake-codex-cli.mjs'), path.join(root, 'patches/@xterm__xterm@6.1.0-beta.303.patch'), path.join(root, 'pnpm-lock.yaml'), electron]
const hashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file => [path.relative(root, file), hash(await fs.readFile(file))])))
const previousEnvironment = new Map(['AGENTMUX_RUNTIME_DIRECTORY', 'AGENTMUX_MESSAGE_QUEUE_PATH'].map(name => [name, process.env[name]]))
let client
await fs.mkdir(evidence, { recursive: true })
try {
  receipt.inputs = await hashes()
  await fs.mkdir(path.join(privateRoot, 'workspace'), { recursive: true })
  await fs.mkdir(path.join(privateRoot, 'node_modules/@agentmux'), { recursive: true })
  await fs.symlink(path.join(root, 'packages/core'), path.join(privateRoot, 'node_modules/@agentmux/core'))
  await fs.copyFile(path.join(root, 'packages/core/test/fixtures/fake-codex-cli.mjs'), path.join(privateRoot, 'fake-codex-cli.mjs'))
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error',
    define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"', __TERMINAL_WHEEL_UMD_URL__: '"unused"' },
    resolve: { alias: [{ find: /^@xterm\/xterm$/, replacement: path.join(desktop, 'scripts/fixtures/terminal-wheel/xterm-instrumented.ts') }] },
    build: { target: 'esnext', outDir: path.join(privateRoot, 'renderer'), emptyOutDir: true } })
  await build({ configFile: false, root: fixture, logLevel: 'error',
    build: { ssr: path.join(fixture, 'main.ts'), target: 'node22', outDir: path.join(privateRoot, 'main'), emptyOutDir: true,
      rollupOptions: { external: ['electron', '@agentmux/core', /^@agentmux\/core\//], output: { format: 'es', entryFileNames: 'main.mjs' } } } })
  // The ordinary Core daemon is shared by the two private Electron generations. Each Electron
  // watchdog owns only its own process group and phase directory; parent cleanup owns all Runs.
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  for (const phase of ['seed', 'restore']) {
    const phaseRoot = path.join(privateRoot, `phase-${phase}`)
    await fs.mkdir(phaseRoot)
    await fs.rm(path.join(evidence, `${phase}.json`), { force: true })
    const stderr = []
    const exit = await runProbeProcess(electron, [path.join(privateRoot, 'main/main.mjs'), path.join(privateRoot, 'renderer/index.html'),
      privateRoot, phase, path.join(fixture, 'preload.cjs'), evidence, process.execPath, phaseRoot],
      { temporaryRoot: phaseRoot, cwd: root, env, timeoutMs: 75000, onLine: line => stderr.push(line.slice(0, 1800)) })
    const entry = { phase, exit, stderr }; receipt.phases.push(entry)
    await fs.writeFile(path.join(evidence, `${phase}-stderr.log`), stderr.join('\n'))
    const native = JSON.parse(await fs.readFile(path.join(evidence, `${phase}.json`), 'utf8')); entry.native = native
    assert.equal(exit.timedOut, false, `${phase} watchdog fired`)
    assert.equal(exit.exitCode, 0, native.failure?.message)
    assert.equal(native.passed, true)
    process.env.AGENTMUX_RUNTIME_DIRECTORY = path.join(privateRoot, 'runtime')
    process.env.AGENTMUX_MESSAGE_QUEUE_PATH = path.join(privateRoot, 'messages.ndjson')
    client ??= await connectLocalAgentMux({ store: new AgentMuxFileAgentSessionStore(path.join(privateRoot, 'agent-sessions.json')) })
    receipt.runtimeIdentity = client.runtimeIdentity()
    const runs = (await client.listRuns()).filter(run => run.state === 'running')
    assert.equal(runs.length, 1, 'Exactly one private Agent Run remains healthy')
    const current = runs.map(run => ({ runId: run.runId, pid: run.pid }))
    if (phase === 'seed') receipt.originalRuns = current
    else { assert.deepEqual(current, receipt.originalRuns, 'Restart retains the exact original Run and PID'); receipt.survivingRuns = current }

  }
  assert.equal(new Set(receipt.phases.map(phase => phase.native.pid)).size, 2)
  assert.deepEqual(receipt.phases[0].native.persisted.pendingInteraction, receipt.phases[1].native.persisted.pendingInteraction, 'Exact request and unknown input survive restart unchanged')
  receipt.inputsAfter = await hashes()
  assert.deepEqual(receipt.inputsAfter, receipt.inputs, 'Source changed during native verification')
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  const errors = []
  try {
    if (!client) {
      process.env.AGENTMUX_RUNTIME_DIRECTORY = path.join(privateRoot, 'runtime')
      process.env.AGENTMUX_MESSAGE_QUEUE_PATH = path.join(privateRoot, 'messages.ndjson')
      // A failed build has no Runtime to stop and must not create one during cleanup.
      if (receipt.phases.length > 0) client = await connectLocalAgentMux({ store: new AgentMuxFileAgentSessionStore(path.join(privateRoot, 'agent-sessions.json')) })
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
