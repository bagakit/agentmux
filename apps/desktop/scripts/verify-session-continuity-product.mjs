import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import * as core from '../../../packages/core/dist/index.js'
import { AgentMuxControlServer } from '../../../packages/core/dist/public-rpc-server.js'
import { runProbeProcess, listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'
const { AgentMuxFileAgentSessionStore, connectLocalAgentMux } = core
const capability = process.env.AGENTMUX_RECOVERY_CAPABILITY_PROOF === '1'
const desktop = path.resolve(import.meta.dirname, '..')
const root = path.resolve(desktop, '../..')
const fixture = path.join(desktop, 'scripts/fixtures/session-continuity')
const bootstrap = path.join(desktop, 'scripts/fixtures/native-proof-bootstrap.cjs')
const evidence = path.resolve(process.argv[2] ?? path.join(root, '.tmp/session-continuity/last'))
const require = createRequire(path.join(desktop, 'package.json'))
const { build } = await import(pathToFileURL(require.resolve('vite')).href)
const electron = process.env.AGENTMUX_PROOF_ELECTRON_PATH ?? require('electron')
const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmux-continuity-'))
const hash = value => createHash('sha256').update(value).digest('hex')
const receipt = { schema: capability ? 'agentmux.session-capability-recovery.v1' : 'agentmux.session-continuity.v1', passed: false, privateRoot, phases: [], inputs: null, inputsAfter: null, cleanup: null,
  limitations: ['Actual private Electron Main and Renderer restart exercise production App/Store and RuntimeController/Core, with a nonempty original spatial workface before hydration.',
    'The native CLI is a repository protocol fixture. It validates the exact resume identity against retained native session metadata and appends to the original conversation record; this is not upstream Provider certification.',
    'Only private Runs are deliberately ended between Electron generations; no user profile, user Agent or user configuration is accessed.',
    'Unknown observation, durable input lost-receipt, policy settings and mutation proofs have separate focused gates consumed by this joined Feature.'] }
const files = async directory => (await Promise.all((await fs.readdir(directory, { withFileTypes: true })).map(entry => entry.isDirectory()
  ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]))).flat()
const sourceFiles = [new URL(import.meta.url).pathname, bootstrap, path.join(desktop, 'scripts/probe-process.mjs'),
  ...(capability ? [path.join(desktop, 'scripts/verify-session-capability-recovery-product.mjs')] : []),
  path.join(desktop, 'test/helpers/local-runtime-connector.ts'), path.join(desktop, 'test/helpers/client-ui-render.tsx'),
  path.join(root, 'packages/client-ui/package.json'),
  path.join(desktop, 'scripts/fixtures/terminal-wheel/xterm-instrumented.ts'), ...await files(fixture),
  ...await files(path.join(desktop, 'src')), ...await files(path.join(root, 'packages/core/src')),
  ...await files(path.join(root, 'packages/core/dist')), ...await files(path.join(root, 'packages/core/bin')), ...await files(path.join(root, 'packages/core/vendor/ctxmux')),
  path.join(root, 'packages/core/package.json'), path.join(root, 'packages/core/scripts/build.mjs'),
  path.join(root, 'packages/core/test/fixtures/fake-codex-cli.mjs'), path.join(root, 'patches/@xterm__xterm@6.1.0-beta.303.patch'), path.join(root, 'pnpm-lock.yaml'), electron]
const hashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file => [path.relative(root, file), hash(await fs.readFile(file))])))
const clientUiRoot = path.join(root, 'packages/client-ui') + path.sep
const clientUiInputs = new Map()
async function recordClientUiInput(id) {
  if (id.startsWith('\0')) return
  const file = path.resolve(id.split('?')[0])
  if (!file.startsWith(clientUiRoot)) return
  const bytes = await fs.readFile(file), sha256 = hash(bytes)
  const previous = clientUiInputs.get(file)
  if (previous) assert.equal(sha256, previous, 'A loaded client-ui source changed during compilation: ' + file)
  else clientUiInputs.set(file, sha256)
}
const compiledManifest = async () => {
  const generated = (await Promise.all(['main', 'renderer', 'core/dist', 'core/bin'].map(directory => files(path.join(privateRoot, directory))))).flat()
  return Object.fromEntries(await Promise.all(generated.map(async file => {
    const bytes = await fs.readFile(file); assert.ok(bytes.length > 0)
    return [path.relative(privateRoot, file), { bytes: bytes.length, sha256: hash(bytes) }]
  })))
}
const previousEnvironment = new Map(['AGENTMUX_RUNTIME_DIRECTORY', 'AGENTMUX_STATE_DIRECTORY', 'AGENTMUX_MESSAGE_QUEUE_PATH', 'CODEX_HOME'].map(name => [name, process.env[name]]))
let client, processesLaunched = false
await fs.mkdir(evidence, { recursive: true })
try {
  process.env.CODEX_HOME = path.join(privateRoot, 'codex')
  receipt.inputs = await hashes()
  await fs.mkdir(path.join(privateRoot, 'workspace'), { recursive: true })
  await fs.mkdir(path.join(privateRoot, 'node_modules/@agentmux'), { recursive: true })
  // Freeze the exact built Core for all generations; another independent task
  // may rebuild its own dist while this longer process proof is running.
  const coreSnapshot = path.join(privateRoot, 'core')
  await fs.mkdir(coreSnapshot)
  for (const name of ['dist', 'bin']) await fs.cp(path.join(root, 'packages/core', name), path.join(coreSnapshot, name), { recursive: true, mode: fsConstants.COPYFILE_FICLONE })
  await fs.copyFile(path.join(root, 'packages/core/package.json'), path.join(coreSnapshot, 'package.json'))
  await fs.symlink(path.join(root, 'packages/core/node_modules'), path.join(coreSnapshot, 'node_modules'))
  await fs.symlink(path.join(root, 'packages/core/vendor'), path.join(coreSnapshot, 'vendor'))
  for (const name of ['dist', 'bin']) for (const file of await files(path.join(coreSnapshot, name))) {
    const key = 'packages/core/' + path.relative(coreSnapshot, file)
    assert.equal(hash(await fs.readFile(file)), receipt.inputs[key], 'Snapshot must contain the exact original compiled Core: ' + key)
  }
  await fs.symlink(coreSnapshot, path.join(privateRoot, 'node_modules/@agentmux/core'))
  const corePackage = JSON.parse(await fs.readFile(path.join(coreSnapshot, 'package.json'), 'utf8'))
  const coreAliases = Object.entries(corePackage.exports).flatMap(([key, value]) => {
    const target = typeof value === 'string' ? value : value.import
    return target ? [{ find: new RegExp('^' + ('@agentmux/core' + (key === '.' ? '' : key.slice(1))).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') + '$'), replacement: path.join(coreSnapshot, target) }] : []
  })
  await fs.copyFile(path.join(root, 'packages/core/test/fixtures/fake-codex-cli.mjs'), path.join(privateRoot, 'fake-codex-cli.mjs'))
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
  await fs.writeFile(path.join(privateRoot, 'fake-codex'), '#!/bin/sh\ncase "$1" in --version|-V) printf "codex-fixture 0.0.0\\n"; exit 0;; --help|-h) printf "Private Codex protocol fixture\\n"; exit 0;; esac\nexec ' + quote(process.execPath) + ' ' + quote(path.join(privateRoot, 'fake-codex-cli.mjs')) + ' "$@"\n', { mode: 0o700 })
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error',
    plugins: [{ name: 'typed-native-client-ui-inputs', enforce: 'pre',
      async load(id) { await recordClientUiInput(id) },
      async transform(_code, id) { await recordClientUiInput(id) } }],
    define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"', __TERMINAL_WHEEL_UMD_URL__: '"unused"' }, worker: { format: 'es' },
    resolve: { alias: [...coreAliases, { find: /^@xterm\/xterm$/, replacement: path.join(desktop, 'scripts/fixtures/terminal-wheel/xterm-instrumented.ts') }] },
    build: { target: 'esnext', outDir: path.join(privateRoot, 'renderer'), emptyOutDir: true } })
  await build({ configFile: false, root: fixture, logLevel: 'error', ssr: { noExternal: true },
    build: { ssr: path.join(fixture, 'main.ts'), target: 'node22', outDir: path.join(privateRoot, 'main'), emptyOutDir: true,
      rollupOptions: { external: ['electron', '@agentmux/core', /^@agentmux\/core\//], output: { format: 'es', entryFileNames: 'main.mjs' } } } })
  assert.ok(clientUiInputs.size > 0, 'The actual Renderer must consume nonempty production client-ui inputs.')
  receipt.clientUiInputs = Object.fromEntries([...clientUiInputs].map(([file, sha256]) => [path.relative(root, file), sha256]))
  // The pre-load and transform observations fence compilation; the same exact
  // loaded files then join the original before/after input identity checks.
  for (const [file, sha256] of clientUiInputs) {
    assert.equal(hash(await fs.readFile(file)), sha256, 'Loaded client-ui input changed after compilation: ' + file)
    const key = path.relative(root, file)
    if (Object.hasOwn(receipt.inputs, key)) assert.equal(receipt.inputs[key], sha256, 'An original input changed during compilation: ' + file)
    else receipt.inputs[key] = sha256
    if (!sourceFiles.includes(file)) sourceFiles.push(file)
  }
  receipt.compiled = await compiledManifest()
  assert.ok(Object.keys(receipt.compiled).length > 0)
  for (const directory of ['main', 'renderer']) await fs.cp(path.join(privateRoot, directory), path.join(evidence, 'compiled', directory), { recursive: true })
  await fs.writeFile(path.join(evidence, 'compiled.json'), JSON.stringify(receipt.compiled, null, 2))
  // The ordinary Core daemon is shared by the three private Electron generations. Each Electron
  // watchdog owns only its own process group and phase directory; parent cleanup owns all Runs.
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  for (const phase of ['seed', 'restore', 'reconnect']) {
    const phaseRoot = path.join(privateRoot, `phase-${phase}`)
    await fs.mkdir(phaseRoot)
    await fs.rm(path.join(evidence, `${phase}.json`), { force: true })
    const stderr = []
    processesLaunched = true
    const exit = await runProbeProcess(electron, [bootstrap, path.join(privateRoot, 'main/main.mjs'), privateRoot, path.join(privateRoot, 'renderer/index.html'),
      privateRoot, phase, path.join(fixture, 'preload.cjs'), evidence, process.execPath, phaseRoot],
      { temporaryRoot: phaseRoot, cwd: root, env, timeoutMs: 180000, onLine: line => {
        stderr.push(line.slice(0, 1800))
        if (line.startsWith('{"phase"')) process.stderr.write(line + '\n')
      } })
    const entry = { phase, exit, stderr }; receipt.phases.push(entry)
    await fs.writeFile(path.join(evidence, `${phase}-stderr.log`), stderr.join('\n'))
    const native = JSON.parse(await fs.readFile(path.join(evidence, `${phase}.json`), 'utf8')); entry.native = native
    assert.equal(exit.timedOut, false, `${phase} watchdog fired`)
    assert.equal(exit.exitCode, 0, native.failure?.message)
    assert.equal(native.passed, true)
    if (capability) {
      const image = path.join(evidence, phase + '-workface.png')
      entry.image = { path: image, sha256: hash(await fs.readFile(image)) }
    }
    process.env.AGENTMUX_RUNTIME_DIRECTORY = path.join(privateRoot, 'runtime')
    process.env.AGENTMUX_STATE_DIRECTORY = path.join(privateRoot, 'runtime', 'state')
    process.env.AGENTMUX_MESSAGE_QUEUE_PATH = path.join(privateRoot, 'messages.ndjson')
    client ??= await connectLocalAgentMux({ store: new AgentMuxFileAgentSessionStore(path.join(privateRoot, 'agent-sessions.json')) })
    receipt.runtimeIdentity = client.runtimeIdentity()
    const ids = JSON.parse(await fs.readFile(path.join(privateRoot, 'ids.json'), 'utf8'))
    const runs = await client.listRuns()
    const healthy = runs.find(run => run.runId === ids.healthy.run.runId)
    assert.equal(healthy?.state, 'running', 'The original healthy Run must survive every Electron generation')
    const identity = { runId: healthy.runId, pid: healthy.pid }
    if (capability) {
      if (phase === 'seed') receipt.originalHealthy = identity
      else assert.deepEqual(identity, receipt.originalHealthy, 'The healthy original Run and PID survive real Electron restart')
      assert.equal(native.capability.originalRecheck.zeroLifecycleOrInput, true)
      assert.equal(native.capability.originalOutput.zeroLifecycleInputOrResize, true)
      assert.equal(native.capability.originalOutput.runId, ids.working.run.runId)
      assert.equal(native.capability.observationFailure.healthyInputPreserved, true)
      assert.equal(native.capability.retirement.noResurrection, true)
      assert.equal(native.capability.rawInput.length, 2)
      assert.ok(native.capability.rawInput.every(one => one.runId === identity.runId && one.pid === identity.pid && one.consumedOnce))
      receipt.survivingHealthy = identity
      await client.dispose(); client = null
      continue
    }
    if (phase === 'seed') {
      receipt.originalHealthy = identity
      const store = new AgentMuxFileAgentSessionStore(path.join(privateRoot, 'agent-sessions.json'))
      const idle = (await store.load()).find(one => one.agentSessionId === ids.idle.sessionId)
      assert.ok(idle?.semanticStatus?.state === 'done')
      // This clock fixture represents a previously confirmed idle interval. It is
      // saved before the next process starts and never edits a native identity.
      await store.compareAndSwap(idle, { ...idle, semanticStatus: { ...idle.semanticStatus, stateEnteredAt: Date.now() - 25 * 3600000 } })
      receipt.originalNative = await fs.readFile(path.join(privateRoot, 'codex/sessions', `rollout-${ids.working.sessionId}.jsonl`), 'utf8')
      receipt.originalBodies = receipt.originalNative.split('\n').filter(Boolean).map(line => JSON.parse(line))
        .filter(one => one.type === 'response_item' && one.payload?.type === 'message')
        .map(one => ({ role: one.payload.role, text: one.payload.content.map(part => part.text ?? '').join('') }))
      assert.ok(receipt.originalBodies.some(one => one.role === 'user' && one.text))
      assert.ok(receipt.originalBodies.some(one => one.role === 'assistant' && one.text))
      // Public Native lifecycle operations end these PRIVATE Runs only. Their
      // semantic Sessions are not retired and their exact original records remain.
      for (const name of ['working', 'idle']) await client.stopTerminal({ runId: ids[name].run.runId })
      const ended = await client.listRuns()
      for (const name of ['working', 'idle']) assert.notEqual(ended.find(run => run.runId === ids[name].run.runId)?.state, 'running')
      receipt.endedPrivateRuns = ['working', 'idle'].map(name => ({ name, run: ids[name].run }))
      await client.dispose(); client = null
    } else {
      assert.deepEqual(identity, receipt.originalHealthy, 'Healthy Run and PID must be unchanged')
      receipt.survivingHealthy = identity
      const store = new AgentMuxFileAgentSessionStore(path.join(privateRoot, 'agent-sessions.json'))
      const working = (await store.load()).find(one => one.agentSessionId === ids.working.sessionId)
      assert.ok(working && working.run.runId !== ids.working.run.runId)
      assert.deepEqual(working.nativeHandle, ids.working.nativeHandle, 'Provider-native identity must remain exactly the original')
      const restored = receipt.phases.find(one => one.phase === 'restore').native
      assert.ok(restored.afterManualInput.sessions.find(one => one.id === ids.idle.sessionId).control.run.runId !== ids.idle.run.runId, 'Fresh explicit input resumes the exact retained idle conversation')
      const conversation = await fs.readFile(path.join(privateRoot, 'codex/sessions', `rollout-${ids.working.sessionId}.jsonl`), 'utf8')
      assert.ok(conversation.startsWith(receipt.originalNative), 'Original native context bytes must remain intact after resume')
      const records = conversation.split('\n').filter(Boolean).map(line => JSON.parse(line))
      const resumes = records.filter(one => one.type === 'fixture_resume')
      assert.equal(resumes.length, 1, 'Only one exact native resume is accepted')
      assert.equal(resumes[0].payload.id, ids.working.nativeHandle.sessionId)
      const replay = await client.readRunReplay(working.run, 0, 'raw')
      const output = Buffer.concat(replay.replay.map(chunk => Buffer.from(chunk.dataBytes))).toString('utf8')
      const readback = JSON.parse(output.match(/codex-restored-context:([^\r\n]+)/u)?.[1] ?? 'null')
      assert.ok(readback, 'The actual resumed native process must report reading its original conversation bodies')
      assert.equal(readback.nativeSessionId, ids.working.nativeHandle.sessionId)
      assert.deepEqual(readback.bodies, receipt.originalBodies)
      assert.equal(readback.bodySha256, hash(JSON.stringify(receipt.originalBodies)))
      const delivery = native.recoveryInput.recoveryDelivery
      assert.equal(output.split('codex-launch-input:').length - 1, 1, 'Only one new native launch input is consumed across reconnects')
      assert.equal(output.includes('codex-submit:'), false, 'The original launch input is never copied into PTY')
      assert.equal(output.includes('codex-dropped-pre-ready-payload'), false)
      const witness = JSON.parse(output.match(/codex-launch-input:([^\r\n]+)/u)?.[1] ?? 'null')
      assert.ok(witness, 'The actual native process must read its own first argv prompt')
      assert.equal(witness.prompt, native.recoveryInput.launchInput.prompt)
      assert.equal(witness.promptSha256, hash(witness.prompt))
      assert.equal(witness.nativeSessionId, ids.working.nativeHandle.sessionId)
      assert.ok(witness.prompt.includes(delivery.continuation.text), 'The actual native consumer receives the frozen continuation')
      assert.ok(witness.prompt.includes(delivery.reminder.text), 'The same actual native input carries the frozen recovery reminder')
      const carried = records.filter(one => one.type === 'fixture_launch_input')
      assert.equal(carried.length, 1, 'The original native conversation records one first input across both reconnects')
      assert.deepEqual(carried[0].payload, witness)
      assert.ok(records.some(one => one.type === 'response_item' && one.payload?.role === 'user' &&
        one.payload.content?.some(part => part.text === witness.prompt)), 'The native process appends the exact carried body to its original conversation')
      if (phase === 'restore') receipt.recoveryInput = delivery
      else assert.deepEqual(delivery, receipt.recoveryInput, 'The reconnect reads the original shared input receipt')
      receipt.nativeResume = { sessionId: working.agentSessionId, previousRun: ids.working.run, newRun: working.run,
        nativeHandle: working.nativeHandle, originalContextSha256: hash(receipt.originalNative), contextPreserved: true,
        originalBodySha256: readback.bodySha256, nativeContextReadback: true, resumeCount: resumes.length }
    }

  }
  assert.equal(new Set(receipt.phases.map(phase => phase.native.pid)).size, 3)
  if (capability) {
    const cliFixture = path.join(fixture, 'capability-public-cli.mjs')
    const cliSourceSha256 = hash(await fs.readFile(cliFixture))
    assert.equal(cliSourceSha256, receipt.inputs[path.relative(root, cliFixture)], 'Public CLI fixture changed before loading')
    const { verifyCapabilityPublicCli } = await import(pathToFileURL(cliFixture).href + '?source=' + cliSourceSha256)
    client ??= await connectLocalAgentMux({ store: new AgentMuxFileAgentSessionStore(path.join(privateRoot, 'agent-sessions.json')) })
    receipt.publicCli = await verifyCapabilityPublicCli({ client, core, ControlServer: AgentMuxControlServer,
      privateRoot, coreSnapshot, ids: JSON.parse(await fs.readFile(path.join(privateRoot, 'ids.json'), 'utf8')) })
    receipt.publicCli.sourceSha256 = cliSourceSha256
  }
  receipt.inputsAfter = await hashes()
  assert.deepEqual(await compiledManifest(), receipt.compiled, 'Actual compiled restart proof changed across generations')
  assert.deepEqual(receipt.inputsAfter, receipt.inputs, 'Source changed during native verification')
  delete receipt.originalNative
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  const errors = []
  try {
    if (!client) {
      process.env.AGENTMUX_RUNTIME_DIRECTORY = path.join(privateRoot, 'runtime')
      process.env.AGENTMUX_STATE_DIRECTORY = path.join(privateRoot, 'runtime', 'state')
      process.env.AGENTMUX_MESSAGE_QUEUE_PATH = path.join(privateRoot, 'messages.ndjson')
      // A failed build has no Runtime to stop and must not create one during cleanup.
      if (receipt.phases.length > 0) client = await connectLocalAgentMux({ store: new AgentMuxFileAgentSessionStore(path.join(privateRoot, 'agent-sessions.json')) })
    }
    if (client) { for (const run of await client.listRuns()) if (run.state === 'running') await client.stopTerminal({ runId: run.runId }); await client.dispose() }
  } catch (error) { errors.push(error.message) }
  if (processesLaunched) try { await stopProbeProcesses(process.pid + 1_000_000_000, privateRoot) } catch (error) { errors.push(error.message) }
  let remaining = processesLaunched ? null : []
  if (processesLaunched) try { remaining = await listProbeProcesses(-1, privateRoot) } catch (error) { errors.push(error.message) }
  receipt.cleanup = { errors, remaining, temporaryRootRemoved: false }
  if (receipt.cleanup.remaining?.length === 0) { await fs.rm(privateRoot, { recursive: true, force: true }); receipt.cleanup.temporaryRootRemoved = true }
  if (errors.length || remaining === null || remaining.length > 0) { receipt.passed = false; receipt.failure ??= { name: 'PrivateCleanupUnconfirmed', message: errors.join('; ') || 'Private process cleanup is unconfirmed; retain its namespace.' } }
  for (const [name, value] of previousEnvironment) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
  await fs.writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2))
}
assert.equal(receipt.passed, true, receipt.failure?.message + (receipt.cleanup.errors.length ? '; cleanup: ' + receipt.cleanup.errors.join('; ') : ''))
assert.deepEqual(receipt.cleanup.errors, [])
assert.deepEqual(receipt.cleanup.remaining, [])
assert.equal(receipt.cleanup.temporaryRootRemoved, true)
assert.equal(receipt.passed, true, receipt.failure?.message)
console.log(JSON.stringify({ passed: true, phases: receipt.phases.map(phase => ({ phase: phase.phase, pid: phase.native.pid })), healthy: receipt.survivingHealthy, nativeResume: receipt.nativeResume, cleanup: receipt.cleanup }))
