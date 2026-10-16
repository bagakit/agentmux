import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { exited, terminate, settleExactPid } from './fixtures/a2a-agent-behavior/process.mjs'

// The parent never imports Core. Every Core default and native/model process is
// first created in the isolated coordinator's real HOME, not patched afterwards.
const repository = resolve(import.meta.dirname, '../../..')
const fixture = join(import.meta.dirname, 'fixtures/a2a-agent-behavior')
const authSource = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json')
const model = process.env.AGENTMUX_A2A_BEHAVIOR_MODEL || 'gpt-6.1-sol'
const minimumOnly = process.argv.includes('--minimum-only')
const sourceInputs = ['packages/core/bin/amux', 'packages/core/src/index.ts', 'packages/core/src/public-rpc-http.ts', 'packages/core/src/agent-messaging-guidance.ts', 'packages/core/src/agent-outbound-message.ts',
  'packages/core/src/agent-message-render.ts', 'packages/core/src/client.ts', 'packages/core/src/public-rpc-service.ts',
  'packages/core/src/agentmux-cli-commands.ts', 'packages/core/src/agentmux.ts', 'packages/core/src/agent-skills.ts', 'packages/core/src/agentmux-cli-help.ts',
  'packages/core/src/public-rpc-client.ts', 'packages/core/src/public-rpc-server.ts', 'packages/core/src/rpc-business-codec.ts',
  'packages/core/src/agent-global-message-queue.ts', 'packages/core/src/prompt-submission.ts', 'packages/core/src/runtime-paths.ts', 'packages/core/src/agentmux-cli-module-skills.ts',
  'packages/core/scripts/verify-a2a-agent-behavior.mjs', ...['coordinator', 'codex-exec', 'peer', 'process', 'scenarios', 'native-evidence'].map(name => 'packages/core/scripts/fixtures/a2a-agent-behavior/' + name + '.mjs')]
const hash = value => createHash('sha256').update(value).digest('hex')
const compiledInputs = sourceInputs.filter(path => path.includes('/src/') && path.endsWith('.ts')).map(path => path.replace('/src/', '/dist/').replace(/\.ts$/u, '.js'))
const compiledHashes = async () => Object.fromEntries(await Promise.all(compiledInputs.map(async path => [path, hash(await readFile(join(repository, path)))])))
const sourceHashes = async () => Object.fromEntries(await Promise.all(sourceInputs.map(async path => [path, hash(await readFile(join(repository, path)))])))
async function executablePath(name) {
  const paths = isAbsolute(name) ? [name] : (process.env.PATH ?? '').split(delimiter).map(path => resolve(path, name))
  for (const path of paths) if (await access(path, constants.X_OK).then(() => true, () => false)) return await realpath(path)
  throw Error('Actual model CLI executable is unavailable: ' + name)
}
if (process.argv.includes('--prepare-only')) {
  process.stdout.write(JSON.stringify({ provisional: true, modelStarted: false, authFileAvailable: await stat(authSource).then(value => value.isFile(), () => false),
    sourceHashes: await sourceHashes(), scenario: 'independent-session-channel', requiredFlags: ['--no-daemon', '--ignore-user-config', '--ignore-rules', '--json'] }) + '\n')
  process.exit(0)
}
const evidence = join(repository, '.tmp', 'a2a-agent-behavior-' + Date.now())
await mkdir(evidence, { recursive: true, mode: 0o700 })
const launcher = { schema: 'agentmux.a2a-agent-behavior-launcher.v1', provisional: minimumOnly, candidateCommit: (await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: repository })).stdout.trim(), sourceBefore: await sourceHashes(), cleanup: {}, passed: false }
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
  const executable = await executablePath(process.env.AGENTMUX_A2A_BEHAVIOR_CODEX || 'codex')
  const { staleDistComplaint } = await import(new URL('../../../vitest.dist-freshness.ts', import.meta.url))
  assert.equal(await staleDistComplaint(join(repository, 'packages/core')), null, 'Build this candidate Core before running real models')
  privateRoot = await realpath(await mkdtemp(join(tmpdir(), 'amux-real-a2a-'))); await chmod(privateRoot, 0o700)
  for (const name of ['home', 'auth', 'workspace', 'runtime', 'state/ctxmux', 'tmp']) await mkdir(join(privateRoot, name), { recursive: true, mode: 0o700 })
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
    cli: join(repository, 'packages/core/bin/amux'), sourceInputs }), { mode: 0o600 })
  assert.equal(interrupted, false, 'Private proof was cancelled before any model coordinator launch')
  coordinator = spawn(process.execPath, [join(fixture, 'coordinator.mjs'), planPath], { cwd: join(privateRoot, 'workspace'), env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
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
        exactProcesses.push(await attempt(() => settleExactPid(processReceipt.modelPid, true)))
      }
    }
    for (const pid of exactPids) exactProcesses.push(await attempt(() => settleExactPid(pid)))
    // Preserve failed evidence before removing authentication and scoped data.
    const owned = await readFile(join(privateRoot, 'owned-processes.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (owned) await attempt(() => writeFile(join(evidence, 'owned-processes.json'), redact(owned)))
    if (!errors.length) await attempt(() => rm(privateRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
    launcher.cleanup.privateRootRemoved = await stat(privateRoot).then(() => false, () => true)
  }
  launcher.cleanup.exactProcesses = exactProcesses; launcher.cleanup.errors = errors; launcher.cleanup.noHostProcessScan = true
  if (errors.length) launcher.passed = false
  launcher.sourceAfter = await sourceHashes()
  launcher.compiledAfter = await compiledHashes()
  if (JSON.stringify(launcher.compiledBefore) !== JSON.stringify(launcher.compiledAfter)) { launcher.passed = false; launcher.failure = { message: 'Candidate compiled public consumers changed during real model proof' } }
  if (JSON.stringify(launcher.sourceBefore) !== JSON.stringify(launcher.sourceAfter)) { launcher.passed = false; launcher.failure = { message: 'Candidate source changed during real model proof' } }
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
