import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { AgentMuxFileAgentSessionStore, connectLocalAgentMux } from '../../../packages/core/dist/index.js'
import { runProbeProcess, listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'

const root = path.resolve(import.meta.dirname, '../../..'), desktop = path.join(root, 'apps/desktop')
const evidence = path.resolve(process.argv[2] ?? path.join(root, '.tmp/goal-responsibility/t005/native'))
const require = createRequire(path.join(desktop, 'package.json'))
const { build } = await import(pathToFileURL(require.resolve('vite')).href)
const electron = process.env.AGENTMUX_PROOF_ELECTRON_PATH ?? require('electron')
const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'amux-goal-native-'))
const hash = value => createHash('sha256').update(value).digest('hex')
const files = async directory => (await Promise.all((await fs.readdir(directory, { withFileTypes: true })).map(entry => entry.isDirectory()
  ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]))).flat()
const fixture = path.join(desktop, 'scripts/fixtures/goal-responsibility-native/main.ts')
const bootstrap = path.join(desktop, 'scripts/fixtures/native-proof-bootstrap.cjs')
const sourceFiles = [new URL(import.meta.url).pathname, fixture, bootstrap, path.join(desktop, 'scripts/probe-process.mjs'),
  path.join(desktop, 'test/helpers/local-runtime-connector.ts'), path.join(root, 'pnpm-lock.yaml'),
  ...await files(path.join(desktop, 'src/shared')), ...await files(path.join(desktop, 'src/main')),
  ...await files(path.join(root, 'packages/core/src')), ...await files(path.join(root, 'packages/core/dist')),
  ...await files(path.join(root, 'packages/demand/src')), ...await files(path.join(root, 'packages/demand/dist')),
  path.join(root, 'packages/core/test/fixtures/fake-codex-cli.mjs'), electron]
const hashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file => [path.relative(root, file), hash(await fs.readFile(file))])))
const compiledManifest = async directory => {
  const manifest = Object.fromEntries(await Promise.all((await files(directory)).map(async file => {
    const bytes = await fs.readFile(file); assert.ok(bytes.length > 0)
    return [path.relative(directory, file), { bytes: bytes.length, sha256: hash(bytes) }]
  })))
  assert.ok(Object.keys(manifest).length > 0); return manifest
}
const receipt = { schema: 'agentmux.goal-responsibility-native.v1', passed: false, phases: [],
  proofBoundary: 'Real private Electron owner process restart, original Demand/Core FileStores, public authenticated compiled CLI and Unix RPC, production Main owners/RuntimeController and real ctxmux PTYs. The native Provider executable is the repository Codex protocol fixture. One actual ctxmux ACK is deliberately lost. No user profile, Session, Run, focus or provider configuration is accessed. Chromium visuals and original workface restart are qualified separately.' }
const previousEnvironment = new Map(['AGENTMUX_RUNTIME_DIRECTORY', 'AGENTMUX_STATE_DIRECTORY', 'AGENTMUX_MESSAGE_QUEUE_PATH'].map(key => [key, process.env[key]]))
let client
await fs.mkdir(evidence, { recursive: true })
try {
  receipt.inputs = await hashes()
  await fs.mkdir(path.join(privateRoot, 'workspace'), { recursive: true })
  await fs.mkdir(path.join(privateRoot, 'node_modules/@agentmux'), { recursive: true })
  for (const module of ['core', 'demand', 'identity']) await fs.symlink(path.join(root, 'packages', module), path.join(privateRoot, 'node_modules/@agentmux', module))
  await fs.copyFile(path.join(root, 'packages/core/test/fixtures/fake-codex-cli.mjs'), path.join(privateRoot, 'fake-codex-cli.mjs'))
  await build({ configFile: false, root: path.dirname(fixture), logLevel: 'error', ssr: { noExternal: true },
    build: { ssr: fixture, target: 'node22', outDir: path.join(privateRoot, 'main'), emptyOutDir: true,
      rollupOptions: { external: ['electron', /^@agentmux\/core(?:\/|$)/, /^@agentmux\/demand(?:\/|$)/], output: { format: 'es', entryFileNames: 'main.mjs' } } } })
  receipt.compiled = await compiledManifest(path.join(privateRoot, 'main'))
  await fs.cp(path.join(privateRoot, 'main'), path.join(evidence, 'compiled-main'), { recursive: true })
  assert.deepEqual(await compiledManifest(path.join(evidence, 'compiled-main')), receipt.compiled)
  await fs.writeFile(path.join(evidence, 'compiled.json'), JSON.stringify(receipt.compiled, null, 2))
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  for (const phase of ['seed', 'restore']) {
    const phaseRoot = path.join(privateRoot, 'phase-' + phase); await fs.mkdir(phaseRoot)
    const stderr = []
    const exit = await runProbeProcess(electron, [bootstrap, path.join(privateRoot, 'main/main.mjs'), privateRoot, privateRoot, phase, evidence, process.execPath, path.join(root, 'packages/core/dist/agentmux.js')],
      { temporaryRoot: phaseRoot, cwd: root, env, timeoutMs: 180000, onLine: line => stderr.push(line.slice(0, 2000)) })
    await fs.writeFile(path.join(evidence, `${phase}-stderr.log`), stderr.join('\n'))
    const entry = { phase, exit }; receipt.phases.push(entry)
    const bytes = await fs.readFile(path.join(evidence, `${phase}.json`)), native = JSON.parse(bytes)
    Object.assign(entry, { receipt: `${phase}.json`, receiptSha256: hash(bytes), native })
    assert.equal(exit.timedOut, false, phase + ': private watchdog fired')
    assert.equal(exit.exitCode, 0, native.failure?.message)
    assert.equal(native.passed, true, native.failure?.message)
  }
  assert.equal(new Set(receipt.phases.map(phase => phase.native.pid)).size, 2, 'Two distinct actual owner processes are required')
  assert.deepEqual(receipt.phases[0].native.ids, receipt.phases[1].native.ids, 'Original execution identities survive owner restart')
  assert.equal(receipt.phases[0].native.after.patrols[0].operationId, receipt.phases[1].native.after.patrols[0].operationId)
  assert.ok(receipt.phases[0].native.lostReceipt?.ack, 'Lost receipt must follow actual Native acceptance')
  assert.deepEqual(await compiledManifest(path.join(privateRoot, 'main')), receipt.compiled, 'Actual native proof executable changed during restart')
  receipt.inputsAfter = await hashes(); assert.deepEqual(receipt.inputsAfter, receipt.inputs, 'Native proof source or build changed during the two generations')
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  const errors = []
  try {
    if (receipt.phases.length) {
      process.env.AGENTMUX_RUNTIME_DIRECTORY = path.join(privateRoot, 'runtime')
      process.env.AGENTMUX_STATE_DIRECTORY = path.join(privateRoot, 'runtime', 'state')
      process.env.AGENTMUX_MESSAGE_QUEUE_PATH = path.join(privateRoot, 'messages.ndjson')
      client = await connectLocalAgentMux({ store: new AgentMuxFileAgentSessionStore(path.join(privateRoot, 'sessions.json')) })
      for (const run of await client.listRuns()) if (run.state === 'running') await client.stopTerminal({ runId: run.runId })
      await client.dispose()
    }
  } catch (error) { errors.push(error.message) }
  try { await stopProbeProcesses(process.pid + 1_000_000_000, privateRoot) } catch (error) { errors.push(error.message) }
  receipt.cleanup = { errors, remaining: await listProbeProcesses(-1, privateRoot), temporaryRootRemoved: false }
  if (!receipt.cleanup.remaining.length) { await fs.rm(privateRoot, { recursive: true, force: true }); receipt.cleanup.temporaryRootRemoved = true }
  for (const [key, value] of previousEnvironment) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  await fs.writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2))
}
assert.equal(receipt.passed, true, receipt.failure?.message)
assert.deepEqual(receipt.cleanup.errors, []); assert.deepEqual(receipt.cleanup.remaining, []); assert.equal(receipt.cleanup.temporaryRootRemoved, true)
console.log(JSON.stringify({ passed: true, phases: receipt.phases.map(phase => ({ phase: phase.phase, pid: phase.native.pid })), cleanup: receipt.cleanup }))
