import assert from 'node:assert/strict'
import { mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { candidateHash as hash, fingerprintSources, nativeCandidateSources, compileNativeCandidate, runCandidateProgram } from './lib/native-candidate.mjs'

const root = resolve(import.meta.dirname, '../../..'), mode = process.argv[2]
assert.ok(['native', 'surface', 'integration'].includes(mode), 'Choose native, surface or integration.')
const evidence = join(root, '.bagakit/model-state-sync-repair/verification', mode)
const candidate = join(root, '.local/model-state-sync/candidate'), config = 'packages/core/test/model-state-gate.config.mts'
await mkdir(evidence, { recursive: true })
const read = path => readFile(join(root, path))
const { sources, inputs } = await nativeCandidateSources(root), before = { ...inputs }
const { modelStateTests: collections, modelStateDependencies, modelStateMutations, modelStateMutationSets } = await import('../test/model-state-gate.config.mts')
const tests = collections[mode], mutations = modelStateMutationSets[mode]
assert.ok(tests.length && tests.every(path => typeof path === 'string' && !path.includes('*')), 'Name exact nonempty behavior files.')
assert.ok(mutations.length, 'A completed implementation gate requires actual behavior mutants.')
for (const path of [config, 'packages/core/scripts/verify-model-state-sync.mjs', ...modelStateDependencies, ...tests]) before[path] = hash(await read(path))
Object.assign(before, await fingerprintSources(root, 'apps/desktop/src/main'), await fingerprintSources(root, 'apps/desktop/src/shared'), await fingerprintSources(root, 'apps/host/src'))
if (mode !== 'native') Object.assign(before, await fingerprintSources(root, 'apps/desktop/src'), await fingerprintSources(root, 'packages/client-ui/src'))
const compiled = await compileNativeCandidate(root, candidate, evidence, inputs)
process.stdout.write(JSON.stringify({ mode, compiled: 'ready', reused: compiled.reused }) + '\n')
const oldActorDirectory = '.bagakit/model-state-sync-repair/verification/old-actor-direct-binary/'
const oldActorFiles = ['packages/core/test/codex-information-native.test.ts', 'packages/core/test/fixtures/codex-information-native-owner.mjs',
  'packages/core/test/fixtures/agent-information-loader.mjs', 'packages/core/test/fixtures/model-state-native-trace.mjs',
  'packages/core/test/helpers/object-cli-rpc.ts', 'packages/core/test/helpers/fixture-values.ts',
  'packages/core/test/agent-information-gate.config.mts', relative(root, join(candidate, 'compiled.json'))]
const proofFiles = {}
async function readOldActorProof() {
  const oldInputs = JSON.parse(await read(oldActorDirectory + 'inputs.json'))
  assert.equal(oldInputs.candidateGeneration, compiled.receipt.digest, 'The original old-capability proof must use this exact candidate.')
  for (const file of oldActorFiles) assert.ok(oldInputs.inputs.some(input => input.file === file), 'The old-capability proof omits its real input: ' + file)
  for (const { file, sha256 } of oldInputs.inputs) {
    assert.equal(hash(await read(file)), sha256, 'The old-capability proof source or fixture changed: ' + file)
  }
  const oldArtifacts = {}
  for (const name of ['inputs.json', 'report.json', 'receipt.json', 'compiled-loaded.jsonl', 'native-rpc.jsonl', 'run.log']) {
    const path = oldActorDirectory + name, body = await read(path)
    oldArtifacts[name] = { path, sha256: hash(body) }
  }
  const oldReport = JSON.parse(await read(oldActorDirectory + 'report.json'))
  assert.equal(oldReport.numPassedTests, 1); assert.equal(oldReport.numFailedTests, 0); assert.equal(oldReport.numPendingTests, 0)
  assert.ok(oldReport.testResults.flatMap(file => file.assertionResults).some(test => test.status === 'passed' &&
    test.fullName === 'installed Codex old-capability actor reaches independent public information and model-control CLI without a model request'))
  const oldActor = JSON.parse(await read(oldActorDirectory + 'receipt.json'))
  assert.ok(oldActor.version.trim()); assert.equal(oldActor.actor.configurationObservationDeclared, false)
  assert.equal(oldActor.configuration.snapshot.observation.issue.code, 'AGENT_CONFIGURATION_OBSERVATION_UNSUPPORTED')
  assert.equal(oldActor.configuration.snapshot.observation.nativeSessionId, oldActor.nativeId)
  assert.equal(oldActor.receipt.outcome, 'applied')
  assert.deepEqual(oldActor.input.target.expectedRun, oldActor.receipt.target.expectedRun)
  assert.equal(oldActor.stats.runtimeWrites, 0); assert.equal(oldActor.stats.turnEvents, 0); assert.equal(oldActor.stats.network.filter(request => request.method !== 'GET').length, 0)
  assert.equal(oldActor.nativeRequestCounts['thread/settings/update'], 1); assert.equal(oldActor.nativeRequestCounts['turn/start'] ?? 0, 0)
  for (const key of ['nativeExited', 'nativeProcessGone', 'nativeBackendGone', 'configUnchanged', 'rootRemoved']) assert.equal(oldActor.cleanup[key], true)
  assert.equal(oldActor.cleanup.modelHttpRequests, 0); assert.equal(oldActor.cleanup.networkConnections, 0)
  const oldModules = (await read(oldActorDirectory + 'compiled-loaded.jsonl')).toString().trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.ok(oldModules.length, 'The old-capability proof must record its actual compiled consumers.')
  for (const input of oldModules) assert.equal(input.originalSHA256, compiled.compiled[input.path], 'The old-capability proof loaded a different compiled module: ' + input.path)
  for (const path of ['core/dist/client.js', 'core/dist/providers/codex-configuration.js', 'core/dist/agentmux.js'])
    assert.ok(oldModules.some(input => input.path === path), 'The old-capability actor must reach its actual public consumer: ' + path)
  return { inputs: oldInputs.inputs, proof: oldActor, summary: { candidateDigest: oldInputs.candidateGeneration, artifacts: oldArtifacts,
    version: oldActor.version, command: oldActor.command, launcher: oldActor.launcher, nativeBinary: oldActor.nativeBinary,
    ...(oldActor.fingerprintIssues?.length ? { fingerprintIssues: oldActor.fingerprintIssues } : {}), actor: oldActor.actor, nativeSessionId: oldActor.nativeId, nativeRuntimeSessionId: oldActor.nativeRuntimeSessionId,
    originalTarget: oldActor.input.target, outcome: oldActor.receipt.outcome, modelHttpRequests: 0, turnStarts: 0,
    reason: 'This independent old-capability native actor keeps read/set without continuous observation; its exact proof is consumed once, without a duplicate vendor scene.' } }
}

async function fileDigest(path) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('hex')
}
async function sameOldActorInstallation(proof) {
  if (proof.fingerprintIssues?.length || !proof.launcher?.sha256 || !proof.nativeBinary?.sha256) return false
  const command = process.env.AGENTMUX_TEST_CODEX_BINARY ?? 'codex'
  if (proof.command !== command) return false
  const resolved = isAbsolute(command) || command.includes('/') ? resolve(root, command)
    : (await runCandidateProgram(root, 'which', [command])).stdout.trim()
  const executable = await realpath(resolved)
  if (executable !== proof.launcher.executable || await fileDigest(executable) !== proof.launcher.sha256) return false
  const original = await stat(proof.nativeBinary.executable, { bigint: true })
  if (String(original.dev) !== proof.nativeBinary.device || String(original.ino) !== proof.nativeBinary.inode ||
      await fileDigest(proof.nativeBinary.executable) !== proof.nativeBinary.sha256) return false
  const checked = await stat(proof.nativeBinary.executable, { bigint: true })
  if (checked.dev !== original.dev || checked.ino !== original.ino || checked.mtimeNs !== original.mtimeNs || checked.ctimeNs !== original.ctimeNs) return false
  const directory = join(root, '.local/model-state-sync/version-home')
  await mkdir(directory, { recursive: true })
  try {
    const version = await runCandidateProgram(root, command, ['--version'], { HOME: directory, CODEX_HOME: directory }, 10000)
    return version.code === 0 && version.stdout.trim() === proof.version
  } finally { await rm(directory, { recursive: true, force: true }) }
}
let consumedOldActorProof
if (mode !== 'surface') {
  let prior, cacheReason
  try {
    prior = await readOldActorProof()
    if (!await sameOldActorInstallation(prior.proof)) { cacheReason = 'The actual native installation fingerprint is absent or changed.'; prior = undefined }
  } catch (error) { cacheReason = String(error); prior = undefined }
  const reused = Boolean(prior)
  if (!prior) {
    const directory = join(root, oldActorDirectory)
    const names = ['inputs.json', 'inputs-after.json', 'report.json', 'run.log', 'receipt.json', 'compiled-loaded.jsonl', 'native-rpc.jsonl']
    const archive = directory.replace(/\/$/u, '') + '-prior-' + randomUUID()
    let archived = false
    for (const name of names) {
      try {
        const body = await readFile(join(directory, name))
        if (!archived) { await mkdir(archive, { recursive: true }); archived = true }
        await writeFile(join(archive, name), body)
      } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    await mkdir(directory, { recursive: true })
    for (const name of names) await rm(join(directory, name), { force: true })
    const inputs = await Promise.all(oldActorFiles.map(async file => ({ file, sha256: hash(await read(file)) })))
    await writeFile(join(directory, 'inputs.json'), JSON.stringify({ candidateGeneration: compiled.receipt.digest, inputs }, null, 2) + '\n')
    for (const name of ['compiled-loaded.jsonl', 'native-rpc.jsonl']) await writeFile(join(directory, name), '')
    const result = await runCandidateProgram(root, process.execPath, ['node_modules/vitest/vitest.mjs', 'run',
      '--config', 'packages/core/test/agent-information-gate.config.mts', '--reporter=json', '--outputFile', join(directory, 'report.json'),
      'packages/core/test/codex-information-native.test.ts'], { AMX_INFORMATION_MODE: 'codex', AMX_INFORMATION_MUTATION: '',
      AMX_INFORMATION_CANDIDATE: candidate, AMX_INFORMATION_COMPILED_LOADED: join(directory, 'compiled-loaded.jsonl'),
      AMX_INFORMATION_COMPILED_EDIT: '', AMX_INFORMATION_NATIVE_EVIDENCE: join(directory, 'receipt.json'),
      AMX_MODEL_SYNC_MUTATION: '', AMX_MODEL_SYNC_NATIVE_TRACE: join(directory, 'native-rpc.jsonl') }, 90000)
    await writeFile(join(directory, 'run.log'), result.stdout + result.stderr)
    assert.equal(result.code, 0, 'The fresh original old-capability actor must pass; no native failure is retried. See old-actor-direct-binary/run.log.')
    prior = await readOldActorProof()
    prior.summary.reusable = await sameOldActorInstallation(prior.proof).catch(() => false)
  }
  for (const input of prior.inputs) before[input.file] = input.sha256
  for (const entry of Object.values(prior.summary.artifacts)) proofFiles[entry.path] = entry.sha256
  consumedOldActorProof = { ...prior.summary, reused, ...(cacheReason ? { cacheReason } : {}), reusable: reused || prior.summary.reusable === true }
  process.stdout.write(JSON.stringify({ mode, oldActorProof: reused ? 'reused' : 'fresh', reusable: consumedOldActorProof.reusable }) + '\n')
}
let consumedNativeProof
if (mode === 'integration') {
  const path = '.bagakit/model-state-sync-repair/verification/native/qualification.json'
  const original = await read(path), prior = JSON.parse(original)
  assert.equal(prior.passed, true, 'The omitted duplicate native scene requires a qualified T1 proof.')
  assert.equal(prior.compiled.digest, compiled.receipt.digest, 'The original native proof must use this candidate generation.')
  assert.ok(prior.baseline.files.includes('packages/core/test/codex-model-state-sync-native.test.ts'))
  for (const [file, sha] of Object.entries(prior.inputs)) assert.equal(hash(await read(file)), sha,
    'The consumed native proof no longer matches its source or fixture: ' + file)
  const productPath = '.bagakit/model-state-sync-repair/verification/native/baseline-native-product.json'
  const product = await read(productPath), facts = JSON.parse(product)
  assert.equal(facts.phase, 'passed'); assert.equal(facts.cleanup, true)
  consumedNativeProof = { path, sha256: hash(original), compiledDigest: prior.compiled.digest,
    product: { path: productPath, sha256: hash(product), version: facts.version, nativeBinary: facts.nativeBinary },
    reason: 'The integration native scene is the same physical TUI, Main and mounted Composer; T1 retains the separate compiled CLI proof.' }
}

async function execute(label, mutation) {
  const edit = mutation ? modelStateMutations[mutation] : undefined
  assert.ok(!mutation || edit, 'An actual implementation mutant is required: ' + mutation)
  const selected = edit?.tests ?? (label === 'restored' ? [...new Set(mutations.flatMap(name => modelStateMutations[name].tests))] : tests)
  assert.ok(selected.length, 'The selected behavior tests must be nonempty.')
  const log = join(evidence, label + '.loaded.jsonl'), modules = join(evidence, label + '.compiled-loaded.jsonl')
  const wire = join(evidence, label + '.native-rpc.jsonl')
  for (const path of [log, modules, wire]) await writeFile(path, '')
  const acp = 'packages/core/test/provider-acp-actor.integration.test.ts'
  const batches = [
    { renderer: false, suffix: '-node', files: selected.filter(path => !path.endsWith('.tsx') && path !== acp) },
    { renderer: false, suffix: '-acp', files: selected.filter(path => path === acp),
      name: 'opens and rejoins one ACP Session, then awaits an exact resume before binding a replacement Run', candidateLoader: true },
    { renderer: true, suffix: '-renderer', files: selected.filter(path => path.endsWith('.tsx')) }
  ].filter(batch => batch.files.length)
  const reports = [], results = []
  let nativeRendererConsumer, nativeProduct
  for (const batch of batches) {
    const output = join(evidence, label + batch.suffix + '.json')
    results.push(await runCandidateProgram(root, process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', config,
      '--reporter=json', '--outputFile', output, ...batch.files, ...(edit?.name || batch.name ? ['-t', edit?.name ?? batch.name] : [])], {
      ...(batch.candidateLoader ? { NODE_OPTIONS: '--import=' + join(root, 'packages/core/test/fixtures/agent-information-loader.mjs') } : {}),
      AMX_MODEL_SYNC_MODE: mode, AMX_MODEL_SYNC_RENDERER: batch.renderer ? '1' : '',
      AMX_MODEL_STATE_NATIVE_UI: mode === 'integration' && batch.renderer ? '1' : '',
      AMX_MODEL_SYNC_NATIVE_EVIDENCE: join(evidence, label + '-native-product.json'),
      AMX_MODEL_SYNC_NATIVE_RENDERER_EVIDENCE: join(evidence, label + '-native-renderer.json'), AMX_MODEL_SYNC_MUTATION: mutation ?? '',
      AMX_MODEL_SYNC_LOADED: log, AMX_MODEL_SYNC_NATIVE_TRACE: wire, AMX_MODEL_SYNC_NODE_EDIT: edit ? JSON.stringify({ ...edit, mutation }) : '', AMX_INFORMATION_CANDIDATE: candidate,
      AMX_INFORMATION_COMPILED_LOADED: modules, AMX_INFORMATION_COMPILED_EDIT: edit?.compiled ? JSON.stringify({ ...edit.compiled, mutation }) : '',
      AGENTMUX_TEST_RPC_CORE_ENTRY: '', AGENTMUX_TEST_OBJECT_CLI: join(candidate, 'core/bin/amux')
    }, 180000))
    reports.push(JSON.parse(await readFile(output, 'utf8')))
    const nativeTitle = 'the same physical native TUI and original Core Session converge in both directions through the actual Composer'
    if (mode === 'integration' && batch.renderer && (!edit || edit.name === nativeTitle)) {
      const path = join(evidence, label + '-native-renderer.json'), body = await readFile(path), proof = JSON.parse(body)
      assert.equal(proof.schema, 'agentmux.model-state-native-renderer.v1')
      assert.equal(proof.candidate.digest, compiled.receipt.digest, 'The native Renderer must use this exact generation.')
      assert.equal(proof.cleanup.exitCode, 0); assert.equal(proof.cleanup.directoryRemoved, true)
      if (mutation === 'native-producer-detached') {
        assert.equal(proof.phase, 'failed')
        const missing = proof.failureState?.stats?.proof?.missingNativeConfigurationPublication
        assert.ok(missing?.nativeModel, 'The real native change must be established before rejecting a disconnected producer.')
        assert.notEqual(missing.nativeModel, missing.core?.options.find(option => option.category === 'model')?.currentValue)
      } else {
        assert.equal(proof.phase, 'passed')
        assert.equal(proof.version, consumedNativeProof.product.version, 'The consumed T1 proof must describe this actual vendor version.')
        assert.equal(proof.nativeBinary.sha256, consumedNativeProof.product.nativeBinary.sha256, 'The vendor executable changed after T1 qualification.')
        assert.ok(reports.at(-1).testResults.flatMap(file => file.assertionResults).some(test => test.fullName === nativeTitle && test.status === 'passed'),
          'The same-physical-object native Renderer case must actually run, not skip.')
        assert.equal(proof.identity.agentSessionId, proof.control.agentSessionId)
        assert.deepEqual(proof.identity.run, proof.control.run)
        assert.ok(proof.identity.actorId && proof.identity.nativeRuntimeSessionId)
        assert.equal(proof.coreEventToComposer.nativeObservation.nativeSessionId, proof.identity.nativeSessionId)
        assert.equal(proof.coreEventToComposer.nativeModel, proof.coreEventToComposer.composerModel)
        const selected = proof.composerToSameTui
        assert.equal(selected.receipt.outcome, 'applied')
        assert.equal(selected.receipt.target.agentSessionId, proof.control.agentSessionId)
        assert.deepEqual(selected.receipt.target.expectedRun, proof.control.run)
        assert.equal(selected.nativeVerification.model, selected.receipt.value)
        assert.equal(selected.composerModel, selected.receipt.value)
        assert.equal(proof.originalThread, proof.identity.nativeSessionId)
        assert.equal(proof.setup.turns, 1); assert.equal(proof.turns.before, 1); assert.equal(proof.turns.after, 1)
        assert.ok(proof.modelHttpRequests.before >= 1); assert.equal(proof.modelHttpRequests.after, proof.modelHttpRequests.before)
        assert.equal(proof.draftPreserved, true)
        assert.equal(proof.uiSetters, 1)
        for (const stage of ['before', 'mounted', 'tuiSelected', 'menu', 'reopened', 'settled']) assert.ok(proof.nativeRequests[stage])
      }
      nativeRendererConsumer = { path: relative(root, path), sha256: hash(body), phase: proof.phase,
        candidateDigest: proof.candidate.digest, identity: proof.identity }
    }
  }
  await writeFile(join(evidence, label + '.log'), results.map(result => result.stdout + result.stderr).join('\n'))
  const total = reports.reduce((sum, report) => sum + report.numTotalTests, 0), passed = reports.reduce((sum, report) => sum + report.numPassedTests, 0)
  const assertions = reports.flatMap(report => report.testResults).flatMap(file => file.assertionResults)
  const lines = async path => (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(value => JSON.parse(value))
  const loaded = await lines(log), actualModules = await lines(modules)
  assert.ok(total > 0 && loaded.length, 'The behavior collection and actual loaded source must be nonempty.')
  for (const input of loaded) assert.equal(input.originalSHA256, before[input.path], 'The source candidate changed or escaped its worktree: ' + input.path)
  for (const input of actualModules) assert.equal(input.originalSHA256, compiled.compiled[input.path], 'The wrong compiled candidate loaded: ' + input.path)
  if (label === 'baseline' && mode === 'native') {
    const path = join(evidence, label + '-native-product.json'), body = await readFile(path), proof = JSON.parse(body)
    assert.equal(proof.phase, 'passed'); assert.equal(proof.cleanup, true)
    assert.ok(assertions.some(test => test.fullName === 'the installed native TUI and original producer reach actual Core, Main and compiled CLI in both directions without another model turn' && test.status === 'passed'))
    assert.ok(proof.version?.trim()); assert.match(proof.nativeBinary.sha256, /^[0-9a-f]{64}$/u)
    assert.equal(proof.setup.turns, 1); assert.ok(proof.setup.modelHttpRequests >= 1)
    assert.equal(proof.publicCli.originalAgentProjection, true); assert.equal(proof.publicCli.retainedReceipt, true)
    assert.equal(proof.nativeSetterRequestId, proof.setterReceipt.nativeOperationId)
    nativeProduct = { path: relative(root, path), sha256: hash(body), version: proof.version, nativeBinary: proof.nativeBinary,
      identity: proof.identity, setup: proof.setup, modelSceneNativeRequests: proof.modelSceneNativeRequests }
  }
  if (label === 'baseline') {
    assert.ok(actualModules.length, 'The real public consumer must load the compiled candidate.')
    for (const path of ['core/dist/public-rpc-server.js', 'core/dist/public-rpc-client.js', ...(mode === 'surface' ? [] : ['core/dist/agentmux.js'])])
      assert.ok(actualModules.some(input => input.path === path), 'The actual public route must consume: ' + path)
  }
  if (mutation) {
    const applied = [...loaded, ...actualModules].filter(input => input.mutation === mutation && input.sha256 !== input.originalSHA256)
    const failed = assertions.filter(test => test.status === 'failed')
    assert.ok(applied.length, 'The actual mutant implementation must load: ' + mutation)
    assert.ok(results.some(result => result.code !== 0) && failed.some(test => test.failureMessages.some(message =>
      /AssertionError|expected |promise (?:resolved .* instead of rejecting|rejected .* instead of resolving)/u.test(message))), 'A real behavior assertion must reject the mutant: ' + mutation)
    return { mutation, result: 'assertion-red', failed: failed.map(test => test.fullName), implementations: applied, ...(nativeRendererConsumer ? { nativeRendererConsumer } : {}) }
  }
  assert.ok(results.every(result => result.code === 0), 'Candidate behavior failed; see ' + label + '.log.')
  assert.equal(reports.reduce((sum, report) => sum + report.numFailedTests, 0), 0)
  assert.ok(passed > 0, 'Skipped-only results cannot qualify.')
  return { result: 'green', tests: passed, files: reports.flatMap(report => report.testResults.map(file => relative(root, file.name))),
    ...(nativeRendererConsumer ? { nativeRendererConsumer } : {}), ...(nativeProduct ? { nativeProduct } : {}) }
}

const baseline = await execute('baseline'), reds = []
process.stdout.write(JSON.stringify({ mode, baseline }) + '\n')
for (const mutation of mutations) {
  reds.push(await execute('mutation-' + mutation, mutation))
  process.stdout.write(JSON.stringify({ mode, mutation, result: 'assertion-red' }) + '\n')
}
const restored = await execute('restored')
for (const [path, sha] of Object.entries(proofFiles)) assert.equal(hash(await read(path)), sha, 'The consumed proof changed during qualification: ' + path)
for (const [path, sha] of Object.entries(before)) assert.equal(hash(await read(path)), sha, 'Qualification source changed: ' + path)
assert.deepEqual({ ...await fingerprintSources(root, 'packages/core/src'), ...await fingerprintSources(root, 'packages/providers/src') }, sources)
await writeFile(join(evidence, 'qualification.json'), JSON.stringify({ schema: 'agentmux.model-state-sync.v1', mode, passed: true,
  inputs: before, compiled: { ...compiled.receipt, inputs: compiled.compiled }, baseline, mutations: reds, restored,
  ...(consumedOldActorProof ? { consumedOldActorProof } : {}), ...(consumedNativeProof ? { consumedNativeProof } : {}),
  boundary: 'Exact candidate Core/Providers, original native ports and public consumers; rendered visual review is separately attributed. No user Run is operated.' }, null, 2) + '\n')
process.stdout.write(JSON.stringify({ mode, passed: true, qualification: relative(root, join(evidence, 'qualification.json')) }) + '\n')
if (mode === 'integration') await rm(candidate, { recursive: true, force: true })
