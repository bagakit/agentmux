import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

const directions = ['local-agent', 'remote-agent']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const nonempty = value => value && typeof value === 'object' && Object.keys(value).length > 0
const dist = values => Object.fromEntries(Object.entries(values ?? {}).filter(([file]) => file.startsWith('packages/core/dist/')))
export async function readEvidence(reference) {
  assert(reference && isAbsolute(reference.path) && /^[a-f0-9]{64}$/.test(reference.sha256), 'Exact original evidence path and digest are required')
  const bytes = await readFile(reference.path)
  assert.equal(hash(bytes), reference.sha256, 'Original evidence changed: ' + reference.path)
  return JSON.parse(bytes)
}
export function validateUiInputs(receipt, expected) {
  assert(nonempty(receipt.inputs) && nonempty(expected), 'Original UI build inputs are absent')
  assert.deepEqual(receipt.inputsAfter, receipt.inputs, 'The final isolated UI candidate changed during execution')
  for (const prefix of ['apps/desktop/src/main/', 'apps/desktop/src/renderer/', 'apps/host/src/', 'packages/client-ui/']) {
    assert(Object.keys(receipt.inputs).some(file => file.startsWith(prefix)), 'Missing real UI consumer inputs: ' + prefix)
  }
  for (const [file, digest] of Object.entries(receipt.inputs)) assert(digest && digest === expected[file], 'UI source or dependency differs from the archived/built candidate: ' + file)
  assert(nonempty(receipt.builtInputs), 'Actual UI compilation artifacts are absent')
  assert(nonempty(receipt.tools) && receipt.tools.electron?.sha256, 'The original Electron executable is absent')
  assert.deepEqual(receipt.toolsAfter, receipt.tools, 'The UI executable changed during execution')
}
export function validateUi(receipt, candidate, expectedDist) {
  assert.equal(receipt.schema, 'agentmux.space-agent-cli.native.v1')
  assert(receipt.passed === true && receipt.actualMachines === 2 && directions.includes(receipt.direction), 'A real two-machine UI direction is required')
  const roles = receipt.direction === 'remote-agent' ? { agentHostId: 'agent', resourceHostId: 'local' } : { agentHostId: 'local', resourceHostId: 'agent' }
  assert.deepEqual(receipt.roles, roles, 'UI roles must reflect the actual execution direction')
  const lease = receipt.remoteLease
  assert.equal(lease?.sourceCommit, candidate.sourceCommit, 'UI used a different candidate')
  for (const key of ['transport', 'host', 'user', 'port', 'identityFile']) assert.equal(lease.endpoint?.[key], candidate.remote.endpoint[key], 'UI used a different SSH route')
  assert.equal(lease.endpoint?.transport, 'ssh')
  assert(lease.ownsNewScopeOnly === true && lease.installedPackageReadOnly === true && lease.base.startsWith(candidate.remote.installedRoot + '/ui-'), 'UI must own only its isolated remote scope')
  assert(nonempty(expectedDist), 'The original Core build must identify its complete dist')
  assert.deepEqual(dist(receipt.coreConsumption?.hashes), expectedDist, 'UI local Core differs from the qualified build')
  assert.deepEqual(Object.fromEntries(Object.entries(lease.coreHashes ?? {}).filter(([file]) => file.startsWith('dist/')).map(([file, digest]) => ['packages/core/' + file, digest])), expectedDist, 'UI remote Core differs from the qualified build')
  assert.deepEqual(receipt.phases?.map(phase => phase.phase), ['tool-workspace', 'tool-workspace-restore'])
  const [first, second] = receipt.phases
  for (const phase of receipt.phases) assert(phase.native?.passed === true && phase.exit?.exitCode === 0 && phase.exit.exitSignal === null && phase.exit.exitConfirmed === true && phase.exit.timedOut === false, 'Both original Electron processes must close successfully')
  const seed = first.native.restartSeed, restored = second.native.toolRestart
  assert.deepEqual(receipt.toolRestart, restored, 'Top-level UI evidence must identify the original restored phase')
  assert(seed && restored && first.native.pid === seed.pid && second.native.pid === restored.currentElectronPid && seed.pid !== restored.currentElectronPid && restored.originalElectronPid === seed.pid, 'Two real Electron generations are required')
  assert.equal(restored.originalSessionId, seed.original?.agentSessionId)
  assert.equal(restored.originalRunId, seed.original?.run?.runId)
  assert.equal(restored.bindingId, seed.bindingId)
  assert(restored.originalSessionId && restored.originalRunId && restored.bindingId, 'Original durable execution identities are absent')
  assert(restored.noCreateOrResume === true && restored.originalTerminalAttached === true &&
    restored.continuity?.some(value => value.reply?.kind === 'reattachable' && value.reply.session?.id === restored.originalSessionId && value.request?.[0]?.run?.runId === restored.originalRunId), 'The existing healthy Run must reattach without a replacement')
  for (const key of ['agentSessionId', 'run', 'creation', 'toolExecution']) assert.deepEqual(restored.original?.[key], seed.original[key], 'Original Session fact changed: ' + key)
  for (const key of ['nativeRuns', 'durable', 'graph', 'agentComposerDrafts', 'launcherNameDrafts', 'launcherSurface']) {
    assert(nonempty(seed[key]), 'Original UI fact is absent: ' + key)
    assert.deepEqual(restored[key], seed[key], 'Original UI fact changed: ' + key)
  }
  assert(nonempty(seed.durable.tabs) && seed.nativeRuns.agent?.length > 0 && seed.nativeRuns.resource?.length > 0)
  const opened = receipt.toolBinding?.opened?.agent
  assert(opened && opened.hostId === roles.agentHostId && opened.toolExecution?.resourceHostId === roles.resourceHostId && opened.agentSessionId === restored.originalSessionId && opened.runId === restored.originalRunId, 'Original CLI receipt must agree with the two physical roles')
  assert(receipt.cleanup?.errors?.length === 0 && receipt.cleanup.remaining?.length === 0, 'UI cleanup is unconfirmed')
}
export function validateRemote(summary, mode, commit) {
  assert(summary.passed === true && summary.mode === mode && summary.actualMachines === 2 && summary.bothDirectionsPassed === true && summary.cleanupErrors?.length === 0, 'Both real directions and cleanup must pass')
  assert.equal(summary.candidateCommit, commit, 'Remote result belongs to a different candidate')
  assert.deepEqual(summary.results?.map(result => result.name).sort(), directions, 'One direction cannot substitute for the other')
  for (const result of summary.results) {
    const q = result.qualification
    assert(q, 'The mode-specific original evidence is absent')
    if (mode === 'reader-gap') {
      assert(result.bindingId && result.agentSessionId && result.originalEffectCount === 1 && result.resumeEffectCount === 1 && result.longEffectCount === 1 && result.contextRetained === true)
      assert(q.bothCoreRestarts?.length === 2 && new Set(q.bothCoreRestarts.map(value => value.host)).size === 2 &&
        q.bothCoreRestarts.every(value => Number.isInteger(value.previousPid) && Number.isInteger(value.currentPid) && value.previousPid !== value.currentPid && value.runtimeId && value.nativePid), 'Both original Core processes must restart')
      assert.deepEqual(q.bothCoreRestarts.map(value => value.host).sort(), ['local', 'remote'])
      const path = result.samePathIsolation
      assert(path && isAbsolute(path.requestedAbsolutePath) && path.agentUnchanged === true && path.agentOriginal === path.agentFinal && path.resourceOriginal !== path.agentOriginal && path.resourceAfter === 'modified\n' && path.resourceAfterCut === 'after-cut\n', 'Both physical Hosts must prove exact same-path isolation')
      const amux = q.amux
      assert(amux?.originalSessionId === result.agentSessionId && amux.resumedSessionId === result.agentSessionId && amux.deviceRejected === true && amux.missingCallerRejected === true && amux.ownerUnavailableCode === 'AGENT_TOOL_CONTEXT_UNAVAILABLE' && amux.nativeToolsRetained === true, 'Real tool-side original Agent control must be qualified')
      assert.deepEqual(amux.originalRun, result.originalRun); assert.deepEqual(amux.resumedRun, result.resumedRun)
      const gap = q.readerGap
      assert(gap?.originalRequest?.bindingId === result.bindingId && gap.originalRequest.streamGeneration && gap.originalRequest.nativeRequestId !== undefined &&
        gap.originalRange?.endByte > gap.originalRange?.startByte && gap.acknowledgedByte <= gap.originalRange.startByte &&
        Number.isInteger(gap.pausedPid) && typeof gap.kernelState === 'string' && gap.kernelState.includes('T') &&
        /^[a-f0-9]{64}$/.test(gap.payloadDigest) && /^[a-f0-9]{64}$/.test(gap.resultDigest) && gap.effectCount === 1 && gap.originalStartCount === 1,
      'The original output range must remain beyond the stopped reader without repeating the operation')
    } else {
      assert.equal(mode, 'performance')
      assert(q.independentBindings === 2 && ['unchangedHelpers', 'oneInitializationPerBinding', 'exactFileAndOutputBytes',
        'healthyRequestsDuringProducer', 'noNewIdleNativeRequests', 'noNewIdleProcesses'].every(key => q[key] === true), 'Measured performance isolation invariants must pass')
      assert(result.bindings?.length === 2 && new Set(result.bindings.map(value => value.bindingId)).size === 2 && result.bindings.every(value =>
        value.agentSessionId && value.nativeHandle && value.initializeCount === 1 && value.protocolRequestBytes > 0 && value.protocolOutputBytes > 0 && value.samples?.length > 0), 'Both independent native consumers must be measured')
      assert(result.file?.bytes === 1024 * 1024 && /^[a-f0-9]{64}$/.test(result.file.sha256) && result.file.roundtripMs > 0)
      assert(result.bindings.some(value => [['output-1mib', 1], ['slow-output', 4]].every(([label, size]) =>
        value.outputs?.some(output => output.label === label && output.bytes === size * 1024 * 1024 && output.roundtripMs > 0 && /^[a-f0-9]{64}$/.test(output.sha256)))), 'Both exact original output workloads must be measured')
      assert(result.idle?.durationMs >= 10_000 && result.idle.samples?.length === 2 && result.idle.samples.every(value => value.intervalMs > 0 && Number.isFinite(value.cpuSeconds) && value.rssKiB > 0))
      assert(Number.isFinite(result.medianLatencyRatio) && result.medianLatencyRatio > 0 && result.network?.syntheticLatency === false)
    }
  }
}
async function coreEvidence(candidate, buildReceipt) {
  const provenance = JSON.parse(await readFile(candidate.buildReceipt, 'utf8'))
  assert.equal(provenance.sourceCommit, candidate.sourceCommit)
  const gate = provenance.owningCoreGate
  const report = await readEvidence({ path: gate?.report, sha256: gate?.reportSha256 })
  const compiled = await readEvidence({ path: gate?.candidate, sha256: gate?.candidateSha256 })
  assert(report.passed === true && report.candidate === gate.candidate && compiled.exitCode === 0, 'The original Core gate has not passed')
  const expectedDist = dist(buildReceipt.compiledHashes)
  assert(nonempty(expectedDist)); assert.deepEqual(dist(compiled.consumed), expectedDist)
  assert(nonempty(provenance.sourceHashes), 'The original source archive file identities are absent')
  const uiDependencies = await readEvidence(provenance.uiDependencies)
  assert.equal(uiDependencies.sourceCommit, candidate.sourceCommit)
  assert.equal(uiDependencies.coreCandidateSha256, gate.candidateSha256)
  assert(nonempty(uiDependencies.compiledHashes), 'The UI dependency build identities are absent')
  const baseline = JSON.parse(await readFile(report.tests.evidence, 'utf8'))
  assert(baseline.success === true && baseline.numTotalTests > 0 && baseline.numPassedTests === baseline.numTotalTests && baseline.numPassedTests === report.tests.count)
  for (const name of ['agent-execution-bridge-native', 'client-event-publisher', 'agent-execution-coordinator']) {
    const file = baseline.testResults.find(value => value.name.endsWith('/packages/core/test/' + name + '.test.ts'))
    assert(file?.assertionResults?.length > 0 && file.assertionResults.every(value => value.status === 'passed'), 'Required local semantic consumer was not executed: ' + name)
  }
  assert(report.mutations?.length === 7 && report.mutations.every(value => value.killed === true) && report.inputMutations?.passed === true && report.relayMutations?.passed === true, 'Core mutations are incomplete')
  assert(report.native?.length === 3 && report.native.every(value => value.receipt && value.cleanup), 'Core native consumers are incomplete')
  return { expectedDist, expectedInputs: { ...provenance.sourceHashes, ...provenance.compiledHashes, ...uiDependencies.compiledHashes },
    references: { report: gate.report, sha256: gate.reportSha256, candidate: gate.candidate, candidateSha256: gate.candidateSha256,
    uiDependencies: provenance.uiDependencies,
    baseline: { path: report.tests.evidence, sha256: hash(await readFile(report.tests.evidence)) },
    scope: 'One physical machine: original Input ACK loss and restart, exact-related-consumer cost, native identity and permission semantics. This is not a remote strictly-dispatched fault experiment.' } }
}
async function runMode(verifierPath, receiptPath, mode, root) {
  const child = spawn(process.execPath, [verifierPath, '--receipt', receiptPath, '--mode', mode, '--direction', 'both'], { stdio: ['ignore', 'pipe', 'pipe'] })
  const out = [], err = []
  child.stdout.on('data', bytes => out.push(bytes)); child.stderr.on('data', bytes => err.push(bytes))
  const result = await new Promise((done, reject) => { child.once('error', reject); child.once('close', (code, signal) => done({ code, signal })) })
  const stdout = Buffer.concat(out).toString()
  await writeFile(join(root, mode + '.log'), stdout + Buffer.concat(err).toString(), { mode: 0o600 })
  assert(result.code === 0 && result.signal === null, 'Original remote mode failed; inspect its retained evidence: ' + mode)
  const packets = stdout.split('\n').flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
  assert(packets.length === 1 && packets[0].passed === true && isAbsolute(packets[0].evidence), 'Remote mode must return its exact original evidence')
  return { ...result, ...packets[0] }
}
export async function runComplete({ authorization, receiptPath, candidate, buildReceipt, verifierPath, preflight }) {
  const root = await mkdtemp(join(tmpdir(), 'amx-complete-'))
  const summary = { schema: 'agentmux.cross-host-complete.v1', passed: false, fullRemoteGatePassed: false,
    candidateCommit: candidate.sourceCommit, actualMachines: 2, modes: [], ui: [], limitations: [
      'Hooks and Skills remain explicitly unqualified; MCP is outside the native execution transport.',
      'fsync is unknown where the original Host has no qualified observation; no latency SLA is inferred from samples.',
      'Old native generations and their handles are retained until their original lifetime is known; no automatic background process termination.',
    ] }
  const save = () => writeFile(join(root, 'summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 })
  const initial = hash(await readFile(receiptPath))
  await save()
  try {
    assert(preflight.installationQualification.bin === 'verified' && preflight.installationQualification.vendor === 'verified', 'Complete installed-artifact qualification is required')
    const core = await coreEvidence(candidate, buildReceipt); summary.localSemantics = core.references
    const refs = authorization.executionQualification?.ui
    assert(Array.isArray(refs) && refs.length === 2 && new Set(refs.map(value => value.direction)).size === 2, 'Two exact original UI direction receipts are required')
    for (const ref of refs) {
      const receipt = await readEvidence({ path: ref.receipt, sha256: ref.sha256 })
      assert.equal(receipt.direction, ref.direction); validateUi(receipt, candidate, core.expectedDist)
      validateUiInputs(receipt, core.expectedInputs)
      if (receipt.rendererReuse) {
        assert.equal(receipt.rendererReuse.qualification, 'all-inputs', 'A reused Renderer must bind every original input')
        const previous = await readEvidence({ path: receipt.rendererReuse.receipt, sha256: receipt.rendererReuse.receiptSha256 })
        assert(previous.passed === true)
        assert.deepEqual(previous.inputs, receipt.inputs, 'Reused Renderer was compiled from a different candidate')
        const renderer = value => Object.fromEntries(Object.entries(value.builtInputs ?? {}).filter(([file]) => file.startsWith('renderer/')))
        assert(nonempty(renderer(previous))); assert.deepEqual(renderer(previous), renderer(receipt))
      }
      const evidence = {}
      for (const name of ['cleanup.json', 'remote-owner-lease.json', 'remote-owner-cleanup.json']) evidence[name] = await readEvidence(receipt.evidenceFiles?.[name])
      const cleanup = evidence['cleanup.json'], remote = evidence['remote-owner-cleanup.json']
      assert(cleanup.passed === true && cleanup.errors?.length === 0 && cleanup.records?.length > 0)
      assert.deepEqual(evidence['remote-owner-lease.json'], receipt.remoteLease)
      assert(remote.scope === receipt.remoteLease.scope && remote.base === receipt.remoteLease.base && remote.reply?.stopped === true && remote.reply.errors?.length === 0 && remote.exit?.code === 0 && remote.exit.signal === null, 'Original remote UI owner cleanup is unconfirmed')
      summary.ui.push({ ...ref, originalSessionId: receipt.toolRestart.originalSessionId, evidenceFiles: receipt.evidenceFiles })
    }
    await save()
    for (const mode of ['reader-gap', 'performance']) {
      const result = await runMode(verifierPath, receiptPath, mode, root)
      const path = join(result.evidence, 'summary.json'), bytes = await readFile(path), proof = JSON.parse(bytes)
      validateRemote(proof, mode, candidate.sourceCommit)
      summary.modes.push({ mode, path, sha256: hash(bytes), process: { code: result.code, signal: result.signal } }); await save()
    }
    assert.equal(hash(await readFile(receiptPath)), initial, 'Original target/candidate receipt changed during verification')
    for (const ref of summary.ui) await readEvidence({ path: ref.receipt, sha256: ref.sha256 })
    summary.passed = true; summary.fullRemoteGatePassed = true; await save()
    console.log(JSON.stringify({ passed: true, fullRemoteGatePassed: true, actualMachines: 2, evidence: root }))
    return summary
  } catch (error) { summary.failure = String(error); await save(); throw new Error('Complete remote qualification failed; original evidence: ' + root, { cause: error }) }
}
