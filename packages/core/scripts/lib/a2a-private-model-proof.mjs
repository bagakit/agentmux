import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { exited, selfProcessIdentity, registerChild, terminate, settleExactProcess } from '../fixtures/a2a-agent-behavior/process.mjs'

// Only the original spawn/self receipts may authorize cleanup. Missing or stale
// identities preserve the namespace and the caller's original errors.
export async function cleanupPrivateProofScope({ privateRoot, evidence, ownership, nativeProcessBirth, errors, redact = value => value }) {
  const exactProcesses = [], attempt = async action => { try { return await action() } catch (error) { errors.push(error.message) } }
  if (ownership) {
    await attempt(async () => {
      assert.ok(Object.hasOwn(ownership, 'daemonProcess') && Array.isArray(ownership.modelReceipts) && Array.isArray(ownership.peerReceipts), 'Original private process ownership is incomplete')
      await writeFile(join(evidence, 'owned-processes.json'), redact(JSON.stringify(ownership, null, 2) + '\n'))
    })
    for (const [names, model] of [[ownership.peerReceipts, false], [ownership.modelReceipts, true]]) {
      for (const name of names ?? []) await attempt(async () => {
        const bytes = await readFile(join(privateRoot, name), 'utf8'), receipt = JSON.parse(bytes)
        await writeFile(join(evidence, name), redact(bytes))
        if (model) {
          assert.equal(receipt.modelProcess?.pid, receipt.modelPid, 'Original model PID and birth receipt disagree')
          assert.equal(receipt.wrapperProcess?.pid, receipt.wrapperPid, 'Original wrapper PID and birth receipt disagree')
          assert.equal(typeof receipt.modelOwnProcessGroup, 'boolean', 'Original model process-group ownership is unconfirmed')
          exactProcesses.push(await settleExactProcess(receipt.modelProcess, nativeProcessBirth, receipt.modelOwnProcessGroup))
        } else assert.equal(receipt.processIdentity?.pid, receipt.processId, 'Original peer PID and birth receipt disagree')
        exactProcesses.push(await settleExactProcess(model ? receipt.wrapperProcess : receipt.processIdentity, nativeProcessBirth))
      })
    }
    if (ownership.daemonProcess !== null) exactProcesses.push(await attempt(() => settleExactProcess(ownership.daemonProcess, nativeProcessBirth)))
  }
  if (!errors.length) await attempt(() => rm(privateRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  const privateRootRemoved = await stat(privateRoot).then(() => false, error => { if (error.code === 'ENOENT') return true; throw error })
  return { exactProcesses, errors, privateRootRemoved, noHostProcessScan: true }
}

/** Shared private model-process scope. This never selects a user Runtime. */
export async function launchPrivateA2aProof({ repository, sourceInputs,
  coordinatorEntry, name = 'a2a-agent-behavior', schema = 'agentmux.a2a-agent-behavior-launcher.v1',
  scenario = 'independent-session-channel', model = 'gpt-6.1-sol', prepareOnly = false,
  executableName = process.env.AGENTMUX_A2A_BEHAVIOR_CODEX || 'codex',
  requiredFlags = ['--no-daemon', '--ignore-user-config', '--ignore-rules', '--json'], privatePrefix = 'amux-real-a2a-', installedCoreRoot }) {
  const authSource = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json')
  assert.ok(prepareOnly || installedCoreRoot, 'Real model proof requires an installed Core')
  const executionCoreRoot = installedCoreRoot
  const hash = value => createHash('sha256').update(value).digest('hex')
  const readInput = path => readFile(join(repository, path))
  const sourceHashes = async () => Object.fromEntries(await Promise.all(sourceInputs.map(async path => [path, hash(await readInput(path))])))
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
  const launcher = { schema, candidateCommit: (await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: repository })).stdout.trim(), cleanup: {}, passed: false }
  const parentSecrets = new Set()
  let stdout = '', stderr = ''
  const redact = value => [...parentSecrets].reduce((text, secret) => text.replaceAll(secret, '[redacted-private-credential]'), value)
  let privateRoot, coordinator, nativeProcessBirth, interrupted = false
  const signalCleanup = []
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    interrupted = true
    if (coordinator) signalCleanup.push(terminate(coordinator).catch(error => { launcher.signalCleanupError = error.message }))
  })
  try {
    const executable = await executablePath(executableName)
    privateRoot = await realpath(await mkdtemp(join(tmpdir(), privatePrefix))); await chmod(privateRoot, 0o700)
    for (const name of ['home', 'auth', 'workspace', 'runtime', 'state/ctxmux', 'tmp']) await mkdir(join(privateRoot, name), { recursive: true, mode: 0o700 })
    launcher.installedCoreRoot = executionCoreRoot
    launcher.sourceBefore = await sourceHashes()
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
    await writeFile(planPath, JSON.stringify({ httpToken, repository, privateRoot, evidence, executable, model, sourceBefore: launcher.sourceBefore,
      cli: join(executionCoreRoot, 'bin/amux'), coreRoot: executionCoreRoot, fixturesRoot: join(repository, 'packages/core/scripts/fixtures'), sourceInputs }), { mode: 0o600 })
    assert.equal(interrupted, false, 'Private proof was cancelled before any model coordinator launch')
    ;({ nativeProcessBirth } = await import(pathToFileURL(join(executionCoreRoot, 'dist/agent-native-process.js')).href))
    await selfProcessIdentity(nativeProcessBirth)
    coordinator = spawn(process.execPath, [coordinatorEntry, planPath], { cwd: join(privateRoot, 'workspace'), env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
    const coordinatorIdentity = registerChild(coordinator, nativeProcessBirth)
    coordinator.stdout.on('data', bytes => { stdout += bytes }); coordinator.stderr.on('data', bytes => { stderr += bytes })
    launcher.coordinatorPid = coordinator.pid
    launcher.coordinatorProcess = await coordinatorIdentity
    assert.equal(await exited(coordinator, 780_000), true, 'Bounded private coordinator did not complete')
    launcher.coordinatorExit = { code: coordinator.exitCode, signal: coordinator.signalCode }
    const receipt = JSON.parse(await readFile(join(evidence, 'receipt.json'), 'utf8'))
    assert.equal(coordinator.exitCode, 0, receipt.failure?.message || 'Private coordinator failed')
    assert.equal(receipt.passed, true)
    launcher.completeFeatureCoverage = receipt.completeFeatureCoverage === true
    launcher.passed = true
  } catch (error) { launcher.failure = { message: error.message, stack: error.stack } }
  finally {
    await Promise.all(signalCleanup)
    const errors = []
    const attempt = async action => { try { return await action() } catch (error) { errors.push(error.message) } }
    if (interrupted) { launcher.passed = false; launcher.interrupted = true }
    if (launcher.signalCleanupError) errors.push(launcher.signalCleanupError)
    launcher.cleanup.coordinator = await attempt(() => terminate(coordinator))
    if (privateRoot) {
      // Only identities written by this exact private coordinator and wrappers are
      // eligible. Never enumerate or signal host/user processes.
      const ownership = coordinator ? await attempt(async () => JSON.parse(await readFile(join(privateRoot, 'owned-processes.json'), 'utf8'))) : null
      for (const name of ownership?.credentialReceipts ?? []) {
        const auth = await readFile(join(privateRoot, name), 'utf8').then(JSON.parse, () => null)
        if (auth?.capability) parentSecrets.add(auth.capability)
      }
      const coordinatorReceipt = coordinator ? await attempt(async () => JSON.parse(await readFile(join(evidence, 'receipt.json'), 'utf8'))) : null
      if (coordinatorReceipt) await attempt(async () => {
        assert.ok(Array.isArray(coordinatorReceipt.cleanup?.errors), 'Original coordinator cleanup remains unconfirmed')
        errors.push(...coordinatorReceipt.cleanup.errors)
      })
      Object.assign(launcher.cleanup, await cleanupPrivateProofScope({ privateRoot, evidence, ownership, nativeProcessBirth, errors, redact }))
    }
    launcher.cleanup.errors = errors; launcher.cleanup.noHostProcessScan = true
    if (errors.length) launcher.passed = false
    if (launcher.sourceBefore) launcher.sourceAfter = await attempt(sourceHashes)
    if (launcher.sourceBefore && launcher.sourceAfter && JSON.stringify(launcher.sourceBefore) !== JSON.stringify(launcher.sourceAfter)) {
      launcher.passed = false; launcher.failure ??= { message: 'Candidate source changed during real model proof' }
    }
    if (errors.length) launcher.passed = false
    await writeFile(join(evidence, 'coordinator.stdout.log'), redact(stdout)); await writeFile(join(evidence, 'coordinator.stderr.log'), redact(stderr))
    const inspected = await readdir(evidence)
    launcher.redaction = { exactCredentialCount: parentSecrets.size, checkedFiles: inspected.length, credentialValueFound: false }
    for (const name of inspected) {
      const bytes = await readFile(join(evidence, name), 'utf8')
      if ([...parentSecrets].some(secret => bytes.includes(secret))) { launcher.redaction.credentialValueFound = true; launcher.passed = false }
    }
    await writeFile(join(evidence, 'launcher.json'), redact(JSON.stringify(launcher, null, 2) + '\n'), { mode: 0o600 })
  }
  const result = { passed: launcher.passed, completeFeatureCoverage: launcher.passed && launcher.completeFeatureCoverage === true, receipt: join(evidence, 'receipt.json'), launcher: join(evidence, 'launcher.json') }
  process.stdout.write(JSON.stringify(result) + '\n')
  if (!launcher.passed) process.exitCode = 1
  return result

}
