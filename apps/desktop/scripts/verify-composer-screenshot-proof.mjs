import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '../../..')
const evidence = 'docs/reviews/evidence/messagetool-screenshot-p0-2026-10-02'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const read = file => readFile(path.resolve(root, file))
const json = async file => JSON.parse(await read(file))
const sourceFiles = [
  'apps/desktop/src/main/composer-screenshot.ts',
  'apps/desktop/src/renderer/src/components/NewTabSurface.tsx',
  'apps/desktop/src/renderer/src/components/ComposerFeedback.tsx'
]
const testFiles = ['composer-screenshot.test.ts', 'composer-local-feedback.test.tsx', 'composer-paste-selection.test.tsx']

async function verifyInputs(inputs) {
  for (const file of sourceFiles) assert.ok(inputs[file], `Missing owning input: ${file}`)
  for (const [file, digest] of Object.entries(inputs)) {
    assert.equal(hash(await read(file)), digest, `Proof no longer matches input: ${file}`)
  }
}

function callers(symbol, definition, required) {
  const result = spawnSync('rg', ['-n', '-F', symbol, 'apps/desktop/src', '--glob', '*.ts', '--glob', '*.tsx'], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, `No production use of ${symbol}: ${result.stderr}`)
  const found = result.stdout.split('\n').filter(line => line && !line.startsWith(`${definition}:`))
  assert.ok(found.length > 0, `Only the definition uses ${symbol}`)
  for (const file of required) assert.ok(found.some(line => line.startsWith(`${file}:`)), `Missing product caller: ${file} → ${symbol}`)
  return found
}

async function source() {
  const receipt = await json(`${evidence}/source-mutations/receipt.json`)
  assert.equal(receipt.passed, true, receipt.failure?.message ?? 'Owning mutation proof did not pass')
  await verifyInputs(receipt.inputs)
  for (const file of testFiles) assert.ok(receipt.inputs[`apps/desktop/test/${file}`], `Missing tested input: ${file}`)
  assert.deepEqual(receipt.restored, receipt.inputs, 'Mutation inputs were not restored byte for byte')
  assert.ok(receipt.cases.length > 0, 'No mutations were exercised')
  const names = new Set(), logs = new Set()
  for (const file of sourceFiles.slice(0, 2)) assert.ok(receipt.cases.some(item => item.file === file), `No owning behavior mutation: ${file}`)
  for (const item of receipt.cases) {
    assert.ok(!names.has(item.name) && !logs.has(item.log), 'Each mutation needs its own name and RED log')
    names.add(item.name); logs.add(item.log)
    assert.ok(Number.isInteger(item.redExit) && item.redExit !== 0, `Mutation survived: ${item.name}`)
    const bytes = await read(item.log)
    assert.equal(hash(bytes), receipt.artifacts[item.log], `Changed mutation original: ${item.name}`)
    const log = bytes.toString()
    assert.match(log, /AssertionError/, `Missing behavioral RED: ${item.name}`)
    assert.match(log, /Tests\s+[1-9]\d* failed/, `Missing executed failing tests: ${item.name}`)
    const source = (await read(item.file)).toString()
    assert.ok(item.mutation.before.length > 0 && item.mutation.before !== item.mutation.after)
    assert.equal(source.split(item.mutation.before).length - 1, 1, `Mutation anchor changed: ${item.name}`)
    assert.equal(hash(source.replace(item.mutation.before, item.mutation.after)), item.mutation.mutatedSha256)
    assert.ok(item.command.includes('vitest') && testFiles.some(file => item.command.includes(file) && log.includes(file)), `No owning test execution: ${item.name}`)
  }
  assert.equal(receipt.green.exit, 0)
  const green = await read(receipt.green.log)
  assert.equal(hash(green), receipt.artifacts[receipt.green.log], 'Changed restored GREEN original')
  assert.match(green.toString(), /Tests\s+[1-9]\d* passed/, 'Missing restored GREEN tests')
  const productCallers = [
    ...callers('captureComposerScreenshot', sourceFiles[0], ['apps/desktop/src/main/ipc.ts']),
    ...callers('captureScreenshot()', 'apps/desktop/src/shared/contracts.ts', [
      'apps/desktop/src/renderer/src/components/NewTabSurface.tsx',
      'apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx'
    ]),
    ...callers('useComposerFeedback', sourceFiles[2], [sourceFiles[1]])
  ]
  console.log(JSON.stringify({ passed: true, scope: 'source-only', mutations: receipt.cases.length, productCallers }))
}

// The installation owner records this receipt from actual Message Tools use. This verifier never
// launches a picker, changes permissions, installs an App, or upgrades a healthy Runtime.
async function device() {
  const file = process.env.AGENTMUX_SCREENSHOT_DEVICE_PROOF ?? `${evidence}/device-proof.json`
  let proof
  try { proof = await json(file) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    throw new Error(`Device qualification is unknown: ${file} is missing. The delivery owner must record the same actual signed App completing captures without repeated system consent; source tests do not qualify it.`)
  }
  assert.equal(proof.schema, 'agentmux.composer-screenshot-device-proof.v1')
  assert.equal(proof.status, 'passed', proof.reason ?? 'Device qualification remains unknown')
  assert.equal(proof.method, 'actual-installed-message-tools', 'An isolated or mock process cannot qualify the installed App')
  await verifyInputs(proof.sourceInputs)
  assert.ok(proof.identity.appPath.endsWith('.app'))
  assert.ok(proof.identity.executablePath.startsWith(`${proof.identity.appPath}/Contents/MacOS/`))
  assert.ok(Number.isInteger(proof.identity.mainPid) && proof.identity.mainPid > 0)
  assert.ok(proof.identity.designatedRequirement && proof.identity.macOS && proof.identity.sourceCommit)
  // Bind package provenance to these owning sources, rather than accepting an old package with
  // hashes copied from a newer checkout.
  for (const [file, digest] of Object.entries(proof.sourceInputs)) {
    const blob = spawnSync('git', ['show', `${proof.identity.sourceCommit}:${file}`], { cwd: root })
    assert.equal(blob.status, 0, `Package source is unavailable: ${file}`)
    assert.equal(hash(blob.stdout), digest, `Package source differs from qualified input: ${file}`)
  }
  assert.ok(proof.artifacts.length > 0, 'No device originals')
  const artifacts = new Map()
  for (const artifact of proof.artifacts) {
    const bytes = await read(artifact.path)
    assert.ok(bytes.length > 0, `Empty device original: ${artifact.path}`)
    assert.equal(hash(bytes), artifact.sha256, `Changed device original: ${artifact.path}`)
    assert.ok(!artifacts.has(artifact.path), `Duplicate device original: ${artifact.path}`)
    artifacts.set(artifact.path, bytes)
  }
  const original = file => {
    assert.ok(artifacts.has(file), `Unbound device original: ${file}`)
    return artifacts.get(file)
  }
  assert.ok(original(proof.identity.codesignArtifact).toString().includes(proof.identity.designatedRequirement), 'Code signature identity does not match its original')
  const processOriginal = JSON.parse(original(proof.identity.processArtifact))
  assert.equal(processOriginal.mainPid, proof.identity.mainPid)
  assert.equal(processOriginal.executablePath, proof.identity.executablePath)
  assert.equal(processOriginal.sourceCommit, proof.identity.sourceCommit)
  assert.equal(processOriginal.designatedRequirement, proof.identity.designatedRequirement)
  const packageIdentity = JSON.parse(original(proof.identity.packageArtifact))
  assert.equal(packageIdentity.schema, 'agentmux.package-identity.v1')
  assert.equal(packageIdentity.sourceCommit, proof.identity.sourceCommit)
  assert.deepEqual(JSON.parse(await readFile(path.join(proof.identity.appPath, 'Contents/Resources/app/package-identity.json'))), packageIdentity)
  const loaded = JSON.parse(original(proof.identity.clientObservationArtifact))
  assert.equal(loaded.schema, 'agentmux.desktop-client-observation.v1')
  assert.equal(loaded.main.pid, proof.identity.mainPid)
  assert.deepEqual(loaded.main.package, packageIdentity)
  const rendererRoot = loaded.main.renderer.kind === 'bundled'
    ? path.join(proof.identity.appPath, 'Contents/Resources/app/out/renderer')
    : path.join(proof.identity.userDataPath, 'renderer-updates', loaded.main.renderer.id)
  assert.ok(['bundled', 'staged'].includes(loaded.main.renderer.kind))
  const release = JSON.parse(original(proof.identity.rendererManifestArtifact))
  assert.equal(release.schema, 1)
  assert.equal(release.id, hash(JSON.stringify({ identity: release.identity, files: Object.entries(release.files).sort() })))
  assert.equal(release.id, loaded.main.renderer.id)
  assert.deepEqual(release.identity, loaded.main.renderer.identity)
  assert.deepEqual(JSON.parse(await readFile(path.join(rendererRoot, 'release.json'))), release)
  assert.ok(Object.keys(release.files).length > 0 && release.files['index.html'], 'Empty Renderer manifest')
  for (const [name, digest] of Object.entries(release.files)) {
    assert.ok(!path.isAbsolute(name) && !name.split('/').includes('..'))
    assert.equal(hash(await readFile(path.join(rendererRoot, name))), digest, `Actual loaded Renderer changed: ${name}`)
  }
  assert.ok(proof.identity.bundleArtifacts.length > 0, 'No compiled package originals')
  const bundleHashes = {}
  for (const item of proof.identity.bundleArtifacts) {
    assert.ok(item.installedPath.startsWith(`${proof.identity.appPath}/Contents/Resources/app/`))
    const bytes = original(item.artifact)
    assert.equal(hash(await readFile(item.installedPath)), hash(bytes), `Installed compiled content changed: ${item.installedPath}`)
    bundleHashes[item.installedPath] = hash(bytes)
  }
  assert.ok(bundleHashes[path.join(proof.identity.appPath, 'Contents/Resources/app/out/main/index.js')], 'Missing actual Main compiled original')
  // Actual UI use is an experiment, not something JSON shape can establish. Its independent
  // device reviewer binds the source, compiled copies and observation originals here.
  const review = JSON.parse(original(proof.reviewArtifact))
  assert.equal(review.schema, 'agentmux.composer-screenshot-device-review.v1')
  assert.equal(review.status, 'approved')
  assert.ok(review.reviewer && review.reviewedAt && review.evidenceBasis === 'actual-installed-message-tools')
  assert.deepEqual(review.identity, proof.identity)
  assert.deepEqual(review.sourceInputs, proof.sourceInputs)
  assert.deepEqual(review.bundleHashes, bundleHashes)
  assert.ok(proof.attempts.length >= 5, 'Capture, repeated capture, cancel, failure and retry all need originals')
  const attemptIds = new Set(), observationPaths = new Set()
  for (const kind of ['capture', 'repeat-capture', 'cancel', 'failure', 'retry']) {
    const attempt = proof.attempts.find(item => item.kind === kind)
    assert.ok(attempt, `Missing device attempt: ${kind}`)
    assert.ok(attempt.id && !attemptIds.has(attempt.id) && !observationPaths.has(attempt.observationArtifact), 'Device attempts need unique originals')
    attemptIds.add(attempt.id); observationPaths.add(attempt.observationArtifact)
    assert.equal(attempt.mainPid, proof.identity.mainPid, `Another App process was used: ${kind}`)
    assert.equal(attempt.designatedRequirement, proof.identity.designatedRequirement)
    assert.equal(attempt.systemConsentPrompts, 0, `Repeated or unknown system consent: ${kind}`)
    const observationBytes = original(attempt.observationArtifact)
    assert.equal(review.observationHashes[attempt.observationArtifact], hash(observationBytes), `Device review did not consume ${kind}`)
    const observation = JSON.parse(observationBytes)
    assert.equal(observation.method, 'actual-message-tools-ui')
    assert.equal(observation.attemptId, attempt.id)
    assert.ok(Number.isFinite(observation.startedAt) && Number.isFinite(observation.finishedAt) && observation.finishedAt >= observation.startedAt)
    assert.equal(observation.mainPid, proof.identity.mainPid)
    assert.equal(observation.executablePath, proof.identity.executablePath)
    assert.equal(observation.sourceCommit, proof.identity.sourceCommit)
    assert.equal(observation.designatedRequirement, proof.identity.designatedRequirement)
    assert.equal(observation.systemConsentPrompts, 0)
    assert.ok(observation.target && observation.before && observation.after && observation.captureResult, `Incomplete actual product path: ${kind}`)
    for (const draft of [observation.before, observation.after]) {
      assert.equal(draft.target, observation.target)
      assert.equal(typeof draft.draft, 'string')
      assert.ok(Array.isArray(draft.attachments), `No attachment observation: ${kind}`)
    }
    if (kind === 'capture' || kind === 'repeat-capture' || kind === 'retry') {
      const png = original(attempt.imageArtifact)
      assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), 'Saved capture is not PNG')
      assert.equal(observation.captureResult.type, 'saved')
      assert.ok(typeof observation.captureResult.path === 'string' && observation.captureResult.path.length > 0)
      assert.equal(observation.captureResult.sha256, hash(png))
      assert.ok(!observation.before.draft.includes(observation.captureResult.path), 'Saved reference was already present')
      assert.equal(observation.after.target, observation.target)
      assert.ok(observation.after.draft.includes(observation.captureResult.path), 'The original draft did not consume the saved capture')
    } else {
      assert.ok(observation.before.draft.length > 0 && observation.before.attachments.length > 0, `${kind} needs an existing draft and attachment to prove preservation`)
      assert.deepEqual(observation.after, observation.before, `${kind} changed the draft or target`)
      assert.equal(observation.captureResult.type, kind === 'cancel' ? 'cancelled' : 'failed')
      if (kind === 'cancel') {
        assert.equal(observation.userAction.key, 'Escape')
        assert.ok(Number.isFinite(observation.userAction.observedAt))
        assert.ok(observation.userAction.observedAt >= observation.startedAt && observation.userAction.observedAt <= observation.finishedAt)
        assert.ok(observation.captureResult.childClose && observation.captureResult.fileState === 'ENOENT', 'No actual cancellation signature')
        const close = observation.captureResult.childClose
        assert.ok(Number.isInteger(close.code) || close.code === null)
        assert.ok(close.signal === null || (typeof close.signal === 'string' && close.signal.length > 0))
        assert.equal(typeof close.stderr, 'string')
        assert.ok(close.code !== null || close.signal !== null)
        assert.equal(observation.captureResult.timedOut, false)
        assert.deepEqual(observation.captureResult.killSignals, [], 'Termination is not Escape cancellation')
      }
    }
  }
  console.log(JSON.stringify({ passed: true, scope: 'consumed-independent-approved-device-evidence', appPath: proof.identity.appPath, mainPid: proof.identity.mainPid }))
}

assert.equal(process.argv.slice(2).length, 1, 'Choose --source or --device')
if (process.argv[2] === '--source') await source()
else if (process.argv[2] === '--device') await device()
else throw new Error('Choose --source or --device')
