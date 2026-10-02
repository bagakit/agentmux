import { fixturePath as _hygiene_fixturePath } from "./lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { runProbeProcess } from './probe-process.mjs'
import { prepareRemoteProofCandidate } from './remote-runtime-proof-candidate.mjs'
import { clonePath, farmTarget, farmRuntimeId, originalSessionId, prepareFarmWorkspace,
  inspectFarmOs, observeProtected, removeFarmWorkspace } from './fixtures/host-ui-execution/farm-proof.mjs'

const desktop = path.resolve(import.meta.dirname, '..'), root = path.resolve(desktop, '../..')
const fixture = path.join(desktop, 'scripts/fixtures/host-ui-execution')
const require = createRequire(path.join(desktop, 'package.json'))
const exec = promisify(execFile), digest = bytes => createHash('sha256').update(bytes).digest('hex')
const json = file => fs.readFile(file, 'utf8').then(JSON.parse)
const write = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const files = async directory => (await Promise.all((await fs.readdir(directory, { withFileTypes: true }))
  .map(one => one.isDirectory() ? files(path.join(directory, one.name)) : [path.join(directory, one.name)]))).flat()
const sourceIdentity = async () => {
  const git = async args => (await exec('git', args, { cwd: root })).stdout.trim()
  return { head: await git(['rev-parse', 'HEAD']), tree: await git(['rev-parse', 'HEAD^{tree}']),
    trackedStatus: await git(['status', '--porcelain=v1', '--untracked-files=no']) }
}

// This is a private ordinary-Electron caller, not the user's installed application. It consumes
// current product modules and the same public SSH factory as production; remote authority stays
// in the existing sole Host. Only actual new Session IDs in this unique Task cwd may be mutated.
export async function captureHostUiExecution() {
  const runId = `host-ui-${Date.now()}-${randomUUID().slice(0, 6)}`
  const evidence = path.join(root, '.tmp/host-ui-execution', runId)
  await fs.mkdir(evidence, { recursive: true, mode: 0o700 })
  const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'amx-host-ui-'))
  await fs.chmod(privateRoot, 0o700)
  const remoteWorkspace = `${clonePath}/.agentmux-host-ui-qa/${runId}`
  const localWorkspace = path.join(privateRoot, 'local-workspace')
  await fs.mkdir(localWorkspace, { mode: 0o700 })
  const token = `HOST_UI_TASK_${randomUUID()}`
  const input = { remoteHostId: farmTarget.hostId, token,
    prompt: 'Read only host-ui-task.txt in the current working directory using the Read tool. Do not run commands, access the network, or edit any file. Reply with HOST_UI_GEMINICC_READY, the token read from that file, and your current working directory.',
    secondDraft: 'Unsent second Region draft: keep this text while selecting another machine.',
    config: { version: 9, hosts: [
      { id: 'local', kind: 'local', label: 'This Mac' },
      { id: farmTarget.hostId, kind: 'ssh', label: 'Farm FlowLens GeminiCC development machine · cn4 remote execution', hostname: farmTarget.hostname,
        remoteCommand: farmTarget.remoteCommand, remoteSocketPath: farmTarget.remoteSocketPath, runtimeId: farmRuntimeId },
      { id: 'host-ui-empty', kind: 'ssh', label: 'QA machine with no registered projects', hostname: 'unconfigured.invalid' }
    ], executors: { 'host-ui-geminicc': { label: 'GeminiCC QA', providerId: 'claude',
      command: _hygiene_fixturePath("tmp/amx-flowlens-261006-6dad/bin/claude"), args: ['--permission-mode', 'plan'], injectAgentMuxGuide: true } },
    workspaces: [
      { id: 'host-ui-local', hostId: 'local', name: 'Local QA workbench', path: localWorkspace, kind: 'folder' },
      { id: 'host-ui-remote', hostId: farmTarget.hostId, name: 'FlowLens · task-owned remote project', path: remoteWorkspace, kind: 'folder' }
    ], appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true,
      devTools: true, viewport: true, saveBookmark: true, more: true } } } }
  const proof = { schema: 'agentmux.host-ui-execution.proof.v1', passed: false, runId, evidence,
    privateRoot, phases: [], aestheticReview: 'not-performed', userAppTouched: false,
    originalBusinessSessionMutation: false, remoteOwnerLifecycleAction: false,
    boundary: { actual: ['NewTabSurface and WorkspaceWorkbench', 'Store and RuntimeController',
      'production desktop-host connector', 'public SSH Hosted SDK', 'native GeminiCC and PTYs',
      'real WorkspaceFiles', 'real durable CoreSpatial read/commit/onChange'],
      controlled: ['private configuration with registered QA projects', 'initial local display graph',
        'optional Git/browser/topic metadata and file observation', 'DOM input simulation',
        'final Focus presentation selection'], emptyHost: 'Menu-only candidate; never connects or owns a Session' } }
  let candidate, remote, local, farmWorkspace
  const cleanupErrors = [], stopped = []
  try {
    proof.sourceBefore = await sourceIdentity()
    candidate = await prepareRemoteProofCandidate({ root, privateRoot, proof })
    await fs.mkdir(path.join(privateRoot, 'node_modules/@agentmux'), { recursive: true })
    await fs.symlink(candidate.core, path.join(privateRoot, 'node_modules/@agentmux/core'))
    const core = await import(pathToFileURL(path.join(candidate.core, 'dist/index.js')).href)
    remote = await core.connectSshAgentMux({ target: farmTarget, expectedRuntimeId: farmRuntimeId })
    proof.protectedBefore = await observeProtected(remote)
    proof.remoteRunIdsBefore = (await remote.listRuns()).map(one => one.runId)
    proof.remoteOsBefore = await inspectFarmOs()
    farmWorkspace = await prepareFarmWorkspace(remoteWorkspace, token)
    proof.remoteWorkspace = farmWorkspace
    const inputPath = path.join(privateRoot, 'input.json'), preload = path.join(privateRoot, 'preload.cjs')
    await write(inputPath, input); await fs.copyFile(path.join(fixture, 'preload.cjs'), preload)
    const { build } = await import(pathToFileURL(require.resolve('vite')).href)
    await build({ configFile: false, root: fixture, base: './', logLevel: 'error', esbuild: { jsx: 'automatic' },
      plugins: [candidate.capture], define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"',
        __TERMINAL_WHEEL_UMD_URL__: '"unused"' },
      resolve: { alias: [{ find: /^@xterm\/xterm$/, replacement: path.join(desktop, 'scripts/fixtures/terminal-wheel/xterm-instrumented.ts') }] },
      build: { target: 'esnext', outDir: path.join(privateRoot, 'renderer'), emptyOutDir: true } })
    await build({ configFile: false, root: fixture, logLevel: 'error', plugins: [candidate.capture],
      build: { ssr: path.join(fixture, 'main.ts'), target: 'node22', outDir: path.join(privateRoot, 'main'), emptyOutDir: true,
        rollupOptions: { external: id => id === 'electron' || id === '@agentmux/core' || id.startsWith('@agentmux/core/'),
          output: { format: 'es', entryFileNames: 'main.mjs' } } } })
    await candidate.buildHost(build); await candidate.seal()
    const immutable = async () => ({ ...await candidate.identity(), ...Object.fromEntries(await Promise.all([
      ...await files(path.join(privateRoot, 'renderer')), ...await files(path.join(privateRoot, 'main')), preload, inputPath
    ].map(async file => [path.relative(privateRoot, file), digest(await fs.readFile(file))]))) })
    proof.compiledBefore = await immutable()
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    for (const name of Object.keys(env)) if (/^AGENTMUX_/.test(name)) delete env[name]
    for (const phase of ['seed', 'restore']) {
      process.stdout.write(`host-ui ${phase} ordinary Electron: ${evidence}\n`)
      // The phase path identifies only this Electron group. The independent local Host argv
      // contains privateRoot, not phaseRoot, and must survive the first ordinary client exit.
      const phaseRoot = path.join(privateRoot, `phase-${phase}`); await fs.mkdir(phaseRoot)
      const lines = []
      const exit = await runProbeProcess(process.env.AGENTMUX_PROOF_ELECTRON_PATH ?? require('electron'),
        [path.join(privateRoot, 'main/main.mjs'), path.join(privateRoot, 'renderer/index.html'),
          privateRoot, phase, preload, evidence, inputPath, phaseRoot],
        { temporaryRoot: phaseRoot, cwd: root, env, timeoutMs: phase === 'restore' ? 240_000 : 90_000,
          onLine: line => { lines.push(line); if (line.startsWith('host-ui:')) process.stdout.write(line + '\n') } })
      await fs.writeFile(path.join(evidence, `${phase}-stderr.log`), lines.join('\n'), { mode: 0o600 })
      const recorded = { phase, exit }; proof.phases.push(recorded)
      try { recorded.native = await json(path.join(evidence, `${phase}.json`)) } catch (error) { recorded.receiptError = error.message }
      assert.equal(exit.timedOut, false, 'The ordinary Electron exceeded its private watchdog')
      assert.equal(exit.exitCode, 0, recorded.native?.failure?.message)
      assert.equal(recorded.native?.passed, true, recorded.native?.failure?.message)
      local ??= await candidate.connectLocalHost()
      const originalLocal = recorded.native.originalLocal
      const localRun = (await local.listRuns()).find(one => one.runId === originalLocal.control.run.runId)
      assert.ok(localRun && localRun.state === 'running', 'The original healthy local Run survives ordinary Electron exit')
      recorded.localHostOwner = local.runtimeOwnerIdentity()
      recorded.originalLocalRun = { runId: localRun.runId, pid: localRun.pid, state: localRun.state }
    }
    assert.equal(new Set(proof.phases.map(one => one.native.electronPid)).size, 2)
    assert.deepEqual(proof.phases[0].originalLocalRun, proof.phases[1].originalLocalRun)
    assert.deepEqual(proof.phases[0].localHostOwner, proof.phases[1].localHostOwner,
      'The same independent semantic local Host survives both ordinary clients')
    const restored = proof.phases[1].native
    assert.notEqual(restored.agentLaunch.created.agentSessionId, originalSessionId)
    assert.equal(restored.nativeAgent.proof.history.matchedUserTurns, 1)
    assert.ok(restored.nativeAgent.proof.history.matchedAssistantReplies > 0)
    assert.ok(restored.calls.some(one => one.operation === 'launch-agent') && restored.calls.some(one => one.operation === 'launch-terminal'))
    assert.ok(proof.phases[0].native.calls.some(one => one.operation === 'file-readDirectory' && one.args[0] === 'host-ui-remote'),
      'The actual remote file picker consumes the selected Workspace file owner')
    proof.compiledAfter = await immutable()
    assert.deepEqual(proof.compiledAfter, proof.compiledBefore)
    await candidate.seal(); proof.sourceAfter = await sourceIdentity()
    assert.deepEqual(proof.sourceAfter, proof.sourceBefore, 'The closed Source candidate stayed unchanged during both processes')
    proof.passed = true
  } catch (error) { proof.failure = { name: error.name, message: error.message, stack: error.stack } }
  finally {
    let owned = []
    try { owned = await json(path.join(privateRoot, 'owned-sessions.json')) } catch (error) { if (error.code !== 'ENOENT') cleanupErrors.push(error.message) }
    // Reconcile a crash immediately after Core creation using exact fresh Task cwd and the
    // preexisting Run set. No original or other user's Session can satisfy this ownership basis.
    try {
      if (remote && farmWorkspace) {
        for (const session of await remote.readAgentSessions()) if (session.workspacePath === remoteWorkspace &&
          session.agentSessionId !== originalSessionId && !proof.remoteRunIdsBefore.includes(session.run.runId) &&
          !owned.some(one => one.sessionId === session.agentSessionId)) owned.push({ sessionId: session.agentSessionId,
            kind: 'agent', hostId: farmTarget.hostId, runId: session.run.runId, workspacePath: remoteWorkspace, purpose: 'exact-owned-cwd-crash-reconciliation' })
        for (const run of await remote.listRuns()) if (run.workspacePath === remoteWorkspace &&
          !proof.remoteRunIdsBefore.includes(run.runId) && !owned.some(one => one.runId === run.runId)) owned.push({
            sessionId: run.runId, kind: 'terminal', hostId: farmTarget.hostId, runId: run.runId,
            workspacePath: remoteWorkspace, purpose: 'exact-owned-cwd-crash-reconciliation' })
      }
      if (candidate && proof.phases.length) local ??= await candidate.connectLocalHost()
      for (const session of owned) {
        assert.notEqual(session.sessionId, originalSessionId)
        const client = session.hostId === farmTarget.hostId ? remote : local
        assert.ok(client)
        if (session.hostId === farmTarget.hostId) assert.equal(session.workspacePath, remoteWorkspace)
        else assert.equal(session.workspacePath, localWorkspace)
        const observed = (await client.listRuns()).find(one => one.runId === session.runId)
        if (observed?.state === 'running') {
          if (session.kind === 'agent') await client.stopAgent(session.sessionId, { runId: session.runId })
          else await client.stopTerminal({ runId: session.runId })
        }
        stopped.push({ ...session, beforeState: observed?.state ?? 'absent',
          action: observed?.state === 'running' ? 'public-stop' : 'already-ended' })
      }
      for (const client of [remote, local].filter(Boolean)) {
        const deadline = Date.now() + 5_000
        let remaining
        do { remaining = (await client.listRuns()).filter(run => owned.some(one => one.runId === run.runId) && run.state === 'running');
          if (!remaining.length) break; await delay(50) } while (Date.now() < deadline)
        assert.equal(remaining.length, 0, 'All Task-owned Runs stop before removing their workspace')
      }
      if (remote) proof.protectedAfter = await observeProtected(remote)
      proof.remoteOsAfter = await inspectFarmOs()
      if (farmWorkspace) proof.remoteWorkspaceCleanup = await removeFarmWorkspace(remoteWorkspace, farmWorkspace.parentCreated)
      proof.remoteOsAfterCleanup = await inspectFarmOs()
    } catch (error) { cleanupErrors.push(error.message) }
    for (const client of [remote, local]) try { await client?.dispose() } catch (error) { cleanupErrors.push(error.message) }
    let remaining = []
    try { if (candidate) remaining = await candidate.stopHost() } catch (error) { cleanupErrors.push(error.message) }
    proof.cleanup = { owned, stopped, errors: cleanupErrors, remaining,
      originalBusinessSessionStopped: false, sharedRemoteHostStopped: false }
    if (!cleanupErrors.length && !remaining.length) { await fs.rm(privateRoot, { recursive: true }); proof.cleanup.privateRootRemoved = true }
    else proof.passed = false
    proof.screenshots = await Promise.all((await fs.readdir(evidence)).filter(file => file.endsWith('.png')).map(async file => {
      const absolutePath = path.join(evidence, file), bytes = await fs.readFile(absolutePath)
      return { file, absolutePath, sha256: digest(bytes), bytes: bytes.length,
        width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
    }))
    await write(path.join(evidence, 'receipt.json'), proof)
    const canonical = path.join(root, '.tmp/host-ui-execution/proof.json')
    await fs.copyFile(path.join(evidence, 'receipt.json'), canonical)
    await fs.chmod(canonical, 0o600)
  }
  process.stdout.write(JSON.stringify({ passed: proof.passed, evidence, screenshots: proof.screenshots.length,
    aestheticReview: proof.aestheticReview, failure: proof.failure?.message, cleanupErrors }) + '\n')
  assert.equal(proof.passed, true, proof.failure?.message ?? cleanupErrors.join('; '))
  return proof
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) await captureHostUiExecution()
