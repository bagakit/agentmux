import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { confirmUiTerminalRebindings } from '../../package-runtime-upgrade.mjs'
import { signalOwnedProbeProcess, stopProbeProcesses } from '../../probe-process.mjs'
const exec = promisify(execFile), repository = resolve(import.meta.dirname, '../../../../..')
const root = await mkdtemp(join(tmpdir(), 'amux-terminal-install-')), evidence = process.argv[2]
const vendor = join(repository, 'packages/core/vendor/ctxmux', process.platform + '-' + process.arch)
const socket = join(root, 'ctxmux.sock'), state = join(root, 'state'), sdkRoot = join(root, 'sdk'), cwd = join(root, 'workspace')
let daemon, oldDaemon, sdk, current
const runGroups = []
const receipt = { passed: false, userAppOrRunTouched: false, scope: 'Private packaged Native + actual installer helper; no GUI packaging/installation or Core recovery attribution', cleanup: {} }
try {
  await Promise.all([mkdir(sdkRoot), mkdir(cwd), mkdir(state, { mode: 0o700 })])
  await exec('/usr/bin/tar', ['-xzf', join(vendor, 'ctxmux-sdk-0.0.0.tgz'), '-C', sdkRoot])
  const sdkPath = join(sdkRoot, 'package/dist/index.js'), { CtxmuxClient, defineRun } = await import(pathToFileURL(sdkPath).href)
  const launch = async () => {
    const child = spawn(join(vendor, 'bin/ctxmuxd'), ['--socket', socket, '--state-dir', state, '--readiness-fd', '3'],
      { detached: true, stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
    let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes.toString() })
    let timer
    try { await Promise.race([once(child.stdio[3], 'data'), once(child, 'error').then(([error]) => { throw error }),
      once(child, 'exit').then(() => { throw Error('Private Native exited before readiness: ' + stderr) }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Private Native readiness unknown')), 5000) })]) }
    finally { clearTimeout(timer) }
    return child
  }
  daemon = await launch(); oldDaemon = daemon
  sdk = new CtxmuxClient({ socketPath: socket }); const originalRuntime = await sdk.runtimeInfo()
  const previous = await sdk.start(defineRun('/bin/cat', { cwd, env: {}, initialSize: { cols: 80, rows: 24 } })); runGroups.push(previous.pid)
  // Only this test-owned Native owner is interrupted, with its exact private path rechecked.
  const ended = once(daemon, 'exit')
  await signalOwnedProbeProcess(daemon.pid, root, 'SIGKILL', daemon.pid); await ended
  daemon = await launch(); sdk = new CtxmuxClient({ socketPath: socket })
  const runtime = await sdk.runtimeInfo(), oldRun = await sdk.status(previous.id)
  assert.equal(runtime.runtimeId, originalRuntime.runtimeId); assert.notEqual(runtime.daemonInstanceId, originalRuntime.daemonInstanceId)
  assert.deepEqual(oldRun.state, { type: 'interrupted', reason: 'daemon_restart' })
  current = await sdk.start(defineRun('/bin/cat', { cwd, env: {}, initialSize: { cols: 80, rows: 24 } })); runGroups.push(current.pid)
  const region = id => ({ kind: 'terminal', regionId: 'original-region', workspaceId: 'workspace', sessionId: id, phase: 'attached',
    processState: id === previous.id ? 'interrupted' : 'running', control: { kind: 'terminal', hostId: 'local', runId: id, run: { runId: id } } })
  const observation = id => ({ schema: 'agentmux.desktop-client-observation.v1', main: { pid: 1, package: null,
    renderer: { kind: 'bundled', id: 'a'.repeat(64), identity: { shell: 'private-shell', ctxmux: 'private-native' } },
    runtimes: [{ hostId: 'local', identity: { hostId: 'local', instanceId: runtime.daemonInstanceId, buildIdentity: runtime.buildId, protocolVersion: runtime.protocolGeneration, processId: null } }] },
    workbench: { loading: false, startupProgress: { step: 'layout' }, activeWorkspaceId: 'workspace', mainSurface: 'workbench',
      focus: { executionSessionId: null, pmoSessionId: null }, desktop: {}, layouts: {},
      tabs: [{ id: 'original-tab', workspaceId: 'workspace', titleRegionId: 'original-region', layout: { root: { type: 'leaf', regionId: 'original-region' }, activeRegionId: 'original-region' }, regions: [region(id)] }] } })
  const before = observation(previous.id), after = observation(current.id), plan = { newSdk: sdkPath, old: { socketPath: socket } }
  const confirmation = { runtime, originalRuns: [] }
  const proof = await confirmUiTerminalRebindings(plan, confirmation, before, after)
  assert.equal(proof.length, 1); assert.equal(proof[0].previous.id, previous.id); assert.equal(proof[0].current.id, current.id)
  assert.equal(proof[0].previous.workspacePath, cwd); assert.equal(proof[0].current.workspacePath, cwd)
  const wrong = { runtime: { ...runtime, daemonInstanceId: originalRuntime.daemonInstanceId }, originalRuns: [] }
  const wrongUi = structuredClone(after); wrongUi.main.runtimes[0].identity.instanceId = originalRuntime.daemonInstanceId
  await assert.rejects(confirmUiTerminalRebindings(plan, wrong, before, wrongUi), /instance|changed|mismatch/i)
  const unchanged = await sdk.status(current.id)
  assert.equal(unchanged.pid, current.pid); assert.equal(unchanged.state.type, 'running')
  receipt.native = { runtimeId: runtime.runtimeId, daemonInstanceId: runtime.daemonInstanceId,
    artifactSha256: createHash('sha256').update(await readFile(join(vendor, 'bin/ctxmuxd'))).digest('hex'), proof,
    rejectedForeignInstance: true, replacementPreserved: true }
  receipt.passed = true
} catch (error) { receipt.error = { message: error.message, stack: error.stack }; process.exitCode = 1 }
finally {
  const errors = []
  for (const child of [daemon, oldDaemon].filter(Boolean)) try { await stopProbeProcesses(child.pid, root) } catch (error) { errors.push(error.message) }
  for (const group of runGroups) try { await stopProbeProcesses(group, root) } catch (error) { errors.push(error.message) }
  try { await rm(root, { recursive: true, force: true }); receipt.cleanup.privateDirectoryRemoved = true } catch (error) { errors.push(error.message) }
  receipt.cleanup.errors = errors; if (errors.length) { receipt.passed = false; process.exitCode = 1 }
  await writeFile(evidence, JSON.stringify(receipt, null, 2) + '\n')
}
