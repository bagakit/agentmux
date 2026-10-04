import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join, relative, dirname } from 'node:path'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'

assert.equal(process.argv[process.argv.indexOf('--slice') + 1], 'capability')
const route = process.argv[process.argv.indexOf('--route') + 1]
assert.ok(['stream', 'receiver-tab'].includes(route), 'Explicit reviewed research route')
const repository = resolve(import.meta.dirname, '../../..')
const require = createRequire(join(repository, 'apps/desktop/package.json'))
const motherPath = join(repository, ".tmp/shared-native-presentation-capability/receipt.json")
const mother = JSON.parse(await readFile(motherPath, 'utf8'))
const reviewDirectory = route === 'receiver-tab' ? ".tmp/shared-native-route-candidate-fixture" : ".tmp/shared-native-presentation-alternatives-fixture"
const candidatePath = join(repository, reviewDirectory, route === 'receiver-tab' ? 'proposal.json' : 'probe-candidate.json')
const reviewPath = join(repository, reviewDirectory, route === 'receiver-tab' ? 'root-counter-review.json' : 'root-probe-review.json')
const review = JSON.parse(await readFile(reviewPath, 'utf8'))
const fixture = join(repository, 'apps/desktop/scripts/fixtures/shared-native-presentation-capability')
const evidence = join(repository, '.tmp', ("shared-native-" + (route) + "-capability-" + (globalThis.crypto.randomUUID()) + ""))
const privateRoot = await mkdtemp(join(tmpdir(), 'agentmux-shared-native-stream-'))
await mkdir(evidence, { recursive: true })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const receipt = { schema: 'agentmux.shared-native-stream-research.v1', route, evidence, passed: false,
  capabilitySupported: false, productImplemented: false, T004Qualified: false, userAppRunRuntimeControl: 0,
  installedElectron: require('electron/package.json').version,
  officialReferences: ['https://www.electronjs.org/docs/latest/api/session#sessetdisplaymediarequesthandlerhandler-opts',
    'https://www.electronjs.org/docs/latest/api/web-contents#contentssendinputeventinputevent'],
  originalDirectProbe: { receipt: relative(repository, motherPath), sha256: hash(await readFile(motherPath)),
    capabilitySupported: mother.actual.capabilitySupported },
  rootReview: { path: relative(repository, reviewPath), sha256: hash(await readFile(reviewPath)) },
  compiledNativeOwner: { donor: relative(repository, motherPath), ...mother.compiled,
    scope: 'Exact preserved original donor compiled Browser owner; this capability does not sign moving Main or a complete App build.' } }
const inputs = new Map(), logs = []
try {
  assert.equal(review.approved, true)
  assert.equal(hash(await readFile(candidatePath)), review.candidateSha256)
  assert.equal(mother.passed, true)
  assert.equal(mother.installedElectron, receipt.installedElectron)
  const compiled = join(dirname(motherPath), mother.compiled.file)
  assert.equal(hash(await readFile(compiled)), mother.compiled.sha256)
  receipt.donorSourceHashes = mother.inputs
  receipt.donorCurrentDifferences = []
  for (const [file, prior] of Object.entries(mother.inputs)) {
    const current = hash(await readFile(join(repository, file)))
    if (current !== prior) receipt.donorCurrentDifferences.push({ file, donorSha256: prior, currentSha256: current })
  }
  for (const file of ['main.cjs', 'stream-main.cjs', 'stream-preload.cjs', 'stream.html']) {
    const absolute = join(fixture, file); inputs.set(absolute, hash(await readFile(absolute)))
  }
  const generic = join(repository, 'apps/desktop/scripts/fixtures/mote-shortcut/browser.html')
  assert.equal(hash(await readFile(generic)), mother.inputs[relative(repository, generic)])
  for (const file of [generic, resolve(import.meta.dirname, 'verify-shared-native-presentation.mjs'),
    resolve(import.meta.dirname, 'verify-shared-native-presentation-stream.mjs'),
    resolve(import.meta.dirname, 'probe-process.mjs'), require.resolve('electron/electron.d.ts')]) inputs.set(file, hash(await readFile(file)))
  receipt.inputs = Object.fromEntries([...inputs].map(([p,h]) => [relative(repository,p),h]))
  const env = { ...process.env, AGENTMUX_DESKTOP_USER_DATA: join(privateRoot, 'user-data'),
    AGENTMUX_RUNTIME_DIRECTORY: join(privateRoot, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(privateRoot, 'state') }
  delete env.ELECTRON_RUN_AS_NODE
  receipt.process = await runProbeProcess(require('electron'), [join(fixture, 'stream-main.cjs'), privateRoot, evidence, compiled,
    join(fixture, 'stream-preload.cjs'), generic, join(fixture, 'stream.html'), route], { temporaryRoot: privateRoot, cwd: repository, env,
    timeoutMs: 55000, onLine: line => logs.push(line) })
  receipt.actual = JSON.parse(await readFile(join(evidence, 'actual.json'), 'utf8'))
  receipt.capabilitySupported = receipt.actual.capabilitySupported
  receipt.frames = []
  for (const frame of receipt.actual.frames) receipt.frames.push({ ...frame, sha256: hash(await readFile(join(evidence, frame.file))) })
  receipt.sourceAfter = Object.fromEntries(await Promise.all([...inputs.keys()].map(async path => [relative(repository,path),hash(await readFile(path))])))
  assert.deepEqual(receipt.sourceAfter, receipt.inputs, 'Own exact fixture Source remains fixed')
  assert.equal(receipt.process.timedOut, false)
  assert.equal(receipt.actual.electron, receipt.installedElectron)
  // A genuine inability to capture/paint/input is a research result. Preparation failures stay failures.
  if (receipt.actual.failure) {
    receipt.failure = receipt.actual.failure
    receipt.actualCounterexample = receipt.actual.captureRequests.some(request => request.allowed) || receipt.actual.cases.length > 0
    receipt.captureRequestDenied = receipt.actual.captureRequests.some(request => !request.allowed)
    receipt.captureAttempted = receipt.actual.captureInvocation?.attempted === true
    receipt.scope = receipt.actualCounterexample ? 'Actual capture/pixel route failure; cause and prerequisites remain in raw observations.'
      : 'No source capture grant/pixel observations; preparation or API prerequisite failure, not a proof that live projection is impossible.'
  } else if (route === 'receiver-tab') {
    assert.equal(receipt.process.exitCode, 0)
    assert.equal(receipt.actual.passed, true)
    assert.equal(receipt.actual.capabilitySupported, true)
    assert.equal(receipt.actual.cases.length, 5)
    assert.equal(receipt.actual.captureRequests.length, 0)
    assert.equal(receipt.actual.forwardedInputs.length, 0)
    assert.equal(receipt.actual.nativeActivationCases.length, 2)
    assert.equal(receipt.actual.captureGrant.receiverId, receipt.actual.captureInvocation.consumerWebContentsId)
    assert.ok(receipt.actual.captureGrant.requestDelayMs >= 0 && receipt.actual.captureGrant.requestDelayMs < 10000)
    assert.equal(receipt.actual.handlerTouched, false)
    assert.equal(receipt.actual.stoppedTracks.length, 1)
    assert.equal(receipt.actual.stoppedTracks[0].readyState, 'ended')
    receipt.passed = true
  } else if (receipt.actual.partialResearchCompleted && !receipt.actual.capabilitySupported) {
    assert.equal(receipt.actual.capturePaintSupported, true)
    assert.equal(receipt.actual.cases.length, 3)
    assert.equal(receipt.actual.inputQualification.attempted, false)
    assert.equal(receipt.actual.forwardedInputs.length, 0)
    assert.equal(receipt.actual.stoppedTracks.length, 1)
    assert.equal(receipt.actual.stoppedTracks[0].readyState, 'ended')
    assert.equal(receipt.actual.handlerReset, true)
    receipt.partialFactsQualified = true
    receipt.unqualifiedReason = receipt.actual.inputQualification.reason
  } else {
    assert.equal(receipt.process.exitCode, 0)
    assert.equal(receipt.actual.passed, true)
    assert.equal(receipt.actual.capabilitySupported, true)
    assert.equal(receipt.actual.cases.length, 6)
    assert.equal(receipt.actual.forwardedInputs.length, 6)
    assert.ok(receipt.actual.stoppedTracks.length > 0)
    assert.ok(receipt.actual.stoppedTracks.every(track => track.readyState === 'ended'))
    assert.equal(receipt.actual.handlerReset, true)
    receipt.passed = true
  }
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  await writeFile(join(evidence, 'process.log'), logs.join('\n'))
  const remaining = await listProbeProcesses(-1, privateRoot)
  receipt.cleanup = { remaining, privateRoot, removed: false, compiledDonorPreserved: true, originalProofAndFramesPreserved: true }
  if (remaining.length === 0) { await rm(privateRoot, { recursive: true }); receipt.cleanup.removed = true }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ evidence: relative(repository, evidence), passed: receipt.passed,
    capabilitySupported: receipt.capabilitySupported, actualCases: receipt.actual?.cases.length,
    actualCounterexample: receipt.actualCounterexample, failure: receipt.failure?.message }))
  if (!receipt.passed) process.exitCode = 1
}
