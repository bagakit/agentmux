import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { canonicalInstallPath } from './package-identity.mjs'
import { prepareRuntimeUpgrade, finishRuntimeUpgrade, closeRuntimeUpgrade } from './package-runtime-upgrade.mjs'
import { listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'

const exec = promisify(execFile), base = resolve('.')
const out = join(base, '.tmp/runtime-upgrade-live-owner-proof-20261003')
const oldRoot = process.argv.find(value => value.startsWith('--previous-artifacts='))?.slice('--previous-artifacts='.length) ??
  join(canonicalInstallPath(homedir()), 'Contents/Resources/app/node_modules/@agentmux/core/vendor/ctxmux', `${process.platform}-${process.arch}`)
const candidateRoot = join(base, 'packages/core/vendor/ctxmux', `${process.platform}-${process.arch}`)
const relative = 'Contents/Resources/app/node_modules/@agentmux/core', sha = bytes => createHash('sha256').update(bytes).digest('hex')
const digest = async path => sha(await readFile(path))
const oldManifest = JSON.parse(await readFile(join(oldRoot, 'manifest.json')))
const candidateManifest = JSON.parse(await readFile(join(candidateRoot, 'manifest.json')))
assert.equal(process.platform, 'darwin'); assert.equal(oldManifest.product.protocol, 18); assert.equal(candidateManifest.product.protocol, 18)
const inputs = [...new Set([new URL(import.meta.url).pathname, new URL('./package-runtime-upgrade.mjs', import.meta.url).pathname,
  new URL('./probe-process.mjs', import.meta.url).pathname, join(base, 'apps/desktop/scripts/package-macos.mjs'),
  new URL('./package-identity.mjs', import.meta.url).pathname, join(base, 'apps/desktop/src/shared/client-observation.ts'),
  join(base, 'apps/desktop/test/package-runtime-upgrade-owner.test.ts'), join(base, 'apps/desktop/test/package-runtime-upgrade.test.ts'),
  join(base, 'apps/desktop/test/package-runtime-cold-authority.test.ts'), join(base, 'apps/desktop/test/desktop-client-observation.test.ts'), join(base, 'packages/core/src/socket-liveness.ts'),
  join(base, 'packages/core/src/runtime-paths.ts'), join(base, 'packages/core/dist/runtime-paths.js'),
  ...[oldRoot, candidateRoot].flatMap(root => [join(root, 'manifest.json'), join(root, 'bin/ctxmuxd'), join(root, 'ctxmux-sdk-0.0.0.tgz')])])]
assert.ok(inputs.length >= 10)
const inputsBefore = Object.fromEntries(await Promise.all(inputs.map(async path => [path, await digest(path)])))
await mkdir(out, { recursive: true })
const root = await mkdtemp('/tmp/amx-live-own-'), current = join(root, 'Applications/Private.app')
const uiNext = join(root, 'Applications/.ui-next.app'), fullNext = join(root, 'Applications/.full-next.app')
const uiBackup = join(root, 'Trash/BeforeUi.app'), fullBackup = join(root, 'Trash/BeforeFull.app')
const runtimeDir = join(root, 'runtime'), socket = join(runtimeDir, 'ctxmux.sock'), state = join(root, 'original-state')
const configuredBase = join(root, 'configured-durable'), receiptPath = join(runtimeDir, 'owner.json')
const previousEnv = { runtime: process.env.AGENTMUX_RUNTIME_DIRECTORY, state: process.env.AGENTMUX_STATE_DIRECTORY }
process.env.AGENTMUX_RUNTIME_DIRECTORY = runtimeDir; process.env.AGENTMUX_STATE_DIRECTORY = configuredBase
const daemons = [], cleanupErrors = [], records = []
let plan, client, failure
const originalRuns = []
const wait = async (read, accept, label) => {
  const deadline = Date.now() + 7_000
  do { const value = await read(); if (accept(value)) return value; await new Promise(done => setTimeout(done, 20)) } while (Date.now() < deadline)
  throw new Error(`Private deadline: ${label}`)
}
const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }
async function app(path, artifacts) {
  const core = join(path, relative), vendor = join(core, 'vendor/ctxmux', `${process.platform}-${process.arch}`)
  await mkdir(join(vendor, 'bin'), { recursive: true }); await mkdir(join(core, 'dist'))
  await writeFile(join(core, 'package.json'), '{"type":"module"}\n')
  await copyFile(join(base, 'packages/core/dist/runtime-paths.js'), join(core, 'dist/runtime-paths.js'))
  for (const file of ['bin/ctxmuxd', 'ctxmux-sdk-0.0.0.tgz', 'manifest.json']) await copyFile(join(artifacts, file), join(vendor, file))
  await chmod(join(vendor, 'bin/ctxmuxd'), 0o755)
  return { vendor, executable: join(vendor, 'bin/ctxmuxd') }
}
async function daemon(executable) {
  const child = spawn(executable, ['--socket', socket, '--state-dir', state, '--readiness-fd', '3'],
    { detached: true, stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
  daemons.push(child)
  let stderr = ''; child.stderr.on('data', bytes => { if (stderr.length < 8192) stderr += bytes.toString().slice(0, 8192 - stderr.length) })
  await Promise.race([new Promise((done, reject) => {
    child.stdio[3].once('data', done); child.once('error', reject); child.once('exit', () => reject(new Error(`Private readiness exit: ${stderr}`)))
  }), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Private readiness timeout')), 5_000); timer.unref() })])
  return child
}
try {
  await mkdir(runtimeDir); await mkdir(dirname(uiBackup), { recursive: true })
  const old = await app(current, oldRoot); await app(uiNext, oldRoot); await app(fullNext, candidateRoot)
  const sdkDir = join(root, 'sdk'); await mkdir(sdkDir)
  await exec('/usr/bin/tar', ['-xzf', join(oldRoot, 'ctxmux-sdk-0.0.0.tgz'), '-C', sdkDir])
  const sdk = await import(pathToFileURL(join(sdkDir, 'package/dist/index.js')).href)
  client = new sdk.CtxmuxClient({ socketPath: socket })
  // Create a truthful receipt from a previous private incarnation, then allow
  // it to become stale through an ordinary daemon exit. No production ledger.
  const initial = await daemon(old.executable), initialIdentity = await client.runtimeInfo()
  await writeFile(receiptPath, JSON.stringify({ schema: 'agentmux.ctxmux-owner.v1', sourceCommit: oldManifest.source.commit,
    sourceTree: oldManifest.source.tree, manifestSha256: await digest(join(old.vendor, 'manifest.json')),
    daemonSha256: await digest(old.executable), daemonPath: old.executable, socketPath: socket, stateDirectory: state,
    daemonInstanceId: initialIdentity.daemonInstanceId, runtimeId: initialIdentity.runtimeId, runtimeBuildId: initialIdentity.buildId }), { mode: 0o600 })
  initial.kill('SIGINT'); await wait(() => initial.exitCode, value => value !== null, 'initial ordinary daemon exit'); assert.equal(initial.exitCode, 0)
  const serving = await daemon(old.executable), identity = await client.runtimeInfo()
  assert.equal(identity.runtimeId, initialIdentity.runtimeId); assert.notEqual(identity.daemonInstanceId, initialIdentity.daemonInstanceId)
  const worker = join(root, 'worker.py')
  await writeFile(worker, "import os,termios\na=termios.tcgetattr(0);a[3]&=~(termios.ICANON|termios.ECHO);a[1]&=~termios.OPOST;termios.tcsetattr(0,termios.TCSANOW,a)\nos.write(1,b'\\x1b[38;5;208mPRIVATE-READY\\x1b[0m\\n')\nwhile True:\n b=os.read(0,1)\n if b==b'q':break\n os.write(1,b'PRIVATE-ACK-'+b+b'\\n')\n")
  const expectedInitial = Buffer.from('\x1b[38;5;208mPRIVATE-READY\x1b[0m\n')
  for (const key of ['A', 'B']) {
    const run = await client.start(sdk.defineRun('/usr/bin/python3', { args: ['-u', worker], cwd: root, env: {}, initialSize: { rows: 8, cols: 40 } }))
    const pinned = { key, runId: run.id, childPid: run.pid }; originalRuns.push(pinned)
    const before = await wait(() => client.status(run.id), value => value.latest_output_bytes >= expectedInitial.length, `original ${key} initial nonempty output`)
    const first = await client.attach(run.id, 0)
    const raw = first.snapshot.replay.chunks.map(chunk => Buffer.from(chunk.data)); first.close()
    assert.ok(raw.length > 0); assert.deepEqual(Buffer.concat(raw), expectedInitial)
    Object.assign(pinned, { before, rawReplay: { bytes: Buffer.concat(raw).length, sha256: sha(Buffer.concat(raw)) } })
  }
  assert.equal(originalRuns.length, 2); assert.notEqual(originalRuns[0].runId, originalRuns[1].runId)
  assert.notEqual(originalRuns[0].childPid, originalRuns[1].childPid)
  // A prior UI-only cutover leaves the live image mapped under Trash while its
  // actual startup path remains canonical. This is the production trigger.
  await rename(current, uiBackup); await rename(uiNext, current)
  plan = await prepareRuntimeUpgrade(current, fullNext)
  assert.equal(plan.owner.pid, serving.pid); assert.equal(plan.owner.executable, join(uiBackup, relative, 'vendor/ctxmux', `${process.platform}-${process.arch}`, 'bin/ctxmuxd'))
  assert.equal(plan.owner.state.directory, state); assert.notEqual(plan.old.stateDirectory, state)
  assert.equal(plan.old.stateDirectory, plan.candidate.stateDirectory); assert.equal(plan.ownerReceipt.status, 'mismatch')
  assert.equal(plan.before.running.length, 2)
  assert.deepEqual(plan.before.running.map(run => run.id).sort(), originalRuns.map(run => run.runId).sort())
  const lockBefore = { device: plan.owner.state.device, inode: plan.owner.state.inode }
  serving.stderr.destroy()
  await rename(current, fullBackup); await rename(fullNext, current)
  const outcome = await finishRuntimeUpgrade(plan, current)
  assert.equal(outcome.status, 'upgraded'); assert.equal(outcome.daemonPid, serving.pid)
  assert.equal(outcome.runtimeId, identity.runtimeId); assert.equal(outcome.daemonInstanceId, identity.daemonInstanceId)
  assert.equal(outcome.stateDirectory, state); assert.equal(outcome.daemonPath, join(current, relative, 'vendor/ctxmux', `${process.platform}-${process.arch}`, 'bin/ctxmuxd'))
  const saved = JSON.parse(await readFile(receiptPath, 'utf8'))
  assert.equal(saved.daemonPath, outcome.daemonPath); assert.equal(saved.stateDirectory, state)
  assert.equal(saved.daemonSha256, await digest(join(candidateRoot, 'bin/ctxmuxd')))
  const newSdk = await import(pathToFileURL(plan.newSdk).href); client = new newSdk.CtxmuxClient({ socketPath: socket })
  for (const [index, pinned] of originalRuns.entries()) {
    const terminal = await client.attachTerminal(pinned.runId, pinned.before.latest_output_bytes)
    assert.equal(terminal.snapshot.terminal.type, 'basic_vt'); terminal.close()
    const after = await client.status(pinned.runId)
    assert.equal(after.state.type, 'running'); assert.equal(after.pid, pinned.childPid); assert.deepEqual(after.current_size, pinned.before.current_size)
    assert.equal(after.applied_input_bytes, pinned.before.applied_input_bytes); assert.ok(after.latest_output_bytes >= pinned.before.latest_output_bytes)
    const payload = index === 0 ? 'x' : 'y'
    await client.input(pinned.runId, payload)
    const input = await wait(() => client.status(pinned.runId), value => value.applied_input_bytes === pinned.before.applied_input_bytes + 1 && value.latest_output_bytes > after.latest_output_bytes, `original ${pinned.key} child input/output`)
    const ordered = await client.attach(pinned.runId, 0)
    const orderedRaw = ordered.snapshot.replay.chunks.map(chunk => Buffer.from(chunk.data)); ordered.close()
    assert.ok(orderedRaw.length > 0); assert.deepEqual(Buffer.concat(orderedRaw), Buffer.concat([expectedInitial, Buffer.from(`PRIVATE-ACK-${payload}\n`)]))
    Object.assign(pinned, { orderedReplay: { bytes: Buffer.concat(orderedRaw).length, sha256: sha(Buffer.concat(orderedRaw)) },
      after: { input: input.applied_input_bytes, output: input.latest_output_bytes } })
  }
  const reopened = await prepareRuntimeUpgrade(current, current)
  try {
    assert.equal(reopened.owner.state.directory, state); assert.deepEqual({ device: reopened.owner.state.device, inode: reopened.owner.state.inode }, lockBefore)
    assert.equal(reopened.ownerReceipt.status, 'matching'); assert.equal(reopened.owner.pid, serving.pid)
  } finally { await closeRuntimeUpgrade(reopened) }
  assert.equal(outcome.originalRuns, 2)
  assert.equal(outcome.candidateVersion.version, candidateManifest.binaries.find(entry => entry.name === 'ctxmuxd').version)
  assert.equal(outcome.candidateVersion.protocol, candidateManifest.product.protocol)
  assert.ok(typeof outcome.candidateVersion.handoff === 'string' && outcome.candidateVersion.handoff.length > 0)
  records.push({ passed: true, daemonPid: serving.pid, originalRuns: originalRuns.map(pinned => ({ key: pinned.key, runId: pinned.runId,
    childPid: pinned.childPid, rawReplay: pinned.rawReplay, orderedReplay: pinned.orderedReplay,
    before: { input: pinned.before.applied_input_bytes, output: pinned.before.latest_output_bytes }, after: pinned.after })), originalIdentity: identity,
    previousIncarnation: initialIdentity.daemonInstanceId, actualUiOnlyRename: true, actualFullRename: true,
    outcome, lockBefore, configuredState: plan.old.stateDirectory, actualState: state, newReceipt: saved })
  for (const pinned of originalRuns) {
    await client.input(pinned.runId, 'q'); await wait(() => client.status(pinned.runId), value => value.state.type === 'exited', `original ${pinned.key} child natural exit`)
  }
} catch (error) { failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  for (const pinned of originalRuns) if (alive(pinned.childPid)) try {
    const run = await client.status(pinned.runId); assert.equal(run.pid, pinned.childPid)
    if (run.state.type === 'running') await client.input(pinned.runId, 'q')
    await wait(() => alive(pinned.childPid), value => !value, `private ${pinned.key} child cleanup`)
  } catch (error) { cleanupErrors.push(error.message) }
  await closeRuntimeUpgrade(plan).catch(error => cleanupErrors.push(error.message))
  for (const child of daemons) {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGINT'); await wait(() => child.exitCode !== null || child.signalCode !== null, Boolean, 'private daemon cleanup').catch(error => cleanupErrors.push(error.message)) }
    if (child.exitCode !== 0) cleanupErrors.push(`Private daemon exit ${child.exitCode}/${child.signalCode}`)
  }
  for (const child of daemons) {
    const remaining = await listProbeProcesses(child.pid, root).catch(error => { cleanupErrors.push(error.message); return null })
    if (remaining?.length) { cleanupErrors.push(`Private processes required cleanup: ${remaining.join(',')}`); await stopProbeProcesses(child.pid, root).catch(error => cleanupErrors.push(error.message)) }
  }
  const remaining = await listProbeProcesses(process.pid + 1_000_000_000, root).catch(error => { cleanupErrors.push(error.message); return null })
  if (remaining?.length) cleanupErrors.push(`Private root still owns processes: ${remaining.join(',')}`)
  for (const pinned of originalRuns) if (alive(pinned.childPid)) cleanupErrors.push(`Original private child remains: ${pinned.childPid}`)
  for (const [key, name] of [['runtime', 'AGENTMUX_RUNTIME_DIRECTORY'], ['state', 'AGENTMUX_STATE_DIRECTORY']]) {
    if (previousEnv[key] === undefined) delete process.env[name]; else process.env[name] = previousEnv[key]
  }
  const inputsAfter = Object.fromEntries(await Promise.all(inputs.map(async path => [path, await digest(path)])))
  let rootRemoved = false
  if (!cleanupErrors.length) { await rm(root, { recursive: true, force: true }); rootRemoved = true }
  const receipt = { schema: 'agentmux.runtime-live-owner-private-proof.v1', passed: !failure && records.length === 1 && cleanupErrors.length === 0 && rootRemoved,
    records, failure, inputsBefore, inputsAfter, inputsUnchanged: JSON.stringify(inputsBefore) === JSON.stringify(inputsAfter),
    cleanup: { errors: cleanupErrors, remaining, rootRemoved }, userRuntimeTouched: false,
    boundary: 'Actual OS owner, exact two artifacts and public SDK, two original PTY Runs, canonical/UI-only/full App rename plus actual version response and planned exec. No production signal, Electron launch, installation or global P0 claim.' }
  await writeFile(join(out, 'private-receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: receipt.passed, records: records.length, failure, cleanup: receipt.cleanup, inputsUnchanged: receipt.inputsUnchanged }))
  if (!receipt.passed || !receipt.inputsUnchanged) process.exitCode = 1
}
