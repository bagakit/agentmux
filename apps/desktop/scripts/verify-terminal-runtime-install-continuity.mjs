import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { canonicalInstallPath } from './package-identity.mjs'
import { pathToFileURL } from 'node:url'
import { prepareRuntimeUpgrade, finishRuntimeUpgrade, closeRuntimeUpgrade } from './package-runtime-upgrade.mjs'
import { listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'

const exec = promisify(execFile), base = resolve('.'), out = join(base, '.tmp/runtime-install-proof')
const oldArtifacts = process.argv.find((entry) => entry.startsWith('--previous-artifacts='))?.slice('--previous-artifacts='.length) ?? join(canonicalInstallPath(homedir()), 'Contents/Resources/app/node_modules/@agentmux/core/vendor/ctxmux', `${process.platform}-${process.arch}`)
const supplied = process.argv.find((entry) => entry.startsWith('--candidate-artifacts='))?.slice('--candidate-artifacts='.length) ?? join(base, 'packages/core/vendor/ctxmux', `${process.platform}-${process.arch}`)
const daemon18 = join(supplied, 'bin/ctxmuxd')
const sdk18 = join(supplied, 'ctxmux-sdk-0.0.0.tgz')
const oldManifest = JSON.parse(await readFile(join(oldArtifacts, 'manifest.json')))
const candidateManifest = JSON.parse(await readFile(join(supplied, 'manifest.json')))
assert.ok([17, 18].includes(oldManifest.product.protocol)); assert.equal(candidateManifest.product.protocol, 18)
await mkdir(out, { recursive: true })
const sha = async (p) => createHash('sha256').update(await readFile(p)).digest('hex')
const critical = [join(oldArtifacts, 'manifest.json'), join(oldArtifacts, 'bin/ctxmuxd'), join(oldArtifacts, 'ctxmux-sdk-0.0.0.tgz'),
  daemon18, sdk18, new URL(import.meta.url).pathname, new URL('./package-runtime-upgrade.mjs', import.meta.url).pathname,
  new URL('./probe-process.mjs', import.meta.url).pathname,
  join(base, 'apps/desktop/scripts/package-macos.mjs'), join(base, 'packages/core/src/runtime-paths.ts'),
  join(base, 'packages/core/dist/runtime-paths.js')]
const inputsBefore = Object.fromEntries(await Promise.all(critical.map(async (p) => [p, await sha(p)])))
const root = await mkdtemp('/tmp/amx-install-proof-')
const previousEnv = process.env.AGENTMUX_RUNTIME_DIRECTORY
const previousState = process.env.AGENTMUX_STATE_DIRECTORY
const records = [], cleanupErrors = []
let failure
const relative = 'Contents/Resources/app/node_modules/@agentmux/core'
const wait = async (read, accept, label) => {
  const deadline = Date.now() + 7_000
  do { const value = await read(); if (accept(value)) return value; await new Promise((r) => setTimeout(r, 20)) } while (Date.now() < deadline)
  throw new Error(`Private fixture deadline: ${label}`)
}
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { if (e.code === 'ESRCH') return false; throw e } }

async function app(appPath, candidate) {
  const core = join(appPath, relative), vendor = join(core, 'vendor/ctxmux/darwin-arm64')
  await mkdir(join(vendor, 'bin'), { recursive: true })
  await mkdir(join(core, 'dist'))
  await writeFile(join(core, 'package.json'), '{"type":"module"}\n')
  await copyFile(join(base, 'packages/core/dist/runtime-paths.js'), join(core, 'dist/runtime-paths.js'))
  await copyFile(candidate ? daemon18 : join(oldArtifacts, 'bin/ctxmuxd'), join(vendor, 'bin/ctxmuxd'))
  await chmod(join(vendor, 'bin/ctxmuxd'), 0o755)
  await copyFile(candidate ? sdk18 : join(oldArtifacts, 'ctxmux-sdk-0.0.0.tgz'), join(vendor, 'ctxmux-sdk-0.0.0.tgz'))
  const manifest = candidate ? structuredClone(candidateManifest) : structuredClone(oldManifest)
  await writeFile(join(vendor, 'manifest.json'), JSON.stringify(manifest))
  return { core, vendor, manifest }
}

async function scenario(name) {
  const directory = join(root, name), current = join(directory, 'Applications/PrivateAgentMux.app'), next = join(directory, 'Applications/.PrivateAgentMux.next.app')
  const backup = join(directory, 'Trash/PrivateAgentMux.previous.app')
  const runtimeDir = join(directory, 'runtime'), socket = join(runtimeDir, 'ctxmux.sock'), state = join(runtimeDir, 'state', 'ctxmux')
  process.env.AGENTMUX_RUNTIME_DIRECTORY = runtimeDir
  process.env.AGENTMUX_STATE_DIRECTORY = join(runtimeDir, 'state')
  const old = await app(current, false); await app(next, true)
  await mkdir(runtimeDir); await mkdir(dirname(backup), { recursive: true })
  if (name === 'no-listener') {
    const originalKill = process.kill
    let signals = 0
    process.kill = (...args) => { signals++; return originalKill(...args) }
    try { assert.equal(await prepareRuntimeUpgrade(current, next), null); assert.equal(signals, 0) }
    finally { process.kill = originalKill }
    records.push({ name, passed: true, signals: 0 }); return
  }
  const sdkDir = join(directory, 'fixture-sdk'); await mkdir(sdkDir)
  await exec('/usr/bin/tar', ['-xzf', join(old.vendor, 'ctxmux-sdk-0.0.0.tgz'), '-C', sdkDir])
  const oldSdk = await import(pathToFileURL(join(sdkDir, 'package/dist/index.js')).href)
  const client17 = new oldSdk.CtxmuxClient({ socketPath: socket })
  let launchPath = join(old.vendor, 'bin/ctxmuxd')
  if (name === 'deleted-image') {
    launchPath = join(directory, 'Trash/RemovedPrevious.app', relative, 'vendor/ctxmux/darwin-arm64/bin/ctxmuxd')
    await mkdir(dirname(launchPath), { recursive: true }); await copyFile(join(old.vendor, 'bin/ctxmuxd'), launchPath)
  }
  const daemon = spawn(launchPath, ['--socket', socket, '--state-dir', state, '--readiness-fd', '3'],
    { detached: true, stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
  let stderr = '', childPid, runId, plan, outcome, activeClient = client17, rejection
  daemon.on('error', (error) => { stderr += `Spawn failed: ${error.message}` })
  daemon.stderr.on('data', (data) => { if (stderr.length < 16384) stderr += data.toString().slice(0, 16384 - stderr.length) })
  try {
    await Promise.race([new Promise((done, reject) => {
      daemon.stdio[3].once('data', done); daemon.once('error', reject); daemon.once('exit', () => reject(new Error(stderr)))
    }), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('private readiness timeout')), 5_000); timer.unref() })])
    const identity = await client17.runtimeInfo()
    const source = "import os,termios\na=termios.tcgetattr(0);a[3]&=~(termios.ICANON|termios.ECHO);a[1]&=~termios.OPOST;termios.tcsetattr(0,termios.TCSANOW,a)\nos.write(1,b'\\x1b[?1049h\\x1b[?1003h\\x1b[?1006hREADY')\nwhile True:\n b=os.read(0,1)\n if b==b'q':break\n os.write(1,b'PRIVATE-PTY-ACK\\n')"
    const worker = join(directory, 'worker.py'); await writeFile(worker, source)
    const run = await client17.start(oldSdk.defineRun('/usr/bin/python3', { args: ['-u', worker], cwd: directory, env: {}, initialSize: { rows: 4, cols: 12 } }))
    runId = run.id; childPid = run.pid
    const before = await wait(() => client17.status(run.id), (value) => value.latest_output_bytes >= 29, 'PTY initialization')
    const receiptPath = join(runtimeDir, 'owner.json')
    await writeFile(receiptPath, JSON.stringify({ schema: 'agentmux.ctxmux-owner.v1', sourceCommit: old.manifest.source.commit,
      sourceTree: old.manifest.source.tree, manifestSha256: await sha(join(old.vendor, 'manifest.json')),
      daemonSha256: old.manifest.binaries.find((entry) => entry.name === 'ctxmuxd').sha256,
      daemonPath: join(old.vendor, 'bin/ctxmuxd'), socketPath: socket, stateDirectory: state,
      daemonInstanceId: identity.daemonInstanceId, runtimeId: identity.runtimeId, runtimeBuildId: identity.buildId }), { mode: 0o600 })
    if (name === 'deleted-image') {
      // Prove the same private SDK/owner preflight works before removing its mapped image.
      plan = await prepareRuntimeUpgrade(current, next)
      assert.equal(plan.owner.pid, daemon.pid); assert.equal(plan.owner.executable, launchPath)
      await closeRuntimeUpgrade(plan); plan = undefined
      await rm(launchPath)
      const originalKill = process.kill
      let signals = 0
      process.kill = (...args) => { if (args[0] === daemon.pid && args[1] !== 0) signals++; return originalKill(...args) }
      try {
        await assert.rejects(prepareRuntimeUpgrade(current, next).then((value) => { plan = value; return value }), (error) => {
          rejection = { name: error.name, message: error.message, code: error.code, path: error.path,
            signal: error.signal, killed: error.killed, stderr: error.stderr }
          // An SDK/tar failure is a setup failure, not proof that the deleted image was rejected.
          assert.ok((error.code === 'ENOENT' && error.path === launchPath) ||
            error.message === 'The Runtime process has no unique ctxmuxd executable mapping.',
          `Deleted-image preflight stopped before its owner check: ${JSON.stringify(rejection)}`)
          return true
        })
      } finally { process.kill = originalKill }
      assert.equal(plan, undefined); assert.equal(signals, 0)
      assert.equal(await sha(join(old.vendor, 'bin/ctxmuxd')), old.manifest.binaries.find((entry) => entry.name === 'ctxmuxd').sha256)
      assert.equal(await sha(join(next, relative, 'vendor/ctxmux/darwin-arm64/bin/ctxmuxd')), await sha(daemon18))
      const afterIdentity = await client17.runtimeInfo()
      assert.equal(afterIdentity.runtimeId, identity.runtimeId); assert.equal(afterIdentity.daemonInstanceId, identity.daemonInstanceId)
      const kept = await client17.status(run.id)
      assert.equal(kept.pid, childPid); assert.equal(kept.state.type, 'running')
      assert.deepEqual(kept.current_size, before.current_size); assert.equal(kept.applied_input_bytes, 0)
      await client17.input(run.id, 'x')
      const input = await wait(() => client17.status(run.id), (value) => value.applied_input_bytes === 1 && value.latest_output_bytes > kept.latest_output_bytes, 'deleted-image healthy input')
      records.push({ name, passed: true, daemonPid: daemon.pid, childPid, runId, unchangedRun: true,
        noCutover: true, signals, sameRuntimeAndIncarnation: true, unverifiableImageRejected: true,
        rejection, originalInputBytes: input.applied_input_bytes })
      await client17.input(run.id, 'q'); await wait(() => client17.status(run.id), (value) => value.state.type === 'exited', 'deleted-image exit')
      return
    }
    if (name === 'unproven-owner') {
      const receipt = JSON.parse(await readFile(receiptPath)); receipt.daemonInstanceId = 'another-daemon'
      await writeFile(receiptPath, JSON.stringify(receipt))
      await assert.rejects(prepareRuntimeUpgrade(current, next).then((value) => { plan = value; return value }), /matching AgentMux owner receipt/)
      const after = await client17.status(run.id)
      assert.equal(after.pid, childPid); assert.equal(after.applied_input_bytes, 0)
      records.push({ name, passed: true, daemonPid: daemon.pid, childPid, unchangedRun: true, noCutover: true })
      await client17.input(run.id, 'q'); await wait(() => client17.status(run.id), (value) => value.state.type === 'exited', 'owner fixture exit')
      return
    }
    plan = await prepareRuntimeUpgrade(current, next)
    assert.equal(plan.owner.pid, daemon.pid); assert.equal(plan.before.running.length, 1)
    const oldKernelPath = plan.owner.executable
    // Match the product lifetime: the parent diagnostic receiver closes after readiness.
    if (name === 'closed-diagnostics-success') daemon.stderr.destroy()
    await rename(current, backup); await rename(next, current)
    if (name === 'before-extract-refusal') await chmod(state, 0o500)
    outcome = await finishRuntimeUpgrade(plan, current)
    await chmod(state, 0o700)
    if (name === 'before-extract-refusal') {
      assert.equal(outcome.status, 'old-confirmed')
      assert.equal(outcome.signalSent, true)
      assert.ok(stderr.includes('aborted before extract, continuing to serve'))
      // This is the installer's exact positive-old branch; no old client is
      // restored on an unknown outcome or after candidate protocol confirmation.
      await rename(current, next); await rename(backup, current)
      activeClient = client17
    } else {
      assert.equal(outcome.status, 'upgraded')
      assert.equal(outcome.protocol, 18); assert.equal(outcome.daemonPid, daemon.pid)
      assert.equal(outcome.runtimeId, identity.runtimeId); assert.equal(outcome.daemonInstanceId, identity.daemonInstanceId)
      const { CtxmuxClient } = await import(pathToFileURL(plan.newSdk).href)
      activeClient = new CtxmuxClient({ socketPath: socket })
      const attachment = await activeClient.attachTerminal(run.id, before.latest_output_bytes)
      assert.equal(attachment.snapshot.terminal.type, oldManifest.product.protocol === 17 ? 'unknown' : 'basic_vt'); attachment.close()
      const saved = JSON.parse(await readFile(receiptPath))
      assert.equal(saved.daemonSha256, await sha(daemon18)); assert.equal(saved.daemonInstanceId, identity.daemonInstanceId)
    }
    const kept = await activeClient.status(run.id)
    assert.equal(kept.pid, childPid); assert.equal(kept.state.type, 'running')
    assert.deepEqual(kept.current_size, before.current_size); assert.equal(kept.applied_input_bytes, 0)
    await activeClient.input(run.id, 'x')
    const input = await wait(() => activeClient.status(run.id), (value) => value.applied_input_bytes === 1 && value.latest_output_bytes > kept.latest_output_bytes, 'original PTY input')
    records.push({ name, passed: true, outcome, daemonPid: daemon.pid, childPid, runId,
      sameRuntimeAndIncarnation: true, sameDaemonAndChild: true, sameGrid: true, originalInputBytes: input.applied_input_bytes,
      oldKernelPath, actualAppDirectoryRename: true, closedDiagnosticReceiver: name === 'closed-diagnostics-success',
      previousProtocol: oldManifest.product.protocol, candidateProtocol: candidateManifest.product.protocol,
      beforeExtractObservedInPrivateStderr: name === 'before-extract-refusal' })
    await activeClient.input(run.id, 'q')
    await wait(() => activeClient.status(run.id), (value) => value.state.type === 'exited', 'private child exit')
  } catch (error) {
    if (rejection) error.preflightRejection = rejection
    error.message += `; private case=${name}, stderr=${stderr.slice(0, 2000)}`
    throw error
  } finally {
    await chmod(state, 0o700).catch((e) => cleanupErrors.push(e.message))
    await closeRuntimeUpgrade(plan).catch((e) => cleanupErrors.push(e.message))
    // On an assertion failure the private Run may still be alive. Ask that exact
    // Run to exit while its SDK is available, before shutting down its daemon.
    if (runId && childPid && alive(childPid)) {
      try {
        const currentRun = await activeClient.status(runId)
        assert.equal(currentRun.pid, childPid)
        if (currentRun.state.type === 'running') await activeClient.input(runId, 'q')
        await wait(() => alive(childPid), (value) => !value, 'private child cleanup')
      } catch (error) { cleanupErrors.push(`Private Run cleanup: ${error.message}`) }
    }
    if (daemon.exitCode === null && daemon.signalCode === null) {
      daemon.kill('SIGINT')
      await wait(() => daemon.exitCode !== null || daemon.signalCode !== null, Boolean, 'private daemon exit')
        .catch((error) => cleanupErrors.push(error.message))
    }
    // Reap all descendants identified by this invocation's group/path even when
    // an earlier cleanup operation failed. Such failures still make the gate red.
    const group = daemon.pid ?? process.pid + 1_000_000_000
    const remaining = await listProbeProcesses(group, directory).catch((error) => { cleanupErrors.push(error.message); return null })
    if (remaining?.length) {
      cleanupErrors.push(`Private processes did not exit gracefully: ${remaining.join(', ')}`)
      await stopProbeProcesses(group, directory).catch((error) => cleanupErrors.push(error.message))
    }
    if (childPid) await wait(() => alive(childPid), (value) => !value, 'private child reaped')
      .catch(() => cleanupErrors.push(`Private child remains: ${childPid}, Run ${runId}`))
    if (daemon.exitCode !== 0) cleanupErrors.push(`Private daemon exit: ${daemon.exitCode}, signal=${daemon.signalCode}`)
  }
}
const selectedCase = process.argv.find((entry) => entry.startsWith('--case='))?.slice('--case='.length)
const cases = selectedCase ? [selectedCase] : ['no-listener', 'unproven-owner', 'deleted-image', 'success', 'closed-diagnostics-success', 'before-extract-refusal']
assert.ok(cases.length > 0 && cases.every((name) => ['no-listener', 'unproven-owner', 'deleted-image', 'success', 'closed-diagnostics-success', 'before-extract-refusal'].includes(name)))
try {
  for (const name of cases) await scenario(name)
} catch (error) { failure = { name: error.name, message: error.message, stack: error.stack,
  code: error.code, signal: error.signal, killed: error.killed, stderr: error.stderr, preflightRejection: error.preflightRejection } }
finally {
  if (previousEnv === undefined) delete process.env.AGENTMUX_RUNTIME_DIRECTORY
  else process.env.AGENTMUX_RUNTIME_DIRECTORY = previousEnv
  if (previousState === undefined) delete process.env.AGENTMUX_STATE_DIRECTORY
  else process.env.AGENTMUX_STATE_DIRECTORY = previousState
  let rootRemoved = false
  if (cleanupErrors.length === 0) { await rm(root, { recursive: true, force: true }); rootRemoved = true }
  const inputsAfter = Object.fromEntries(await Promise.all(critical.map(async (p) => [p, await sha(p)])))
  const receipt = { schema: 'agentmux.runtime-install-private-proof.v1', passed: !failure && cleanupErrors.length === 0 && records.length === cases.length && rootRemoved,
    records, failure, inputsBefore, inputsAfter, inputsUnchanged: JSON.stringify(inputsBefore) === JSON.stringify(inputsAfter),
    cleanup: { errors: cleanupErrors, rootRemoved }, userRuntimeTouched: false,
    candidateProfile: candidateManifest.build.profile,
    scriptSHA: await sha(new URL(import.meta.url)), boundary: 'Actual product handoff helper, exact native binaries, actual SDK archives and App directory rename. No Electron/codesign/GUI launch or release-performance claim.' }
  await writeFile(join(out, 'private-upgrade-last.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify(receipt, null, 2))
  if (!receipt.passed || !receipt.inputsUnchanged) process.exitCode = 1
}
