import { fixturePath as _hygiene_fixturePath } from "../../lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, statfs, symlink, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const exec = promisify(execFile)
export const modelHarnessPaths = [
  'apps/desktop/scripts/verify-mote-daily-autonomy.mjs',
  'apps/desktop/scripts/verify-mote-daily-model.mjs',
  ...['probe.mjs', 'owner.ts', 'entry.mjs'].map(name => 'apps/desktop/scripts/fixtures/mote-daily-model/' + name)
]

/** Source-only closure counters. Original private driver code is loaded; all business ports are
 * explicit doubles and the 120s timer is accelerated. Nothing here qualifies a Native Run or model. */
export async function checkModelSourceGuards({ repository, evidence, scenario: selectedScenario } = {}) {
  repository = resolve(repository ?? new URL('../../../../..', import.meta.url).pathname)
  evidence = resolve(evidence ?? join(repository, '.tmp/mote-daily-model', 'source-guards-' + globalThis.crypto.randomUUID()))
  await mkdir(evidence, { recursive: true })
  const require = createRequire(join(repository, 'package.json')), ts = require('typescript')
  const ownerFile = modelHarnessPaths.find(file => file.endsWith('/owner.ts'))
  const owner = await readFile(join(repository, ownerFile), 'utf8')
  const durableFile = 'packages/core/src/durable-write.ts'
  const durableSource = execFileSync('git', ['show', 'refs/heads/main:' + durableFile], { cwd: repository, encoding: 'utf8' })
  const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText
  const durableModule = { exports: {} }
  runInNewContext(compile(durableSource), { require, module: durableModule, exports: durableModule.exports, process, Buffer }, { filename: durableFile })
  const clientFile = 'packages/core/src/client.ts', identityFile = 'packages/core/src/agent-session-identity.ts', errorFile = 'packages/core/src/errors.ts'
  const clientSource = execFileSync('git', ['show', 'refs/heads/main:' + clientFile], { cwd: repository, encoding: 'utf8' })
  const identitySource = execFileSync('git', ['show', 'refs/heads/main:' + identityFile], { cwd: repository, encoding: 'utf8' })
  const errorSource = execFileSync('git', ['show', 'refs/heads/main:' + errorFile], { cwd: repository, encoding: 'utf8' })
  const clientTree = ts.createSourceFile(clientFile, clientSource, ts.ScriptTarget.Latest, true)
  const identityTree = ts.createSourceFile(identityFile, identitySource, ts.ScriptTarget.Latest, true)
  const originalWrite = clientTree.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'AgentMuxClient')?.members.find(node => ts.isMethodDeclaration(node) && node.name?.getText(clientTree) === 'writeAgent')
  const sameRun = identityTree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'sameRun')
  assert.ok(originalWrite && sameRun, 'Original public native-write definitions must be present')
  const errorModule = { exports: {} }, writeModule = { exports: {} }, identityModule = { exports: {} }
  runInNewContext(compile(errorSource), { module: errorModule, exports: errorModule.exports }, { filename: errorFile })
  runInNewContext(compile(sameRun.getText(identityTree)), { module: identityModule, exports: identityModule.exports }, { filename: identityFile })
  runInNewContext(compile('module.exports = class OriginalWrite { ' + originalWrite.getText(clientTree) + ' }'),
    { module: writeModule, exports: writeModule.exports, sameRun: identityModule.exports.sameRun, AgentMuxError: errorModule.exports.AgentMuxError }, { filename: clientFile })
  const originalCoreWriteSource = { [clientFile]: hash(clientSource), [identityFile]: hash(identitySource), [errorFile]: hash(errorSource) }
  const counters = []
  const scenarios = ['held-action-manager-drain-late-ack', 'failed-ack-stops-immediately', 'spent-five-refuses-next-input', 'trusted-terminal-protocol-zero-model-budget']
  if (selectedScenario) assert.ok(scenarios.includes(selectedScenario), 'Unknown Source-only counter')
  for (const scenario of selectedScenario ? [selectedScenario] : scenarios) {
    const root = await mkdtemp(_hygiene_fixturePath("tmp/amm-model-guard-")), output = join(evidence, scenario)
    await mkdir(output, { recursive: true })
    await mkdir(join(root, 'home/.agentmux/motes/private-mote'), { recursive: true })
    await mkdir(join(root, 'codex-home'), { recursive: true })
    await writeFile(join(root, 'codex-home/config.toml'), '')
    const calls = [], timers = new Set(), nativeRows = [], sid = 'private-guard-session', runId = 'private-guard-run'
    let releaseCreate, releaseManager, releaseProtocol, runtime, core, originalCalls = 0, protocolCalls = 0, coreWriteCalls = 0, stopRequested = false, nativeStopped = false
    const createHeld = new Promise(resolve => { releaseCreate = resolve }), managerHeld = new Promise(resolve => { releaseManager = resolve })
    const protocolHeld = new Promise(resolve => { releaseProtocol = resolve })
    const created = { session: { agentSessionId: sid, workspacePath: root + '/mote', run: { runId } },
      creation: { createOperationId: 'guard-create-operation', initialPrompt: 'confirmed' } }
    const agent = { kind: 'agent', id: sid, workspacePath: root + '/mote', control: { agentSessionId: sid, run: { runId } } }
    const timer = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); fn() }, ms >= 100000 ? 40 : ms); timers.add(id); return id }
    class Runtime {
      constructor() { runtime = this }
      async launchAgent(value) { return core.createAgentWithDelivery(value) }
      async submitPrompt() {}
      async dispose() { calls.push('runtime.dispose') }
    }
    class Manager {
      async start() {}
      stop() {
        stopRequested = true; calls.push('manager.stop.requested')
        if (scenario === 'trusted-terminal-protocol-zero-model-budget') timer(() => {
          calls.push('protocol.ack.released'); releaseProtocol({ runId, acceptedThroughByte: 1 })
        }, 70)
        return managerHeld
      }
      list() { return [] }
    }
    class Native {
      async list() { calls.push('native.list'); return nativeRows.map(row => ({ id: row.id })) }
      async status(id) { assert.equal(id, runId); return nativeRows[0] }
      async prepareStop(id) { assert.equal(id, runId); return { runId: id } }
      async stop() {
        assert.equal(stopRequested, true, 'Original scheduler Stop must be requested before Native Stop')
        nativeStopped = true; calls.push('native.stop'); nativeRows[0].state = { type: 'exited' }
        timer(() => releaseCreate(created), 10)
        // Deliberately held after native Stop: a delivery drain cannot delay the paid-process stop.
        timer(() => { calls.push('manager.stop.drained'); releaseManager() }, 60)
      }
    }
    class Window {
      constructor() {
        this.webContents = { executeJavaScript: async code => {
          if (code.startsWith('window.modelProof.facts')) { calls.push('renderer.facts'); return { ready: true } }
          if (code.startsWith('window.modelProof.createMote')) {
            if (scenario === 'trusted-terminal-protocol-zero-model-budget') {
              const target = { agentSessionId: sid, expectedRun: { runId }, data: '\x1b]11;rgb:0000/0000/0000\x1b\\' }
              // Original Runtime color replies are background promises. Hold its ACK while cleanup begins.
              void core.writeAgent({ ...target, source: 'terminal-protocol' })
              await assert.rejects(core.writeAgent({ ...target, expectedRun: { runId: 'stale-private-run' }, source: 'terminal-protocol' }), { code: 'STALE_AGENT_SESSION' })
              await assert.rejects(core.writeAgent({ ...target, source: 'user' }))
              await assert.rejects(core.writeAgent(target))
              throw Error('Source-only protocol counter ends without a model request')
            }
            return {}
          }
          if (code.startsWith('window.modelProof.discuss')) {
            await runtime.launchAgent({ agentSessionId: sid, createOperationId: 'guard-create-operation',
              prompt: 'private synthetic source counter', workspacePath: root + '/mote' })
            return { agent }
          }
          if (code.startsWith('window.modelProof.dispose')) return undefined
          throw Error('Unexpected source-counter Renderer call: ' + code)
        } }
      }
      async loadFile() {}
      isDestroyed() { return false }
      destroy() {
        const saved = JSON.parse(require('node:fs').readFileSync(join(output, 'owner.json'), 'utf8'))
        assert.equal(saved.phaseActualModelRequests, saved.attemptedModelRequests)
        calls.push('window.destroy.after-durable-receipt')
      }
    }
    const modules = {
      electron: { app: { getPath: () => root + '/desktop' }, BrowserWindow: Window }, '@ctxmux/sdk': { CtxmuxClient: Native },
      '@agentmux/core': { AgentMuxFileAgentSessionStore: class {}, loadAgentSessions: async () => [],
        defaultCtxmuxSocketPath: () => root + '/runtime/ctxmux.sock', startHeadlessAgentMux: async () => {
          core = { async createAgentWithDelivery() {
            originalCalls++
            const persisted = JSON.parse(await readFile(join(output, 'model-budget.json'), 'utf8'))
            assert.equal(persisted.attemptedModelRequests, 1); assert.equal(persisted.inputRequests[0].phase, 'original-input-inflight')
            calls.push('original-core.input')
            nativeRows.push({ id: runId, pid: 1, spec: { cwd: root + '/mote' }, state: { type: 'running' } })
            if (scenario === 'failed-ack-stops-immediately') throw Error('Source counter: input issued but ACK failed')
            return createHeld
          }, async writeAgent(value) { coreWriteCalls++; return writeModule.exports.prototype.writeAgent.call(this, value) },
          requireConnected() {}, requireAgentSession(id) { assert.equal(id, sid); return { agentSessionId: sid, run: { runId } } },
          async writeAgentInput(session, data, source) {
            protocolCalls++; assert.equal(session.agentSessionId, sid); assert.equal(source, 'terminal-protocol')
            calls.push('original-core.protocol-input'); return protocolHeld
          },
          async submitAgentPrompt() {}, async stopAgent() {}, async statusAgent() { throw Error('No durable Session in this held-ACK source counter') } }
          return { client: core, async stop() { calls.push('host.stop') } }
        } },
      '@agentmux/demand': { openDemandStore: () => ({ get() {}, subscribe() { return () => {} } }) },
      '../../../src/main/config-store': { DEFAULT_CONFIG: {}, ConfigStore: class { async save(value) { return value } } },
      '../../../src/main/runtime-controller': { RuntimeController: Runtime }, '../../../src/main/desktop-host': { connectDesktopAgentMuxHost() {} },
      '../../../src/main/scratch-topics': { ScratchTopics: class {} }, '../../../src/main/ipc': { registerIpc: async () => async () => { calls.push('ipc.dispose') } },
      '../../../src/main/continuous-progress-loop-manager': { ContinuousProgressLoopManager: Manager },
      '../../../src/main/continuous-progress-loop-store': { ContinuousProgressLoopStore: { forUserData() {} } },
      '../../../src/main/continuous-progress-delivery': { deliverContinuousProgress() {} },
      '../../../../../packages/core/src/durable-write': durableModule.exports
    }
    const instrumentation = scenario === 'spent-five-refuses-next-input'
      ? { anchor: 'attemptedModelRequests: 0, admittedModelRequests: 0, completedModelTurns: 0', replacement: 'attemptedModelRequests: 5, admittedModelRequests: 0, completedModelTurns: 0' } : null
    let loaded = owner
    if (instrumentation) { assert.equal(loaded.split(instrumentation.anchor).length, 2); loaded = loaded.replace(instrumentation.anchor, instrumentation.replacement) }
    const module = { exports: {} }
    try {
      runInNewContext(compile(loaded), { module, exports: module.exports, require: name => name in modules ? modules[name] : require(name),
        process: { pid: process.pid, env: { AGENTMUX_RUNTIME_DIRECTORY: root + '/runtime', CODEX_HOME: root + '/codex-home' } },
        Buffer, structuredClone, AbortController, AbortSignal, setTimeout: timer, clearTimeout, console }, { filename: ownerFile })
      if (scenario === 'spent-five-refuses-next-input' || scenario === 'trusted-terminal-protocol-zero-model-budget') releaseManager()
      const passed = await module.exports.runModelOwner({ root, evidence: output, html: 'source-counter', preload: 'source-counter',
        command: 'source-counter', codexArgs: [], nativeReadArgs: [], cli: 'source-counter', hook: 'source-counter', decisionFile: 'source-counter' })
      assert.equal(passed, false, 'A source counter cannot qualify a model journey')
      const raw = JSON.parse(await readFile(join(output, 'owner.json'), 'utf8')), budget = JSON.parse(await readFile(join(output, 'model-budget.json'), 'utf8'))
      assert.equal(budget.gateClosed, true); assert.equal(raw.completedModelTurns, 0)
      assert.equal(raw.cleanup.exactPrivateRunsStopped, true); assert.equal(raw.cleanup.nativeConfirmation.inflight, 0)
      if (scenario === 'trusted-terminal-protocol-zero-model-budget') {
        assert.equal(originalCalls, 0); assert.equal(coreWriteCalls, 2); assert.equal(protocolCalls, 1); assert.equal(budget.attemptedModelRequests, 0)
        assert.equal(raw.protocolWrites.length, 2); assert.equal(raw.protocolWrites[0].source, 'terminal-protocol')
        assert.equal(raw.protocolWrites[0].agentSessionId, sid); assert.deepEqual(raw.protocolWrites[0].expectedRun, { runId })
        assert.equal(raw.protocolWrites[0].sha256, hash(Buffer.from('\x1b]11;rgb:0000/0000/0000\x1b\\')))
        assert.deepEqual(raw.protocolWrites[0].ack, { runId, acceptedThroughByte: 1 })
        assert.ok(raw.protocolWrites[1].error.includes('Agent Session changed'))
        assert.equal(raw.rejectedInputs.length, 2); assert.ok(raw.rejectedInputs.every(one => one.method === 'writeAgent'))
        assert.ok(calls.indexOf('manager.stop.requested') < calls.indexOf('protocol.ack.released'))
        assert.ok(calls.indexOf('protocol.ack.released') < calls.indexOf('ipc.dispose'), 'Entire protocol observation must settle before owner cleanup')
      } else if (instrumentation) { assert.equal(originalCalls, 0); assert.equal(budget.attemptedModelRequests, 5); assert.equal(raw.rejectedInputs.length, 1) }
      else {
        assert.equal(originalCalls, 1); assert.equal(raw.modelTurns, 1); assert.equal(nativeStopped, true)
        assert.ok(calls.indexOf('native.stop') < calls.indexOf('manager.stop.drained'))
        assert.ok(raw.attempts[0].failure && budget.inputRequests[0].failedAt)
      }
      if (scenario === 'failed-ack-stops-immediately') assert.ok(calls.indexOf('manager.stop.requested') < calls.lastIndexOf('renderer.facts'))
      counters.push({ scenario, passed: true, ownerSha256: hash(owner), loadedSha256: hash(loaded), instrumentation,
        originalInputCalls: originalCalls, originalProtocolCalls: protocolCalls, originalCoreWriteCalls: coreWriteCalls, calls, rawSha256: hash(await readFile(join(output, 'owner.json'))),
        budgetSha256: hash(await readFile(join(output, 'model-budget.json'))), qualification: 'Source closure counter with explicit doubles; no Native/model' })
    } finally { for (const id of timers) clearTimeout(id); await rm(root, { recursive: true, force: true }) }
  }
  const receipt = { schema: 'agentmux.mote.model-source-guards.v1', taskId: 'T-008', passed: true,
    ownerSource: { path: ownerFile, sha256: hash(owner) }, originalEvidenceWriter: { path: durableFile, sha256: hash(durableSource) },
    originalCoreWriteSource, originalCoreExtraction: 'Original writeAgent/sameRun/error definitions; explicit connected/session/writeAgentInput ports, no Native process',
    counters, acceleratedDeadlineMs: 40, productionDeadlineMs: 120000, authFilesRead: false, authCopied: false,
    actualModelRequests: 0, actualNativeRuns: 0, realModelQualified: false }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2)); console.log(JSON.stringify({ sourceGuards: true, evidence, actualModelRequests: 0 }))
  return receipt
}

/** Only the Root-issued grant is read here. No seed/auth file or process is touched. */
export async function readModelAuthorization(file, expectedSha256) {
  assert.ok(file && /^[a-f0-9]{64}$/.test(expectedSha256 ?? ''),
    'T-008 is pending: Root must provide its explicit private authorization artifact and exact SHA before auth reads or model launch')
  const bytes = await readFile(file)
  assert.equal(hash(bytes), expectedSha256, 'Root private authorization bytes changed')
  const grant = JSON.parse(bytes)
  assert.equal(grant.schema, 'agentmux.mote.real-model-run-trigger.v1')
  assert.equal(grant.taskId, 'T-008'); assert.equal(grant.rootApproved, true); assert.equal(grant.runTriggerIssued, true)
  const bound = async locator => {
    assert.ok(locator?.path && /^[a-f0-9]{64}$/.test(locator.sha256 ?? ''), 'Root trigger needs exact user/source/review locators')
    const bytes = await readFile(locator.path); assert.equal(hash(bytes), locator.sha256, 'Root trigger evidence changed')
    return JSON.parse(bytes)
  }
  const user = await bound(grant.userAuthorization), manifest = await bound(grant.sourceManifest), review = await bound(grant.sourceReview)
  assert.equal(user.schema, 'agentmux.mote-real-model-user-authorization.v1')
  assert.equal(user.status, 'user-authorized-execution-awaits-source-review'); assert.equal(user.runTriggerIssued, false)
  assert.equal(user.maxModelTurns, 6); assert.equal(user.maxTurnMs, 120000)
  assert.equal(review.status, 'approved'); assert.ok(review.taskIds?.includes('T-008'))
  assert.equal(review.sourceManifestSha256, grant.sourceManifest.sha256)
  assert.equal(review.sourceGate?.sha256, manifest.sourcePreparation.sha256)
  const prepared = await bound(manifest.sourcePreparation)
  assert.equal(prepared.sourcePreparation?.passed, true); assert.equal(prepared.passed, false)
  assert.equal(prepared.modelTurns, 0); assert.equal(prepared.authFilesRead, false); assert.equal(prepared.authCopied, false)
  assert.deepEqual(manifest.harnessSource, prepared.harnessSource); assert.deepEqual(manifest.source, prepared.source)
  assert.equal(grant.providerId, 'codex'); assert.equal(grant.maxModelTurns, grant.continuation ? 3 : 5); assert.equal(grant.turnTimeoutMs, 120000)
  assert.equal(grant.priorActualModelTurns, grant.continuation ? 4 : 2)
  assert.equal(user.supplementalAuthorization?.maxActualModelTurnsTotal, 7)
  assert.ok(grant.priorActualModelTurns + grant.maxModelTurns <= user.supplementalAuthorization.maxActualModelTurnsTotal)
  if (grant.continuation) {
    const previous = await bound(grant.continuation.receipt), budget = await bound(grant.continuation.budget)
    assert.equal(previous.passed, false); assert.equal(previous.modelTurns, 2); assert.equal(previous.nativeCleanupConfirmation.stopped, true)
    assert.equal(budget.attemptedModelRequests, 2); assert.equal(budget.completedModelTurns, 2); assert.equal(budget.gateClosed, true)
    assert.ok(previous.nativeCleanupConfirmation.runs.every(run => run.cwd.startsWith(grant.continuation.root + '/') && run.state.type !== 'running'))
    assert.ok(grant.continuation.root.startsWith(_hygiene_fixturePath("tmp/amx-real-codex-")))
    assert.equal(grant.continuation.turnHashes.length, 2)
    assert.equal(grant.continuation.evidence, dirname(grant.continuation.receipt.path))
    for (const [file, sha256] of Object.entries(grant.continuation.originalState)) assert.equal(hash(await readFile(join(grant.continuation.root, file))), sha256)
  }
  assert.deepEqual(grant.credentialFiles, ['auth.json', 'config.toml'])
  assert.equal(grant.copyIsolatedSeed, true)
  assert.ok(typeof grant.seedPath === 'string' && grant.seedPath.startsWith('/'))
  assert.notEqual(resolve(grant.seedPath), resolve(homedir(), '.codex'), 'Original real-codex scope requires a Root-authorized isolated seed')
  assert.ok(typeof grant.decisionFile === 'string' && grant.decisionFile.startsWith('/'))
  assert.ok(Number.isSafeInteger(grant.expiresAt) && grant.expiresAt > Date.now(), 'Private authorization expired')
  return { grant, sha256: expectedSha256, manifest }
}

/** --prepare compiles only; --run is called solely after Root reviewed Source and issued the grant. */
export async function probeRealMoteModel({ repository, evidence, mainRef, authorization, authorizationSha256, prepareOnly = false } = {}) {
  const permission = prepareOnly ? null : await readModelAuthorization(authorization, authorizationSha256)
  const repositoryRoot = resolve(repository ?? new URL('../../../../..', import.meta.url).pathname)
  const dependencyRoot = dirname(resolve(repositoryRoot, execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: repositoryRoot, encoding: 'utf8' }).trim()))
  mainRef ??= execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: repositoryRoot, encoding: 'utf8' }).trim()
  evidence = resolve(evidence ?? join(repositoryRoot, '.tmp/mote-daily-model', 'attempt-' + globalThis.crypto.randomUUID()))
  await mkdir(evidence, { recursive: true })
  const disk = await statfs(evidence); assert.ok(disk.bavail * disk.bsize > 150 * 1024 * 1024, 'Private Source preparation needs 150 MiB; nothing has launched')
  const buildRoot = await realpath(await mkdtemp(_hygiene_fixturePath("tmp/amm-source-"))), source = join(buildRoot, 'source')
  const receipt = { schema: 'agentmux.mote.real-model.v1', taskId: 'T-008', passed: false, status: 'pending',
    sourcePinnedMain: mainRef, source: {}, sourceOrigins: {}, harnessSource: {}, compiledImports: {}, compiledOutputs: {}, generatedInputs: {},
    authFilesRead: false, authCopied: false, userRunTouched: false, modelTurns: 0,
    authorization: permission ? { sha256: permission.sha256, userAuthorization: permission.grant.userAuthorization,
      maxModelTurns: permission.grant.maxModelTurns, turnTimeoutMs: 120000, credentialFiles: permission.grant.credentialFiles } : null,
    limitations: ['Only original synthetic private Mote files and owned Runs are in scope.',
      'Source preparation is not model cooperation, memory, proposal value, Runtime, or Native qualification.',
      'Actual model evidence requires original native history/tools, file readback and independent usefulness approval.',
      'No package, installation, user App/Run, login, default authentication read or paid retry matrix.'] }
  let scope, runtimeRoot, originalEnvironment, modelOwnerStarted = false, nativeStarted = false, prepared = false, processProbe, compilation = 'manifest'
  let nativeObserver, guardianTimer, guardianWork = Promise.resolve(), guardianBusy = false
  const readBudget = async () => {
    const budget = await readFile(join(evidence, 'model-budget.json'), 'utf8').then(JSON.parse).catch(error => {
      if (error.code === 'ENOENT') return null; throw error
    })
    if (budget) {
      assert.equal(budget.schema, 'agentmux.mote.model-input-budget.v1')
      receipt.modelBudget = budget; receipt.modelTurns = budget.phaseActualModelRequests ?? budget.attemptedModelRequests
    } else if (modelOwnerStarted) { receipt.modelTurns = null; receipt.modelRequestsUnknown = true }
    return budget
  }
  const nativeConfirmedEnded = async (stop = false) => {
    assert.ok(nativeObserver && nativeStarted && runtimeRoot)
    for (const row of await nativeObserver.list()) {
      const run = await nativeObserver.status(row.id)
      assert.ok(run.spec.cwd.startsWith(runtimeRoot + '/'), 'Private Native cleanup refused a foreign cwd')
      if (stop && run.state.type === 'running') await nativeObserver.stop(await nativeObserver.prepareStop(run.id))
    }
    const runs = await Promise.all((await nativeObserver.list()).map(async row => {
      const run = await nativeObserver.status(row.id)
      assert.ok(run.spec.cwd.startsWith(runtimeRoot + '/'))
      return { runId: run.id, cwd: run.spec.cwd, pid: run.pid, state: run.state }
    }))
    return { observedAt: Date.now(), runs, stopped: runs.every(run => run.state.type !== 'running') }
  }
  const preservePrivateArtifacts = async confirmation => {
    assert.equal(confirmation.stopped, true)
    const files = [], unavailable = []; let copiedBytes = 0
    const retain = async (directory, category, base = directory) => {
      const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
        if (error.code === 'ENOENT') { unavailable.push({ category, reason: 'Original private directory was not produced' }); return [] }
        throw error
      })
      for (const entry of entries) {
        if (entry.isSymbolicLink()) { unavailable.push({ category, reason: 'Symbolic link excluded', name: entry.name }); continue }
        if (entry.name === 'auth.json' || entry.name === 'config.toml' || category === 'synthetic-files' && entry.name.startsWith('.')) continue
        const file = join(directory, entry.name)
        if (entry.isDirectory()) { await retain(file, category, base); continue }
        if (!entry.isFile() || category === 'native-rollout' && !entry.name.endsWith('.jsonl')) continue
        const size = (await lstat(file)).size
        if (size > 2 * 1024 * 1024 || copiedBytes + size > 20 * 1024 * 1024 || files.length >= 400) {
          unavailable.push({ category, reason: 'Bounded evidence copy capacity exceeded', name: relative(base, file), size }); continue
        }
        const bytes = await readFile(file), path = join('retained-originals', category, relative(base, file))
        await mkdir(dirname(join(evidence, path)), { recursive: true }); await writeFile(join(evidence, path), bytes)
        copiedBytes += bytes.length; files.push({ category, path, sha256: hash(bytes), bytes: bytes.length })
      }
    }
    // Fresh scope contains only this journey's provider sessions; default auth/config are never copied.
    await retain(join(runtimeRoot, 'codex-home/sessions'), 'native-rollout')
    for (const [index, cwd] of [...new Set(confirmation.runs.map(run => run.cwd))].entries()) {
      assert.ok(cwd.startsWith(runtimeRoot + '/home/.agentmux/'), 'Only original owned Mote materials may be retained')
      await retain(cwd, 'synthetic-files', dirname(cwd))
    }
    receipt.retainedOriginals = { files, unavailable, copiedBytes, stoppedNativeObservedAt: confirmation.observedAt,
      attribution: 'Only this fresh private scope; unmatched native IDs remain unconfirmed rather than guessed', authOrConfigCopied: false }
  }
  try {
    await mkdir(source)
    const platform = process.platform + '-' + process.arch
    execFileSync('tar', ['-x', '-C', source], { input: execFileSync('git', ['archive', mainRef,
      'tsconfig.base.json', 'packages/core/src', 'packages/core/package.json', 'packages/core/bin', `packages/core/vendor/ctxmux/${platform}`,
      'packages/core/test/helpers/real-codex-fixture.ts', 'apps/desktop/src', 'apps/desktop/package.json', 'apps/desktop/browser-extension/protocol.js',
      'apps/desktop/test/helpers/client-ui-render.tsx', 'apps/desktop/scripts/probe-process.mjs', 'apps/desktop/resources',
      'apps/desktop/native/workspace-move.c', 'packages/demand', 'packages/layout', 'packages/client-ui', 'packages/relay'],
      { cwd: repositoryRoot, maxBuffer: 90 * 1024 * 1024 }) })
    for (const file of modelHarnessPaths) {
      const bytes = await readFile(join(repositoryRoot, file)); receipt.harnessSource[file] = hash(bytes)
      await mkdir(dirname(join(source, file)), { recursive: true }); await cp(join(repositoryRoot, file), join(source, file))
    }
    for (const name of ['node_modules', 'apps/desktop/node_modules', 'packages/core/node_modules', 'packages/demand/node_modules',
      'packages/layout/node_modules', 'packages/client-ui/node_modules', 'packages/relay/node_modules']) {
      const available = await realpath(join(repositoryRoot, name)).catch(error => {
        if (error.code !== 'ENOENT') throw error; return realpath(join(dependencyRoot, name))
      })
      await symlink(available, join(source, name))
    }
    await writeFile(join(source, 'package.json'), '{"type":"module"}\n')
    const require = createRequire(join(repositoryRoot, 'apps/desktop/package.json'))
    const esbuild = createRequire(require.resolve('vite'))('esbuild'), aliases = []
    for (const name of ['core', 'demand', 'layout', 'relay', 'client-ui']) {
      const root = join(source, 'packages', name), manifestPath = join(root, 'package.json')
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')); receipt.source[relative(source, manifestPath)] = hash(await readFile(manifestPath))
      for (const [key, value] of Object.entries(manifest.exports).sort(([a], [b]) => Number(a.includes('*')) - Number(b.includes('*')) || b.length - a.length)) {
        const target = typeof value === 'string' ? value : name === 'client-ui' ? value.browser : value.import
        if (!target || target.endsWith('.json')) continue
        const file = name === 'client-ui' ? target : target.replace('./dist/', name === 'core' || name === 'relay' ? './src/' : './').replace(/\.js$/, '.ts')
        const spec = '@agentmux/' + name + (key === '.' ? '' : key.slice(1))
        aliases.push({ find: new RegExp('^' + spec.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.+)') + '$'), replacement: resolve(root, file).replace('*', '$1') })
      }
    }
    const bind = async file => {
      if (file.startsWith(source + '/') && !file.includes('/node_modules/') && !file.includes('/vendor/')) {
        const key = relative(source, file), sha256 = hash(await readFile(file)); receipt.source[key] = sha256
        if (key === 'apps/desktop/scripts/fixtures/mote-daily-model/index.html') {
          delete receipt.source[key]; receipt.generatedInputs[key] = sha256; return
        }
        ;(receipt.compiledImports[compilation] ??= {})[key] = sha256
      }
    }
    const helper = join(buildRoot, 'workspace-move')
    execFileSync('cc', ['-O2', join(source, 'apps/desktop/native/workspace-move.c'), '-o', helper])
    await bind(join(source, 'apps/desktop/native/workspace-move.c'))
    receipt.helper = { source: 'apps/desktop/native/workspace-move.c', sourceSha256: receipt.source['apps/desktop/native/workspace-move.c'], binarySha256: hash(await readFile(helper)), invoked: false }
    const plugin = { name: 'real-mote-pinned-source', setup(builder) {
      builder.onResolve({ filter: /^@agentmux\// }, args => { const one = aliases.find(alias => alias.find.test(args.path)); return one ? { path: args.path.replace(one.find, one.replacement) } : null })
      builder.onResolve({ filter: /^\.\.\/\.\.\/dist\/index\.js$/ }, args => args.importer.endsWith('/test/helpers/real-codex-fixture.ts')
        ? { path: join(source, 'packages/core/src/index.ts') } : null)
      builder.onLoad({ filter: /\.(ts|tsx|mjs|js|json)$/ }, async args => {
        await bind(args.path)
        if (args.path.endsWith('/scratch-directory-identity.mjs') || args.path.endsWith('/scratch-directory-maintenance.mjs')) {
          const bytes = await readFile(args.path, 'utf8'), anchor = "const defaultHelper = resolve(import.meta.dirname, '../../resources/bin/agentmux-workspace-move')"
          assert.equal(bytes.split(anchor).length, 2)
          return { contents: bytes.replace(anchor, 'const defaultHelper = process.env.MOTE_MODEL_PRIVATE_HELPER'), loader: 'js' }
        }
        return null
      })
    } }
    const folder = join(source, 'apps/desktop/scripts/fixtures/mote-daily-model'), dist = join(source, 'packages/core/dist')
    await mkdir(dist, { recursive: true })
    const options = { bundle: true, platform: 'node', format: 'esm', external: ['electron', '@ctxmux/sdk', 'fs-native-extensions'],
      plugins: [plugin], logLevel: 'error', loader: { '.png': 'file', '.svg': 'file' },
      banner: { js: "import{createRequire as privateRequire}from'node:module';const require=privateRequire(import.meta.url);" } }
    const owner = join(dist, 'model-owner.mjs'), cli = join(dist, 'agentmux.js'), hook = join(dist, 'agent-hook-command.js'), realScope = join(dist, 'real-model-scope.mjs')
    for (const [name, entry, output] of [
      ['mainOwner', join(folder, 'owner.ts'), owner], ['sourceCLI', join(source, 'packages/core/src/agentmux.ts'), cli],
      ['sourceHook', join(source, 'packages/core/src/agent-hook-command.ts'), hook],
      ['realScope', join(source, 'packages/core/test/helpers/real-codex-fixture.ts'), realScope]
    ]) { compilation = name; await esbuild.build({ ...options, entryPoints: [entry], outfile: output }); receipt.compiledOutputs[name] = hash(await readFile(output)) }
    const preload = join(buildRoot, 'preload.cjs'); compilation = 'preload'
    await esbuild.build({ bundle: true, platform: 'node', format: 'cjs', external: ['electron'], plugins: [plugin], logLevel: 'error',
      entryPoints: [join(source, 'apps/desktop/src/preload/index.ts')], outfile: preload })
    receipt.compiledOutputs.preload = hash(await readFile(preload))
    const html = '<!doctype html><html><head><meta charset="utf-8"><title>Private original Mote model journey</title></head><body><div id="root"></div><div id="calendar"></div><script type="module" src="./entry.mjs"></script></body></html>'
    await writeFile(join(folder, 'index.html'), html); receipt.compiledOutputs.generatedHtml = hash(html)
    const { build } = await import(require.resolve('vite')); compilation = 'renderer'
    await build({ configFile: false, root: folder, base: './', logLevel: 'error', resolve: { alias: aliases }, esbuild: { jsx: 'automatic' },
      define: { __AGENTMUX_WEB_PREVIEW__: 'false', 'process.env.NODE_ENV': '"production"' },
      plugins: [{ name: 'real-mote-renderer-source', enforce: 'pre', async load(id) { await bind(id.split('?')[0]); return null } }],
      build: { target: 'esnext', minify: false, outDir: join(buildRoot, 'renderer'), emptyOutDir: true } })
    for (const name of ['agentmux', 'agentmux-hook.js']) {
      const file = join(source, 'packages/core/bin', name); await bind(file)
      receipt.compiledOutputs['originalBin:' + name] = hash(await readFile(file))
    }
    receipt.cliLocation = { originalBin: 'packages/core/bin/agentmux', originalHook: 'packages/core/bin/agentmux-hook.js',
      coreModuleFolder: 'packages/core/dist', exportedBy: 'packages/core/src/client.ts terminalEnvironment', executorOverride: false }
    compilation = 'driver'; await bind(join(source, 'apps/desktop/scripts/probe-process.mjs'))
    receipt.sourcePreparation = { passed: true, compiledOnly: prepareOnly, realModelQualified: false }
    prepared = true
    if (!prepareOnly) {
      // Authorization was validated before Source creation; seed auth first becomes reachable here.
      assert.ok(permission); assert.ok(permission.grant.expiresAt > Date.now())
      for (const [file, sha256] of Object.entries(receipt.harnessSource)) receipt.source[file] = sha256
      assert.deepEqual(receipt.harnessSource, permission.manifest.harnessSource, 'Only independently reviewed harness bytes may run')
      assert.deepEqual(receipt.source, permission.manifest.source, 'Actual compiled Source differs from Root-approved model graph')
      // A trigger is consumed before the first seed stat/read. A failed attempt never silently spends another budget.
      await writeFile(join(repositoryRoot, '.tmp/mote-daily-model', 'run-trigger-' + permission.sha256 + '.used.json'),
        JSON.stringify({ sha256: permission.sha256, taskId: 'T-008', consumedAt: Date.now(), evidence }), { flag: 'wx', mode: 0o600 })
      receipt.authAccessAttempted = true
      // A partial original copy failure is unknown until the original private destinations are observed.
      receipt.authFilesRead = null; receipt.authCopied = null
      originalEnvironment = { ...process.env }; process.env.CODEX_HOME = permission.grant.seedPath
      process.env.TMPDIR = _hygiene_fixturePath("tmp")
      const fixture = await import(pathToFileURL(realScope).href)
      try {
        if (permission.grant.continuation) {
          const original = permission.grant.continuation, retained = ['PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_CTYPE', 'LC_ALL', 'TERM']
          for (const key of Object.keys(process.env)) if (!retained.includes(key)) delete process.env[key]
          const root = original.root
          Object.assign(process.env, { HOME: join(root, 'home'), CODEX_HOME: join(root, 'codex-home'), TMPDIR: join(root, 'tmp'),
            AGENTMUX_RUNTIME_DIRECTORY: join(root, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(root, 'durable'),
            AGENTMUX_AGENT_SESSION_STORE: join(root, 'agent-sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'global-messages.ndjson') })
          scope = new fixture.RealCodexScope(root, originalEnvironment)
          // Original stores, native index and UI storage remain in place. Only
          // the already-authorized disposable credential files are copied again.
          for (const name of permission.grant.credentialFiles) {
            await cp(join(permission.grant.seedPath, name), join(root, 'codex-home', name)); await chmod(join(root, 'codex-home', name), 0o600)
          }
          receipt.originalPhase = { receipt: original.receipt, budget: original.budget, sourceManifest: original.sourceManifest,
            sourceReview: original.sourceReview, priorModelInputs: 2 }
        } else scope = await fixture.prepareRealCodexScope(value => { scope = value })
      }
      catch (error) {
        if (scope) {
          receipt.authCopyObservation = await Promise.all(['auth.json', 'config.toml'].map(async name => ({ name,
            destinationPresent: await lstat(join(scope.root, 'codex-home', name)).then(value => value.isFile(), one => {
              if (one.code === 'ENOENT') return false; throw one
            }) })))
          // Do not retain contents or claim that a failed/partial copy never read a credential.
          receipt.authFilesRead = receipt.authCopyObservation.some(one => one.destinationPresent) ? true : null
          receipt.authCopied = receipt.authCopyObservation.every(one => one.destinationPresent) ? true : null
        } else { for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, originalEnvironment) }
        throw error
      }
      runtimeRoot = scope.root; receipt.authFilesRead = true; receipt.authCopied = true
      const command = permission.grant.command ?? 'codex'
      const preflight = await Promise.allSettled([
        exec(command, [...fixture.privateCodexConfigArgs, '--version'], { timeout: 10000 }),
        exec(command, [...fixture.privateCodexConfigArgs, 'login', 'status'], { timeout: 10000 }),
        exec(command, [...fixture.privateCodexConfigArgs, 'mcp', 'list', '--json'], { timeout: 10000 }),
        exec(command, [...fixture.privateCodexConfigArgs, 'features', 'list'], { timeout: 10000 })
      ])
      assert.ok(preflight.every(one => one.status === 'fulfilled'), 'Private real Codex preflight failed; sensitive configuration output is not included')
      const [version, auth, mcp, features] = preflight.map(one => one.value)
      assert.match(version.stdout.trim(), /^codex-cli 0\./); assert.ok((auth.stdout + auth.stderr).includes('Logged in'))
      let noMcpServers = false
      try { const servers = JSON.parse(mcp.stdout); noMcpServers = Array.isArray(servers) && servers.length === 0 } catch {}
      assert.equal(noMcpServers, true, 'Private model journey excludes external MCP servers; configuration output is not included')
      const featureRows = features.stdout.trim().split('\n').map(line => line.trim().split(/\s+/u))
      for (const [name, enabled] of [['hooks', 'true'], ['plugins', 'false'], ['plugin_hooks', 'false'], ['memories', 'false'], ['chronicle', 'false']])
        assert.deepEqual(featureRows.filter(row => row[0] === name).map(row => row.at(-1)), [enabled], 'Private provider features do not match the original bounded fixture')
      receipt.providerPreflight = { version: version.stdout.trim(), loggedIn: true, noExternalMcp: true, originalFeaturesConfirmed: true }
      const executable = resolve(execFileSync('which', [command], { encoding: 'utf8' }).trim())
      receipt.executable = { node: process.execPath, nodeSha256: hash(await readFile(process.execPath)), command: executable, commandSha256: hash(await readFile(executable)) }
      const artifact = join(source, 'packages/core/vendor/ctxmux', platform, 'bin/ctxmuxd')
      receipt.artifact = { path: relative(source, artifact), sha256: hash(await readFile(artifact)) }
      // Keep the parent's owned daemon outside the Electron probe's cleanup root.
      const privateArtifact = join(runtimeRoot, 'ctxmuxd')
      await cp(artifact, privateArtifact)
      assert.equal(hash(await readFile(privateArtifact)), receipt.artifact.sha256)
      receipt.artifact.privateCopySha256 = receipt.artifact.sha256
      const sdk = await import(pathToFileURL(join(source, 'packages/core/node_modules/@ctxmux/sdk/dist/index.js')).href)
      nativeObserver = new sdk.CtxmuxClient({ socketPath: join(runtimeRoot, 'runtime/ctxmux.sock') })
      if (permission.grant.continuation) {
        // A stale socket is removed only after the original endpoint refuses a
        // read. A serving daemon or an unknown failure cannot be replaced.
        await nativeObserver.list().then(() => { throw Error('Original private Native is still serving; do not replace it') }, error => {
          assert.equal(error.code, 'ECONNREFUSED', 'Original private socket state is unconfirmed')
        })
        await unlink(join(runtimeRoot, 'runtime/ctxmux.sock'))
      }
      await scope.startNative(privateArtifact)
      nativeStarted = true
      const args = [...fixture.privateCodexConfigArgs, '--dangerously-bypass-hook-trust', '--no-alt-screen', '--ask-for-approval', 'never',
        '--sandbox', 'workspace-write', '--config', 'model_reasoning_effort="low"']
      const parameters = { html: join(buildRoot, 'renderer/index.html'), preload, root: runtimeRoot, evidence,
        command: executable, codexArgs: args, nativeReadArgs: [...fixture.privateCodexConfigArgs], cli: join(source, 'packages/core/bin/agentmux'),
        hook: join(source, 'packages/core/bin/agentmux-hook.js'), decisionFile: permission.grant.decisionFile,
        ...(permission.grant.continuation ? { continuation: { evidence: permission.grant.continuation.evidence,
          receiptSha256: permission.grant.continuation.receipt.sha256, budgetSha256: permission.grant.continuation.budget.sha256,
          turnHashes: permission.grant.continuation.turnHashes } } : {}) }
      const main = ("const{app}=require('electron');const input=" + (JSON.stringify(parameters)) + (";app.setPath('userData',input.root+'/desktop');app.setPath('sessionData',input.root+'/desktop-session');app.setPath('home',input.root+'" + _hygiene_fixturePath("home") + "');app.on('window-all-closed',()=>{});app.whenReady().then(async()=>{const{runModelOwner}=await import(") + (JSON.stringify(pathToFileURL(owner).href)) + ");const passed=await runModelOwner(input);app.exit(passed?0:1)}).catch(error=>{console.error(error);app.exit(1)});")
      const mainFile = join(buildRoot, 'main.cjs'); await writeFile(mainFile, main); receipt.compiledOutputs.generatedMain = hash(main)
      processProbe = await import(pathToFileURL(join(source, 'apps/desktop/scripts/probe-process.mjs')).href)
      const lines = [], env = { ...process.env, MOTE_MODEL_PRIVATE_HELPER: helper }; delete env.ELECTRON_RUN_AS_NODE
      modelOwnerStarted = true
      // The original parent-owned daemon must remain readable until exact Native Stop is confirmed.
      // This guardian only stops owned processes/Native Runs; it cannot authorize or send model Input.
      guardianTimer = setInterval(() => {
        if (guardianBusy) return
        guardianBusy = true
        guardianWork = (async () => {
          const budget = await readBudget()
          if (!budget) return
          const expired = budget.attempts?.find(one => one.phase !== 'completed' && one.deadlineAt && Date.now() >= one.deadlineAt)
          if (!expired && budget.attemptedModelRequests <= 5) return
          // A sealed input gate alone does not prove the Native Run ended. Stop and
          // confirm it before allowing the owner time to retain its original result.
          if (expired && budget.gateClosed && Date.now() < expired.deadlineAt + 45000) {
            try {
              receipt.deadlineNativeStop = await nativeConfirmedEnded(true)
              if (receipt.deadlineNativeStop.stopped) return
            } catch (error) { receipt.deadlineNativeStopError = error.message }
          }
          receipt.guardian = { failed: true, at: Date.now(), reason: expired ? 'actual-request-deadline' : 'input-budget', budget }
          // Kill the exact private Electron owner first, fencing late queued launches, then stop the
          // same private Native Runs. The original scope is retained if readback cannot prove cleanup.
          await processProbe.signalOwnedProbeProcess(budget.pid, buildRoot, 'SIGTERM')
          receipt.guardian.native = await nativeConfirmedEnded(true)
        })().catch(error => { receipt.guardianError = error.message }).finally(() => { guardianBusy = false })
      }, 50)
      receipt.process = await processProbe.runProbeProcess(require('electron'), [mainFile], { temporaryRoot: buildRoot, cwd: source,
        env, timeoutMs: 5 * 120000 + 600000 + 180000, onLine: line => lines.push(line) })
      clearInterval(guardianTimer); await guardianWork
      await writeFile(join(evidence, 'private-electron.log'), lines.join('\n'))
      await readBudget()
      receipt.owner = JSON.parse(await readFile(join(evidence, 'owner.json'), 'utf8'))
      assert.equal(receipt.process.timedOut, false); assert.equal(receipt.process.exitCode, 0, receipt.owner.error?.message)
      assert.equal(receipt.guardian, undefined, 'Parent watchdog stopped an unconfirmed/expired private request')
      assert.equal(receipt.owner.passed, true); assert.equal(receipt.modelTurns, permission.grant.maxModelTurns)
      receipt.passed = true; receipt.status = 'awaiting-independent-review'
    }
  } catch (error) { receipt.error = { message: error.message, stack: error.stack }; receipt.status = prepared ? 'failed' : 'pending' }
  finally {
    clearInterval(guardianTimer); await guardianWork
    if (modelOwnerStarted) await readBudget().catch(error => { receipt.budgetReadError = error.message; receipt.modelTurns = null; receipt.modelRequestsUnknown = true })
    const errors = []
    if (scope) {
      try {
        // The Main owner stopped only its exact private Runs. Independently confirm original Native state
        // before the existing fixture removes auth and its daemon. No scope client is fabricated.
        if (nativeStarted) {
          receipt.nativeCleanupConfirmation = await nativeConfirmedEnded()
          assert.equal(receipt.nativeCleanupConfirmation.stopped, true, 'Actual private Native Runtime still has running Runs')
          if (modelOwnerStarted) await preservePrivateArtifacts(receipt.nativeCleanupConfirmation)
        }
        if (modelOwnerStarted && receipt.owner?.cleanup?.exactPrivateRunsStopped !== true) throw Error('Original private Main Run cleanup is unconfirmed; auth/runtime scope is retained')
        await scope.cleanup()
        for (const key of Object.keys(process.env)) delete process.env[key]
        Object.assign(process.env, originalEnvironment)
      } catch (error) { errors.push(error.message) }
    }
    for (const [file, sha256] of Object.entries(receipt.harnessSource)) {
      if (hash(await readFile(join(repositoryRoot, file))) !== sha256) errors.push('Harness changed: ' + file)
      receipt.source[file] = sha256
    }
    receipt.sourceOrigins = Object.fromEntries(Object.keys(receipt.source).map(file => [file, file in receipt.harnessSource ? 'candidate-harness' : mainRef]))
    receipt.cleanup = { errors, authCopyRemoved: !!scope && !errors.length, privateRuntimeRemoved: !!scope && !errors.length,
      preparedSourceRemoved: false, noRuntimeStarted: !nativeStarted }
    if (!errors.length) { await rm(buildRoot, { recursive: true, force: true }); receipt.cleanup.preparedSourceRemoved = true }
    if (errors.length) receipt.passed = false
    await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2))
    console.log(JSON.stringify({ status: receipt.status, passed: receipt.passed, sourcePrepared: receipt.sourcePreparation?.passed === true,
      modelTurns: receipt.modelTurns, sourcePinnedMain: mainRef, evidence, error: receipt.error, cleanup: receipt.cleanup }))
  }
  if (prepareOnly) assert.equal(receipt.sourcePreparation?.passed, true, receipt.error?.message)
  else assert.equal(receipt.passed, true, receipt.error?.message ?? receipt.cleanup.errors.join('\n'))
  return receipt
}
