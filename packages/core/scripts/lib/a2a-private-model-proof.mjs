import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { access, chmod, copyFile, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { delimiter, isAbsolute, join, relative, resolve } from 'node:path'
import { exited, terminate, settleExactPid } from '../fixtures/a2a-agent-behavior/process.mjs'

/** Shared private model-process scope. This never imports Core or selects a user Runtime. */
export async function launchPrivateA2aProof({ repository, sourceInputs,
  coordinatorEntry, name = 'a2a-agent-behavior', schema = 'agentmux.a2a-agent-behavior-launcher.v1',
  scenario = 'independent-session-channel', model = 'gpt-6.1-sol', minimumOnly = false, prepareOnly = false,
  executableName = process.env.AGENTMUX_A2A_BEHAVIOR_CODEX || 'codex',
  requiredFlags = ['--no-daemon', '--ignore-user-config', '--ignore-rules', '--json'], privatePrefix = 'amux-real-a2a-', freezeCandidate = false }) {
  const authSource = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json')
  let executionCoreRoot = join(repository, 'packages/core'), executionCoordinator = coordinatorEntry
  const hash = value => createHash('sha256').update(value).digest('hex')
  const compiledInputs = sourceInputs.filter(path => path.includes('/src/') && path.endsWith('.ts')).map(path => path.replace('/src/', '/dist/').replace(/\.ts$/u, '.js'))
  const compiledHashes = async () => {
    const paths = freezeCandidate ? (await readdir(join(executionCoreRoot, 'dist'), { recursive: true })).filter(path => path.endsWith('.js')).map(path => 'packages/core/dist/' + path) : compiledInputs
    return Object.fromEntries(await Promise.all(paths.map(async path => [path, hash(await readFile(join(executionCoreRoot, path.slice('packages/core/'.length))))])))
  }
  const sourceHashes = async () => Object.fromEntries(await Promise.all(sourceInputs.map(async path => [path, hash(await readFile(join(repository, path)))])))
  async function executablePath(name) {
    const paths = isAbsolute(name) ? [name] : (process.env.PATH ?? '').split(delimiter).map(path => resolve(path, name))
    for (const path of paths) if (await access(path, constants.X_OK).then(() => true, () => false)) return await realpath(path)
    throw Error('Actual model CLI executable is unavailable: ' + name)
  }
  if (prepareOnly) {
    process.stdout.write(JSON.stringify({ provisional: true, modelStarted: false, authFileAvailable: await stat(authSource).then(value => value.isFile(), () => false),
      sourceHashes: await sourceHashes(), scenario, requiredFlags }) + '\n')
    return
  }
  const evidence = join(repository, '.tmp', name + '-' + Date.now())
  await mkdir(evidence, { recursive: true, mode: 0o700 })
  const launcher = { schema, provisional: minimumOnly, candidateCommit: (await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: repository })).stdout.trim(), sourceBefore: await sourceHashes(), cleanup: {}, passed: false }
  const parentSecrets = new Set()
  let stdout = '', stderr = ''
  const redact = value => [...parentSecrets].reduce((text, secret) => text.replaceAll(secret, '[redacted-private-credential]'), value)
  let privateRoot, coordinator, interrupted = false
  const signalCleanup = []
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    interrupted = true
    if (coordinator) signalCleanup.push(terminate(coordinator).catch(error => { launcher.signalCleanupError = error.message }))
  })
  try {
    launcher.compiledBefore = await compiledHashes()
    const executable = await executablePath(executableName)
    const { staleDistComplaint } = await import(new URL('../../../../vitest.dist-freshness.ts', import.meta.url))
    assert.equal(await staleDistComplaint(join(repository, 'packages/core')), null, 'Build this candidate Core before running real models')
    privateRoot = await realpath(await mkdtemp(join(tmpdir(), privatePrefix))); await chmod(privateRoot, 0o700)
    for (const name of ['home', 'auth', 'workspace', 'runtime', 'state/ctxmux', 'tmp']) await mkdir(join(privateRoot, name), { recursive: true, mode: 0o700 })
    if (freezeCandidate) {
      const candidate = join(privateRoot, 'candidate'), core = join(candidate, 'packages/core')
      for (const path of sourceInputs) {
        const target = join(candidate, path)
        await mkdir(resolve(target, '..'), { recursive: true })
        await cp(join(repository, path), target)
        assert.equal(hash(await readFile(target)), launcher.sourceBefore[path], `Source changed while freezing ${path}`)
      }
      await cp(join(repository, 'packages/core/dist'), join(core, 'dist'), { recursive: true, filter: path => !/\.(?:map|ts)$/u.test(path) })
      await cp(join(repository, 'packages/core/package.json'), join(core, 'package.json'))
      for (const name of ['vendor', 'node_modules']) await symlink(join(repository, 'packages/core', name), join(core, name))
      executionCoreRoot = core
      executionCoordinator = join(candidate, relative(repository, coordinatorEntry))
      assert.deepEqual(await compiledHashes(), launcher.compiledBefore, 'Compiled candidate changed while freezing')
      launcher.frozenCandidate = { sourceSnapshot: true, compiledSnapshot: true, liveWorkingTreeUsedByModel: false }
    }
    // Auth bytes are copied without inspection. No host config/instructions/plugin,
    // tool settings, AgentMux state or existing model Session enters the scope.
    await copyFile(authSource, join(privateRoot, 'auth/auth.json')); await chmod(join(privateRoot, 'auth/auth.json'), 0o600)
    const retained = ['PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_CTYPE', 'LC_ALL', 'TERM', 'TMPDIR']
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => retained.includes(key)))
    Object.assign(environment, { HOME: join(privateRoot, 'home'), CODEX_HOME: join(privateRoot, 'auth'), TMPDIR: join(privateRoot, 'tmp'),
      AGENTMUX_RUNTIME_DIRECTORY: join(privateRoot, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(privateRoot, 'state'),
      AGENTMUX_AGENT_SESSION_STORE: join(privateRoot, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(privateRoot, 'messages.ndjson') })
    const planPath = join(privateRoot, 'coordinator-plan.json')
    const httpToken = randomUUID() + randomUUID(); parentSecrets.add(httpToken)
    await writeFile(planPath, JSON.stringify({ httpToken, repository, privateRoot, evidence, executable, model, minimumOnly, sourceBefore: launcher.sourceBefore,
      cli: join(executionCoreRoot, 'bin/amux'), coreRoot: executionCoreRoot, fixturesRoot: freezeCandidate ? join(privateRoot, 'candidate/packages/core/scripts/fixtures') : join(repository, 'packages/core/scripts/fixtures'), sourceInputs }), { mode: 0o600 })
    assert.equal(interrupted, false, 'Private proof was cancelled before any model coordinator launch')
    coordinator = spawn(process.execPath, [executionCoordinator, planPath], { cwd: join(privateRoot, 'workspace'), env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
    coordinator.stdout.on('data', bytes => { stdout += bytes }); coordinator.stderr.on('data', bytes => { stderr += bytes })
    launcher.coordinatorPid = coordinator.pid
    assert.equal(await exited(coordinator, minimumOnly ? 180_000 : 780_000), true, 'Bounded private coordinator did not complete')
    launcher.coordinatorExit = { code: coordinator.exitCode, signal: coordinator.signalCode }
    const receipt = JSON.parse(await readFile(join(evidence, 'receipt.json'), 'utf8'))
    assert.equal(coordinator.exitCode, 0, receipt.failure?.message || 'Private coordinator failed')
    assert.equal(receipt.passed, true)
    launcher.passed = true
  } catch (error) { launcher.failure = { message: error.message, stack: error.stack } }
  finally {
    await Promise.all(signalCleanup)
    const errors = [], exactProcesses = []
    const attempt = async action => { try { return await action() } catch (error) { errors.push(error.message) } }
    if (interrupted) { launcher.passed = false; launcher.interrupted = true }
    if (launcher.signalCleanupError) errors.push(launcher.signalCleanupError)
    launcher.cleanup.coordinator = await attempt(() => terminate(coordinator))
    if (privateRoot) {
      // Only identities written by this exact private coordinator and wrappers are
      // eligible. Never enumerate or signal host/user processes.
      const ownership = await readFile(join(privateRoot, 'owned-processes.json'), 'utf8').then(JSON.parse, () => ({}))
      for (const name of ownership.credentialReceipts ?? []) {
        const auth = await readFile(join(privateRoot, name), 'utf8').then(JSON.parse, () => null)
        if (auth?.capability) parentSecrets.add(auth.capability)
      }
      const exactPids = new Set((ownership.runPids ?? []).filter(Boolean))
      if (ownership.daemonPid) exactPids.add(ownership.daemonPid)
      for (const name of ownership.peerReceipts ?? []) {
        const peerReceipt = await readFile(join(privateRoot, name), 'utf8').then(JSON.parse, () => null)
        if (peerReceipt?.processId) exactPids.add(peerReceipt.processId)
      }
      for (const name of ownership.modelReceipts ?? []) {
        const processReceipt = await readFile(join(privateRoot, name), 'utf8').then(JSON.parse, () => null)
        if (processReceipt) {
          if (processReceipt.wrapperPid) exactPids.add(processReceipt.wrapperPid)
          exactProcesses.push(await attempt(() => settleExactPid(processReceipt.modelPid, processReceipt.modelOwnProcessGroup !== false)))
        }
      }
      for (const pid of exactPids) exactProcesses.push(await attempt(() => settleExactPid(pid)))
      // Preserve failed evidence before removing authentication and scoped data.
      const owned = await readFile(join(privateRoot, 'owned-processes.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error })
      if (owned) await attempt(() => writeFile(join(evidence, 'owned-processes.json'), redact(owned)))
      if (freezeCandidate && launcher.frozenCandidate) {
        await attempt(async () => {
          launcher.compiledAfter = await compiledHashes()
          for (const path of sourceInputs) assert.equal(hash(await readFile(join(privateRoot, 'candidate', path))), launcher.sourceBefore[path], `Frozen source changed: ${path}`)
        })
      }
      if (!errors.length) await attempt(() => rm(privateRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
      launcher.cleanup.privateRootRemoved = await stat(privateRoot).then(() => false, () => true)
    }
    launcher.cleanup.exactProcesses = exactProcesses; launcher.cleanup.errors = errors; launcher.cleanup.noHostProcessScan = true
    if (errors.length) launcher.passed = false
    launcher.sourceAfter = await sourceHashes()
    if (!freezeCandidate) launcher.compiledAfter = await compiledHashes()
    if (JSON.stringify(launcher.compiledBefore) !== JSON.stringify(launcher.compiledAfter)) { launcher.passed = false; launcher.failure = { message: 'Candidate compiled public consumers changed during real model proof' } }
    if (freezeCandidate) launcher.liveSourceChangedDuringRun = Object.keys(launcher.sourceBefore).filter(path => launcher.sourceBefore[path] !== launcher.sourceAfter[path])
    else if (JSON.stringify(launcher.sourceBefore) !== JSON.stringify(launcher.sourceAfter)) { launcher.passed = false; launcher.failure = { message: 'Candidate source changed during real model proof' } }
    await writeFile(join(evidence, 'coordinator.stdout.log'), redact(stdout)); await writeFile(join(evidence, 'coordinator.stderr.log'), redact(stderr))
    const inspected = await readdir(evidence)
    launcher.redaction = { exactCredentialCount: parentSecrets.size, checkedFiles: inspected.length, credentialValueFound: false }
    for (const name of inspected) {
      const bytes = await readFile(join(evidence, name), 'utf8')
      if ([...parentSecrets].some(secret => bytes.includes(secret))) { launcher.redaction.credentialValueFound = true; launcher.passed = false }
    }
    await writeFile(join(evidence, 'launcher.json'), redact(JSON.stringify(launcher, null, 2) + '\n'), { mode: 0o600 })
  }
  process.stdout.write(JSON.stringify({ passed: launcher.passed, provisional: minimumOnly, completeFeatureCoverage: launcher.passed && !minimumOnly, receipt: join(evidence, 'receipt.json'), launcher: join(evidence, 'launcher.json') }) + '\n')
  if (!launcher.passed) process.exitCode = 1

}
