import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const root = path.resolve(import.meta.dirname, '../../../../..')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const digestPattern = /^[a-f0-9]{64}$/
function record(value, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), label)
  return value
}
function nonempty(value, label) {
  assert.ok(Array.isArray(value) && value.length > 0, label)
  return value
}
function pid(value, label) { assert.ok(Number.isInteger(value) && value > 0, label) }
async function checked(evidence) {
  record(evidence, 'Missing source-bound evidence reference')
  assert.ok(typeof evidence.path === 'string' && path.isAbsolute(evidence.path), 'Absolute original evidence path required')
  assert.match(evidence.sha256, digestPattern)
  const bytes = await fs.readFile(evidence.path)
  assert.equal(sha(bytes), evidence.sha256, 'Evidence changed: ' + evidence.path)
  return bytes
}
const json = async reference => JSON.parse(await checked(reference))
const relativeRef = (directory, name, digest) => ({ path: path.resolve(directory, name), sha256: digest })
function receiptSources(source, label) {
  const entries = Object.entries(record(source, label))
  assert.ok(entries.length > 0, 'Empty source set: ' + label)
  for (const [name, digest] of entries) assert.match(digest, digestPattern, 'Invalid source digest: ' + name)
  return entries
}
function sourceEntries(source, label) {
  const entries = receiptSources(source, label)
  for (const [name] of entries) {
    assert.ok(!path.isAbsolute(name) && !name.split(/[\\/]/).includes('..'), 'Repository source path required: ' + name)
  }
  return entries
}
const pointer = JSON.parse(await fs.readFile(path.join(root, '.local/state/mote-avatar-series/durable-verification.json'), 'utf8'))
const manifest = await json({ path: pointer.manifest, sha256: pointer.sha256 })
assert.equal(manifest.schema, 'agentmux.mote-avatar-durable-verification.v1')
const visual = await json(manifest.approvals?.visual)
assert.equal(visual.schema, 'agentmux.visual-review.v1')
assert.equal(visual.status, 'approved'); assert.equal(visual.task, 'T-003')
assert.equal(visual.reviewer, '/root/mote_visual_review')
const required = [
  'packages/core/src/mote-avatar-write.ts', 'packages/core/src/mote-avatar-series.ts',
  'packages/core/src/public-rpc.ts', 'packages/core/src/public-rpc-service.ts',
  'packages/core/src/rpc-native-codec.ts', 'packages/core/src/agentmux-cli-commands.ts',
  'apps/desktop/src/main/mote-avatar-writer.ts', 'apps/desktop/src/main/mote-avatar-control.ts',
  'apps/desktop/src/main/config-owner.ts', 'apps/desktop/src/main/config-store.ts',
  'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/main/scratch-topics.ts',
  'apps/desktop/src/main/object-avatar-files.ts', 'apps/desktop/src/preload/index.ts',
  'apps/desktop/src/shared/config-edit.ts', 'apps/desktop/src/shared/contracts.ts',
  'apps/desktop/src/shared/space-object-appearance.ts',
  'apps/desktop/src/renderer/src/components/SpaceIconPicker.tsx',
  'apps/desktop/src/renderer/src/components/MoteAvatarSeriesEditor.tsx',
  'apps/desktop/src/renderer/src/components/SpaceObjectIcon.tsx',
  'apps/desktop/src/renderer/src/lib/mote-avatar-save-draft.ts',
  'apps/desktop/src/renderer/src/lib/mobile-presentation.ts',
  'apps/desktop/src/renderer/src/lib/api.ts'
]
const guiRequired = [
  ...required.filter(name => /\/(SpaceIconPicker|MoteAvatarSeriesEditor|SpaceObjectIcon)\.tsx$|\/(mote-avatar-save-draft|mobile-presentation)\.ts$/.test(name)),
  ...['editor-entry.tsx', 'editor-preload.cjs', 'editor-main.cjs', 'editor-capture.mjs'].map(name => 'apps/desktop/scripts/fixtures/mote-avatar-series/' + name)
]
for (const name of [...required, ...guiRequired]) assert.match(manifest.source?.[name] ?? '', digestPattern, 'Required closure source: ' + name)
for (const [name, digest] of sourceEntries(manifest.source, 'current closure')) {
  assert.equal(sha(await fs.readFile(path.join(root, name))), digest, 'Source changed: ' + name)
}

// Approval bytes, their author, report and actual evidence own the decision. A
// manifest's approved/actuallyViewed/expectedFailure flags cannot substitute.
const approvalCache = new Map()
async function approval(reference, expectedRole) {
  const key = reference?.path + ':' + reference?.sha256
  if (!approvalCache.has(key)) {
    const value = await json(reference)
    assert.equal(value.schema, 'agentmux.mote-avatar-approval.v1')
    assert.equal(value.status, 'approved')
    assert.ok(['native', 'nonce', 'png', 'gui', 'integration'].includes(value.role), 'Unknown approval responsibility')
    for (const identity of [value.author, value.reviewer]) assert.match(identity, /^\/root(?:\/[a-z0-9_]+)*$/)
    assert.notEqual(value.author, value.reviewer, 'The source author cannot independently approve it')
    sourceEntries(value.source, 'approval ' + value.role)
    await checked(value.report)
    for (const evidence of nonempty(value.evidence, 'Actual approval evidence required')) await checked(evidence)
    approvalCache.set(key, value)
  }
  const value = approvalCache.get(key)
  if (expectedRole) assert.equal(value.role, expectedRole)
  return value
}
const approvals = {}
for (const role of ['native', 'nonce', 'png', 'gui', 'integration']) approvals[role] = await approval(manifest.approvals?.[role], role)
for (const reference of manifest.additionalApprovals ?? []) await approval(reference)
function currentApproved(name, roles) {
  assert.ok([...approvalCache.values()].some(value => roles.includes(value.role) && value.source[name] === manifest.source[name]),
    'No independent current source approval in ' + roles.join('/') + ': ' + name)
}
for (const name of required) {
  const roles = name.includes('/renderer/') ? ['gui', 'native', 'integration']
    : name.endsWith('/config-owner.ts') || name.endsWith('/config-edit.ts') ? ['nonce', 'native', 'integration']
    : name.endsWith('/object-avatar-files.ts') ? ['png', 'native', 'integration'] : ['native', 'integration']
  currentApproved(name, roles)
}
for (const name of ['apps/desktop/src/main/config-owner.ts', 'apps/desktop/src/shared/config-edit.ts']) {
  assert.equal(approvals.nonce.source[name], manifest.source[name], 'Nonce scope must approve its own current owner/CAS')
}
assert.equal(approvals.png.source['apps/desktop/src/main/object-avatar-files.ts'], manifest.source['apps/desktop/src/main/object-avatar-files.ts'])
for (const name of ['apps/desktop/src/main/mote-avatar-writer.ts', 'apps/desktop/src/main/mote-avatar-control.ts',
  'packages/core/src/mote-avatar-write.ts', 'packages/core/src/mote-avatar-series.ts',
  'packages/core/src/public-rpc.ts', 'packages/core/src/public-rpc-service.ts', 'packages/core/src/rpc-native-codec.ts']) currentApproved(name, ['native', 'integration'])
for (const name of guiRequired.slice(0, 5).filter(name => !name.endsWith('/mobile-presentation.ts'))) currentApproved(name, ['gui', 'integration'])
function includesEvidence(review, reference) {
  assert.ok(review.evidence.some(item => item.sha256 === reference.sha256), 'Approval does not bind this actual consumer receipt: ' + reference.path)
}
async function consumerApproval(label, role, reference) {
  const secondary = manifest.consumerApprovals?.[label]
  if (!secondary) { includesEvidence(approvals[role], reference); return }
  const review = await approval(secondary)
  assert.ok([role, 'integration'].includes(review.role), 'Secondary consumer approval has the wrong responsibility')
  includesEvidence(review, manifest.approvals[role])
  includesEvidence(review, reference)
}
async function qualifiedSource(name, actualDigest, receiptRef, roles, qualificationRef) {
  assert.match(actualDigest ?? '', digestPattern, 'Missing actual source: ' + name)
  const current = manifest.source[name] ?? sha(await fs.readFile(path.join(root, name)))
  if (actualDigest === current) return
  const review = await approval(qualificationRef)
  assert.ok(roles.includes(review.role), 'Source qualification has the wrong responsibility: ' + name)
  assert.equal(review.source[name], current, 'Qualification must approve current bytes: ' + name)
  includesEvidence(review, receiptRef)
  assert.ok(nonempty(review.qualifiedSources, 'Explicit retained source qualification required').some(item =>
    item.file === name && item.actualSourceSha256 === actualDigest && item.receiptSha256 === receiptRef.sha256),
  'Approval does not qualify the actual prior source/receipt: ' + name)
}
async function joinSources(receipt, reference, label, exempt = new Set()) {
  // esbuild may include absolute dependency paths outside the closure. Those
  // remain recorded metadata; only bound repository sources are consumers here.
  receiptSources(receipt.source, label)
  for (const name of Object.keys(manifest.source)) if (receipt.source[name] && !exempt.has(name)) {
    await qualifiedSource(name, receipt.source[name], reference, ['native', 'gui', 'integration'], manifest.sourceQualifications?.[label]?.[name])
  }
}

const guiCandidate = await json(manifest.guiCandidate)
assert.equal(guiCandidate.schema, 'agentmux.mote-avatar-ui-write-candidate.v1')
assert.equal(guiCandidate.task, 'T-003')
assert.equal(manifest.feature, guiCandidate.feature)
assert.equal(manifest.task, guiCandidate.task)
assert.equal(visual.feature, guiCandidate.feature)
assert.deepEqual(Object.keys(guiCandidate.owned).sort(), [...guiRequired].sort(), 'The actual candidate must own all nine GUI sources')
assert.deepEqual(guiCandidate.owned, manifest.guiOwned)
const sourceReceipt = await json(guiCandidate.sourceReceipt)
assert.deepEqual(sourceReceipt.owned, guiCandidate.owned)
for (const [name, digest] of sourceEntries(guiCandidate.owned, 'GUI own9')) {
  await checked({ path: path.resolve(guiCandidate.sourceSnapshot, name), sha256: digest })
}
const fullRef = { path: path.join(guiCandidate.fullChain.directory, 'receipt.json'), sha256: guiCandidate.fullChain.receiptSha256 }
const deltaRef = { path: path.join(guiCandidate.targetedDelta.directory, 'receipt.json'), sha256: guiCandidate.targetedDelta.receiptSha256 }
assert.deepEqual(manifest.gui, fullRef, 'gui is the original full chain, never a relabelled current replay')
assert.deepEqual(manifest.guiTargetedDelta, deltaRef)
const gui = await json(fullRef), delta = await json(deltaRef)
await consumerApproval('guiFullChain', 'gui', fullRef)
await consumerApproval('guiTargetedDelta', 'gui', deltaRef)
assert.deepEqual(guiCandidate.independentRequestReview.approval, manifest.approvals.gui)

assert.notEqual(visual.reviewer, approvals.gui.author)
assert.equal(visual.candidateManifestSha256, manifest.guiCandidate.sha256)
const visualDirectory = path.dirname(manifest.approvals.visual.path)
await checked(relativeRef(visualDirectory, visual.report, visual.reportSha256))
const visualSource = await json(relativeRef(visualDirectory, visual.sourceIdentity, visual.sourceIdentitySha256))
assert.equal(visualSource.schema, 'agentmux.visual-review-source-identity.v1')
assert.equal(visualSource.status, 'approved'); assert.equal(visualSource.reviewer, visual.reviewer)
assert.equal(visualSource.candidateManifestSha256, manifest.guiCandidate.sha256)
for (const item of [visual, visualSource]) {
  assert.equal(item.sourceReceiptSha256, guiCandidate.sourceReceipt.sha256)
  assert.equal(item.fullChainGuiReceiptSha256, fullRef.sha256)
  assert.equal(item.currentTargetedGuiReceiptSha256, deltaRef.sha256)
}
assert.deepEqual(visualSource.sourceDeltaSinceFullChain, guiCandidate.targetedDelta.sourceDelta)
assert.equal(visualSource.independentRequestApproval.sha256, manifest.approvals.gui.sha256)
const changed = new Map()
for (const item of nonempty(guiCandidate.targetedDelta.sourceDelta, 'A bounded source delta is required')) {
  assert.ok(guiRequired.includes(item.file) && !changed.has(item.file), 'Duplicate or foreign GUI delta')
  assert.equal(item.fullChainSha256, gui.source[item.file])
  assert.equal(item.deltaSha256, delta.source[item.file])
  assert.notEqual(item.fullChainSha256, item.deltaSha256)
  assert.equal(item.deltaSha256, guiCandidate.owned[item.file])
  changed.set(item.file, item)
}
for (const [name, digest] of Object.entries(guiCandidate.owned)) {
  assert.equal(delta.source[name], digest, 'The targeted consumer must really load current candidate bytes: ' + name)
  assert.equal(visualSource.actualCurrentTargetedGuiSources[name], digest)
  assert.equal(visualSource.owned[name].sha256, digest)
  assert.equal(visualSource.owned[name].fullChainGuiSha256, gui.source[name])
  assert.equal(visualSource.owned[name].currentTargetedGuiMatched, true)
  if (!changed.has(name)) assert.equal(gui.source[name], digest, 'Undeclared full-chain GUI drift: ' + name)
  // Post-candidate product integration is independently qualified. The old full
  // chain retains its own source; only the declared current delta is replayed.
  await qualifiedSource(name, digest, deltaRef, ['gui', 'integration'], manifest.guiSourceQualifications?.[name])
}
await joinSources(gui, fullRef, 'guiFullChain', new Set(guiRequired))
await joinSources(delta, deltaRef, 'guiTargetedDelta', new Set(guiRequired))
function guiPassed(receipt, label, reader = false) {
  assert.equal(receipt.passed, true, label); assert.deepEqual(receipt.sourceDrift, [])
  assert.equal(receipt.process.exitCode, 0); assert.equal(receipt.process.timedOut, false)
  for (const value of [receipt.renderer, ...(reader ? [receipt.reader] : [])]) {
    pid(value.pid, 'Actual GUI process required'); assert.equal(value.passed, true)
    assert.deepEqual(value.errors, []); assert.equal(value.writes, 0, 'Use the native original owner')
    nonempty(value.operations, 'Actual GUI operations required')
    nonempty(value.saveCalls, 'Actual native GUI saves required'); nonempty(value.sourceCalls, 'Actual source calls required')
    nonempty(value.readCalls, 'Actual native reads required')
  }
  if (reader) {
    assert.equal(receipt.readerProcess.exitCode, 0); assert.equal(receipt.readerProcess.timedOut, false)
    assert.notEqual(receipt.renderer.pid, receipt.reader.pid, 'GUI recovery needs another actual process')
  }
}
guiPassed(gui, 'Full original GUI consumer', true); guiPassed(delta, 'Current bounded GUI delta')
assert.equal(gui.renderer.pid, guiCandidate.fullChain.pid); assert.equal(gui.reader.pid, guiCandidate.fullChain.readerPid)
const actions = new Set(gui.renderer.operations.map(item => item.action))
for (const action of ['unknown-retry-keeps-original-complete-request-and-uuid', 'historical-saved-ack-retains-later-current-choice',
  'late-original-baseline-cannot-populate-replaced-target', 'late-original-save-ack-fences-new-target-draft-and-close',
  'refused-save-keeps-draft-review-current-then-explicit-new-intent', 'kept-request-survives-picker-unmount-remount-without-auto-save']) assert.ok(actions.has(action), action)
assert.ok(gui.reader.operations.some(item => item.action === 'second-process-unknown-read-and-explicit-original-request-retry'))
assert.ok(delta.renderer.operations.some(item => item.action === 'uncustomized-mote-face-first-cancel-keeps-original-default'))
assert.ok(delta.renderer.operations.some(item => item.action === 'capture' && item.name === 'durable-request-bytes-unreadable-kept-close-delta'))
const unknownId = guiCandidate.fullChain.unknownOperationId
const originalUnknown = gui.renderer.saveCalls.find(item => item.input.operationId === unknownId)
assert.ok(originalUnknown, 'The retained original request must occur in the actual native call trace')
assert.equal(originalUnknown.value.state, 'unknown')
assert.equal(originalUnknown.value.operation.phase, 'publication-unknown')
assert.equal(originalUnknown.value.operation.durability, 'unknown')
assert.equal(originalUnknown.value.operation.operationId, unknownId)
assert.equal(gui.renderer.operations.find(item => item.action === 'kept-request-survives-picker-unmount-remount-without-auto-save').operationId, unknownId)
assert.equal(gui.reader.operations.find(item => item.action === 'second-process-unknown-read-and-explicit-original-request-retry').operationId, unknownId)
const coreSeriesPath = path.join(root, 'packages/core/dist/mote-avatar-series.js')
assert.equal(sha(await fs.readFile(coreSeriesPath)), delta.nativeCoreExports['packages/core/dist/mote-avatar-series.js'], 'Use the actual portable request canonicalizer consumed by this evidence')
const { avatarSeriesCanonical } = await import(pathToFileURL(coreSeriesPath).href)
const coreWritePath = path.join(root, 'packages/core/dist/mote-avatar-write.js')
assert.equal(sha(await fs.readFile(coreWritePath)), delta.nativeCoreExports['packages/core/dist/mote-avatar-write.js'])
const { parseMoteAvatarSave } = await import(pathToFileURL(coreWritePath).href)
const requestHash = request => 'sha256:' + sha(avatarSeriesCanonical(request))
parseMoteAvatarSave(originalUnknown.input)
assert.equal(originalUnknown.value.operation.requestHash, requestHash(originalUnknown.input))
// Lost GUI ACK and the later publication-unknown operation are distinct real
// cases. The former may already have a confirmed native publication.
const lostAckId = gui.renderer.operations.find(item => item.action === 'unknown-retry-keeps-original-complete-request-and-uuid').operationId
const lostAckCalls = gui.renderer.saveCalls.filter(item => item.input.operationId === lostAckId)
assert.ok(lostAckCalls.length >= 2, 'Lost ACK retry must occur in the actual save trace')
parseMoteAvatarSave(lostAckCalls[0].input)
for (const item of lostAckCalls) {
  assert.deepEqual(item.input, lostAckCalls[0].input)
  assert.equal(item.value.operation.operationId, lostAckId)
  assert.equal(item.value.operation.requestHash, requestHash(item.input))
}
const retries = gui.reader.saveCalls.filter(item => item.input.operationId === unknownId)
nonempty(retries, 'Second process must explicitly retry the original UUID')
for (const retry of retries) {
  assert.deepEqual(retry.input, originalUnknown.input, 'Recovery must retain the entire frozen request')
  assert.equal(retry.value.state, 'unknown'); assert.equal(retry.value.operation.phase, 'publication-unknown')
  assert.equal(retry.value.operation.requestHash, requestHash(retry.input))
}
assert.equal(gui.reader.publications.length, 0, 'Unknown retry must not republish')
for (const item of delta.renderer.saveCalls) {
  parseMoteAvatarSave(item.input)
  assert.equal(item.value.state, 'saved'); assert.equal(item.value.operation.durability, 'confirmed')
  assert.equal(item.value.operation.operationId, item.input.operationId)
  assert.equal(item.value.operation.requestHash, requestHash(item.input))
}

const native = await json(manifest.native)
await consumerApproval('native', 'native', manifest.native)
assert.equal(native.passed, true); assert.ok(nonempty(native.calls, 'Actual CLI calls required').length >= 19)
assert.equal(native.processes.length, 3)
for (const value of native.processes) pid(value.pid, 'Actual Host/Main process required')
assert.equal(new Set(native.processes.map(value => value.pid)).size, 3)
const [main1, main2] = native.processes.slice(1)
assert.equal(main1.actualNativeImage, true); assert.equal(main2.actualNativeImage, true)
assert.equal(main1.configPath, main2.configPath); assert.equal(main1.privateHome, main2.privateHome)
assert.ok(path.isAbsolute(main1.configPath) && path.isAbsolute(main1.privateHome))
assert.deepEqual(native.saved.realNativeRestartPids, [main1.pid, main2.pid])
assert.equal(native.saved.legacyChoicesRetained, 3); assert.equal(native.saved.modLossRetainsChoiceAndImage, true)
for (const name of ['apps/desktop/src/main/mote-avatar-writer.ts', 'apps/desktop/src/main/config-owner.ts',
  'apps/desktop/src/main/config-store.ts', 'apps/desktop/src/main/mote-avatar-control.ts',
  'apps/desktop/src/main/scratch-topics.ts', 'apps/desktop/src/main/object-avatar-files.ts',
  'apps/host/src/host.ts', 'apps/desktop/scripts/fixtures/mote-avatar-series/writer-entry.ts',
  'apps/desktop/scripts/fixtures/mote-avatar-series/host-entry.ts']) {
  await qualifiedSource(name, native.source?.[name], manifest.native, ['native', 'integration'], manifest.sourceQualifications?.native?.[name])
}
await joinSources(native, manifest.native, 'native')
function cliWire(call) {
  nonempty(call.args, 'Actual CLI arguments required')
  let value
  for (const bytes of [call.stdout, call.stderr]) {
    try { value = JSON.parse(bytes); break } catch {}
  }
  record(value, 'A real CLI protocol result is required')
  const command = call.args.slice(0, call.args[0] === 'space' ? 4 : 2).join('.')
  assert.equal(value.operation, command, 'The receipt must belong to the actual CLI command')
  assert.equal(call.exitCode === 0, value.ok === true, 'CLI process status must agree with its protocol result')
  return value
}
const wires = native.calls.map(cliWire)
for (const operation of ['app.snapshot', 'space.mote.avatar.read', 'space.mote.avatar.preview', 'space.mote.avatar.save', 'agent.ls']) {
  assert.ok(wires.some(item => item.operation === operation && item.ok === true), 'Missing actual public consumer: ' + operation)
}
assert.deepEqual(wires.find(item => item.operation === 'agent.ls').result.sessions, [], 'Avatar operations must create no AgentSession')
const saves = wires.filter(item => item.operation === 'space.mote.avatar.save' && item.ok).map(item => item.result)
assert.ok(saves.filter(item => item.state === 'refused').length >= 3)
const saved = saves.filter(item => item.state === 'saved' && item.operation.operationId === native.saved.operationId)
assert.ok(saved.length >= 2, 'Same operation must be acknowledged on explicit retry')
for (const item of saved) {
  assert.equal(item.operation.phase, 'published'); assert.equal(item.operation.durability, 'confirmed')
  assert.deepEqual(item.operation.choice, native.saved.choice)
}
const reads = wires.filter(item => item.operation === 'space.mote.avatar.read' && item.ok).map(item => item.result)
const savedReads = reads.filter(item => item.operation?.operationId === native.saved.operationId)
assert.ok(savedReads.length >= 2)
for (const item of savedReads) { assert.deepEqual(item.target, native.saved.target); assert.deepEqual(item.choice, native.saved.choice) }
const missingMod = savedReads.find(item => item.source?.state === 'unavailable')
assert.ok(missingMod && reads.some(item => item.source?.state === 'available' && item.revision === missingMod.revision && avatarSeriesCanonical(item.choice) === avatarSeriesCanonical(missingMod.choice)))
assert.ok(wires.find(item => item.operation === 'app.snapshot').result.motes.some(item =>
  item.workspaceId === native.saved.target.workspaceId && item.topicId === native.saved.target.topicId), 'The target must come from the actual original Mote snapshot')

const mutationIds = new Set(), mutationReceipts = new Set()
let nativeMutants = 0, guiMutants = 0
for (const item of nonempty(manifest.mutations, 'Native and GUI mutations are required')) {
  assert.ok(typeof item.id === 'string' && item.id.length > 0 && !mutationIds.has(item.id)); mutationIds.add(item.id)
  assert.ok(!mutationReceipts.has(item.receipt.sha256), 'One mutant receipt cannot count twice'); mutationReceipts.add(item.receipt.sha256)
  assert.match(item.originalSha256, digestPattern); assert.match(item.effectiveSha256, digestPattern)
  assert.notEqual(item.originalSha256, item.effectiveSha256)
  assert.match(manifest.source[item.file] ?? '', digestPattern, 'Mutation must concern a bound closure source')
  const receipt = await json(item.receipt)
  const review = await approval(item.approval ?? manifest.approvals[item.kind])
  assert.ok([item.kind, 'integration'].includes(review.role), 'Mutation needs a review of that consumer responsibility')
  assert.equal(review.source[item.file], manifest.source[item.file])
  includesEvidence(review, item.receipt)
  if (item.originalSha256 !== manifest.source[item.file]) {
    assert.ok(nonempty(review.qualifiedMutations, 'Retained mutations need independent exact-source qualification').some(value =>
      value.id === item.id && value.actualSourceSha256 === item.originalSha256 && value.receiptSha256 === item.receipt.sha256),
    'Old-source mutation is not qualified for current bytes: ' + item.id)
  }
  // These original producers record source BEFORE applying the isolated mutation.
  // mutation.effectiveSha records the bytes changed for that run, not new source
  // certification. Its identity and causal failure are independently reviewed.
  assert.equal(receipt.source[item.file], item.originalSha256, 'Mutation must retain the actual recorded baseline source')
  if (item.kind === 'native') {
    nativeMutants++
    assert.equal(receipt.mutation.name, item.id); assert.equal(receipt.mutation.file, item.file)
    assert.equal(receipt.mutation.originalSha, item.originalSha256); assert.equal(receipt.mutation.effectiveSha, item.effectiveSha256)
    // durable-capture's consumer catch records passed=true only when the native
    // mutation reached its assertion oracle. Preserve that original convention.
    assert.equal(receipt.passed, true); assert.equal(receipt.mutationDetected, true); assert.equal(receipt.error.code, 'ERR_ASSERTION')
    assert.ok(nonempty(receipt.calls, 'Mutant must reach actual CLI').length >= 2)
    for (const call of receipt.calls) cliWire(call)
    for (const value of nonempty(receipt.processes, 'Mutant must reach real processes')) pid(value.pid, 'Mutant actual process PID')
    assert.ok(receipt.processes.length >= 2)
    assert.equal(new Set(receipt.processes.map(value => value.pid)).size, receipt.processes.length)
  } else {
    assert.equal(item.kind, 'gui'); guiMutants++
    assert.equal(receipt.mutation.id, item.id); assert.equal(receipt.mutation.file, item.file)
    assert.equal(receipt.mutation.originalSha256, item.originalSha256); assert.equal(receipt.mutation.effectiveSha256, item.effectiveSha256)
    if (item.id === 'ignore-original-body-hash') {
      // The independent short replay deliberately fails its assertion after the
      // native body-mismatch counterexample. wrapper passed=true means detected.
      assert.equal(receipt.mutationDetected, true); assert.equal(receipt.process.exitCode, 1); pid(receipt.process.pid, 'Actual short-replay GUI PID')
      assert.equal(receipt.counterexample.nativeSaveCalls, 1)
      assert.notEqual(receipt.counterexample.originalBefore, receipt.counterexample.alteredBefore)
      assert.equal(receipt.counterexample.nativeState, 'refused'); assert.equal(receipt.counterexample.guiState, 'saved')
      assert.equal(receipt.counterexample.afterStoredBytes, null)
    } else {
      assert.equal(receipt.passed, false); assert.equal(receipt.renderer.passed, false)
      pid(receipt.renderer.pid, 'Actual mutant GUI PID')
      nonempty(receipt.renderer.operations, 'GUI mutant needs actual operations'); nonempty(receipt.renderer.sourceCalls, 'GUI mutant needs actual source calls')
      assert.ok(typeof receipt.renderer.error?.message === 'string' && receipt.renderer.error.message.length > 0, 'Actual causal GUI assertion required')
      assert.equal(receipt.process.exitCode, 1); assert.equal(receipt.process.timedOut, false, 'Process timeout cannot prove the functional mutant')
    }
  }
}
assert.equal(nativeMutants, 4); assert.ok(guiMutants >= 4)
for (const id of ['writer-disconnected', 'source-version-ignored', 'baseline-ignored', 'request-replaced']) {
  assert.ok(manifest.mutations.some(item => item.kind === 'native' && item.id === id), 'Required native mutation: ' + id)
}

const imagePaths = new Set()
const currentImages = new Map(Object.values(record(guiCandidate.currentImages, 'Actual current image selection')).map(item => [path.resolve(item.path), item]))
assert.ok(currentImages.size >= 12)
for (const item of nonempty(visual.images, 'Actual independent full images required')) {
  assert.equal(item.actuallyViewedFullImage, true)
  const imagePath = path.resolve(visualDirectory, item.path)
  assert.ok(!imagePaths.has(imagePath), 'Duplicate full-image path'); imagePaths.add(imagePath)
  const candidateImage = currentImages.get(imagePath)
  assert.ok(candidateImage, 'An approved image must belong to this exact candidate')
  assert.equal(candidateImage.sha256, item.sha256)
  const capture = item.receiptSha256 === fullRef.sha256 ? gui : item.receiptSha256 === deltaRef.sha256 ? delta : undefined
  assert.ok(capture, 'Full image must retain its actual capture receipt')
  // The receipt retains its original private capture directory. Approved images
  // are byte-identical archives beside that receipt, not a new capture/source.
  const archiveDirectory = path.dirname(capture === gui ? fullRef.path : deltaRef.path)
  assert.equal(path.resolve(archiveDirectory, path.basename(imagePath)), imagePath)
  assert.equal(capture.images[path.basename(imagePath)], item.sha256)
  for (const name of guiRequired) assert.equal(item.capturedOwnedSource[name], capture.source[name], 'Image source was relabelled: ' + name)
  await checked({ path: imagePath, sha256: item.sha256 })
}
assert.deepEqual([...imagePaths].sort(), [...currentImages.keys()].sort(), 'Every current candidate image needs its actual independent full view')

assert.ok(manifest.originalWork?.path, 'Waiting for the actual originalWork installation/recovery receipt')
const work = await json(manifest.originalWork)
assert.equal(work.schema, 'agentmux.mote-avatar-original-work-recovery.v1')
const workInputs = {}
for (const key of ['appBefore', 'appAfter', 'agentsBefore', 'agentsAfter', 'draftsBefore', 'draftsAfter', 'browserTargetsAfter', 'spatialAfter']) workInputs[key] = await json(work[key])
function originalWire(value, operation) {
  assert.equal(value.ok, true); assert.equal(value.operation, operation)
  return record(value.result, 'Original public result required')
}
const before = originalWire(workInputs.appBefore, 'app.inspect').observation
const after = originalWire(workInputs.appAfter, 'app.inspect').observation
for (const observation of [before, after]) {
  assert.equal(observation.schema, 'agentmux.desktop-client-observation.v1')
  pid(observation.main.pid, 'Actual original Desktop Main PID')
  assert.equal(observation.workbench.loading, false)
  assert.equal(observation.main.storage.localStorage, 'present')
}
assert.notEqual(before.main.pid, after.main.pid, 'Installation must be observed in the restarted original App')
assert.equal(before.main.storage.userData, after.main.storage.userData)
assert.equal(before.main.storage.sessionData, after.main.storage.sessionData)
assert.equal(before.main.storage.directory, after.main.storage.directory)
assert.equal(work.build.cleanCommittedMain, true)
assert.match(work.build.commit, /^[a-f0-9]{40}$/); assert.match(work.build.tree, /^[a-f0-9]{40}$/)
await checked(work.build.productionLog); await checked(work.build.packageLog)
const git = promisify(execFile)
const builtTree = await git('git', ['rev-parse', work.build.commit + '^{tree}'], { cwd: root, encoding: 'utf8' })
assert.equal(builtTree.stdout.trim(), work.build.tree)
for (const name of required) {
  const built = await git('git', ['show', work.build.commit + ':' + name], { cwd: root, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 })
  assert.equal(sha(built.stdout), manifest.source[name], 'Installed committed Main differs from the reviewed closure: ' + name)
}
const artifactNames = [
  'Contents/Resources/app/package-identity.json', 'Contents/Resources/app/out/renderer/release.json',
  'Contents/Resources/app/out/main/index.js', 'Contents/Resources/app/out/preload/index.cjs',
  'Contents/Resources/app/node_modules/@agentmux/core/dist/mote-avatar-write.js',
  'Contents/Resources/app/node_modules/@agentmux/core/release.json'
]
assert.deepEqual(work.build.artifacts.map(item => item.relativePath).sort(), [...artifactNames].sort(), 'All six actual packaged/installed artifacts required')
const installed = new Map()
assert.ok(path.isAbsolute(work.installTransaction.candidate))
for (const item of work.build.artifacts) {
  assert.equal(item.installed.path, path.join(work.installTransaction.candidate, item.relativePath))
  assert.equal(item.packaged.sha256, item.installed.sha256)
  const packaged = await checked(item.packaged), bytes = await checked(item.installed)
  assert.ok(packaged.equals(bytes), 'Installed bytes differ from this exact main package: ' + item.relativePath)
  installed.set(item.relativePath, bytes)
}
const packageIdentity = JSON.parse(installed.get(artifactNames[0]).toString())
assert.deepEqual(after.main.package, packageIdentity)
assert.equal(packageIdentity.schema, 'agentmux.package-identity.v1')
assert.equal(packageIdentity.sourceCommit, work.build.commit); assert.equal(packageIdentity.sourceTree, work.build.tree)
const rendererRelease = JSON.parse(installed.get(artifactNames[1]).toString())
assert.equal(after.main.renderer.kind, 'bundled')
assert.equal(after.main.renderer.id, rendererRelease.id); assert.deepEqual(after.main.renderer.identity, rendererRelease.identity)
const coreRelease = JSON.parse(installed.get(artifactNames[5]).toString())
assert.equal(coreRelease.sourceCommit, work.build.commit); assert.equal(coreRelease.sourceTree, work.build.tree)
assert.equal(sha(installed.get(artifactNames[4])), delta.nativeCoreExports['packages/core/dist/mote-avatar-write.js'])

const oldWorkbench = before.workbench, newWorkbench = after.workbench
for (const key of ['layouts', 'focus', 'activeWorkspaceId', 'mainSurface']) assert.deepEqual(newWorkbench[key], oldWorkbench[key], 'Original workbench changed: ' + key)
assert.deepEqual(newWorkbench.desktop.selection, oldWorkbench.desktop.selection)
assert.deepEqual(newWorkbench.desktop.focus, oldWorkbench.desktop.focus)
const oldTabs = nonempty(oldWorkbench.tabs, 'Original nonempty durable Tabs required')
const newTabs = new Map(newWorkbench.tabs.map(item => [item.id, item]))
assert.equal(newTabs.size, newWorkbench.tabs.length)
assert.deepEqual([...newTabs.keys()].sort(), oldTabs.map(item => item.id).sort(), 'The complete original Tab set must return')
const browserDifferences = [], oldBrowsers = []
for (const oldTab of oldTabs) {
  const newTab = newTabs.get(oldTab.id)
  const { regions: oldRegions, ...oldDescriptor } = oldTab
  const { regions: newRegions, ...newDescriptor } = newTab
  assert.deepEqual(newDescriptor, oldDescriptor, 'Original Tab/layout descriptor changed: ' + oldTab.id)
  const regionMap = new Map(newRegions.map(item => [item.regionId, item]))
  assert.equal(regionMap.size, newRegions.length)
  assert.deepEqual([...regionMap.keys()].sort(), oldRegions.map(item => item.regionId).sort())
  for (const oldRegion of oldRegions) {
    const newRegion = regionMap.get(oldRegion.regionId)
    if (oldRegion.kind !== 'browser') { assert.deepEqual(newRegion, oldRegion); continue }
    oldBrowsers.push(oldRegion)
    // A navigation epoch, loading and error belong to the actual new live
    // navigation. Stable URL/title changes require an exact independent receipt.
    const { navigationId: oldEpoch, loading: oldLoading, error: oldError, url: oldUrl, title: oldTitle, ...oldIdentity } = oldRegion
    const { navigationId: newEpoch, loading: newLoading, error: newError, url: newUrl, title: newTitle, ...newIdentity } = newRegion
    assert.deepEqual(newIdentity, oldIdentity, 'Original Browser/Region/Workspace/Profile identity changed')
    for (const field of ['url', 'title']) if (oldRegion[field] !== newRegion[field]) browserDifferences.push({
      tabId: oldTab.id, regionId: oldRegion.regionId, browserId: oldRegion.browserId, field, before: oldRegion[field], after: newRegion[field]
    })
  }
}
const graph = originalWire(workInputs.spatialAfter, 'space.state').state.graph
const nativeTabs = new Map(nonempty(graph.tabs, 'Actual durable native Tabs required').map(item => [item.tabId, item]))
for (const tab of oldTabs) {
  assert.deepEqual(graph.tabLayouts[tab.id], tab.layout)
  assert.equal(nativeTabs.get(tab.id)?.workspaceId, tab.workspaceId)
  assert.deepEqual([...nativeTabs.get(tab.id).regionIds].sort(), tab.regions.map(item => item.regionId).sort())
}
for (const [name, layout] of Object.entries(oldWorkbench.layouts)) assert.deepEqual(graph.layouts[name], layout)
const browserTargets = new Map(nonempty(originalWire(workInputs.browserTargetsAfter, 'browser.targets').targets, 'Actual Browser targets required').map(item => [item.id, item]))
for (const oldBrowser of oldBrowsers) {
  const currentRegion = newWorkbench.tabs.flatMap(tab => tab.regions).find(item => item.regionId === oldBrowser.regionId)
  const target = browserTargets.get(oldBrowser.browserId)
  assert.ok(target, 'Original Browser target missing')
  assert.equal(target.navigationId, currentRegion.navigationId)
  assert.equal(target.url, currentRegion.url)
  assert.ok(graph.regions.some(item => item.regionId === oldBrowser.regionId && item.browserId === oldBrowser.browserId))
}
const moteTabs = oldTabs.filter(item => item.workspaceId === '__scratch__' && item.topicId === 'launcher:leader')
nonempty(moteTabs, 'The original machine-addressed Main Mote work surface must remain')
for (const tab of moteTabs) assert.deepEqual(newTabs.get(tab.id), tab)

const oldAgents = nonempty(originalWire(workInputs.agentsBefore, 'agent.ls').sessions, 'Original Core Sessions required')
const newAgents = nonempty(originalWire(workInputs.agentsAfter, 'agent.ls').sessions, 'Original Core Sessions after restart required')
const healthy = oldAgents.filter(item => item.run?.state === 'running' && Number.isInteger(item.run.pid) && item.run.pid > 0 && item.run.nativeService?.owner?.type === 'serving')
nonempty(healthy, 'Nonempty actual original healthy Runs required')
for (const item of healthy) {
  const restored = newAgents.find(value => value.routeHostId === item.routeHostId && value.session.agentSessionId === item.session.agentSessionId && value.run.runId === item.run.runId)
  assert.ok(restored, 'Original Session/Run identity missing')
  assert.equal(restored.run.agentSessionId, item.run.agentSessionId)
  assert.equal(restored.run.pid, item.run.pid); assert.equal(restored.run.state, 'running')
  assert.equal(restored.run.nativeService.owner.type, 'serving')
  assert.ok(typeof restored.run.nativeService.input.phase.type === 'string' && restored.run.nativeService.input.phase.type.length > 0)
}
const drafts = workInputs.draftsBefore, restoredDrafts = workInputs.draftsAfter
for (const value of [drafts, restoredDrafts]) {
  assert.equal(value.schema, 'agentmux.original-persisted-workbench-record.v1')
  assert.equal(value.storageKey, 'file://'); assert.equal(value.scriptKey, 'agentmux-workbench-v1')
  assert.ok(Number.isInteger(value.sequence) && value.sequence > 0)
  assert.match(value.rawRecordSha256, digestPattern)
  record(value.drafts, 'Actual persisted drafts required'); record(value.draftHashes, 'Actual persisted draft hashes required')
  for (const [key, text] of Object.entries(value.drafts)) {
    assert.equal(typeof text, 'string')
    assert.equal(sha(text), value.draftHashes[key], 'Persisted draft hash mismatch for original Session: ' + key)
  }
}
assert.ok(restoredDrafts.sequence >= drafts.sequence)
assert.deepEqual(Object.keys(restoredDrafts.drafts).sort(), Object.keys(drafts.drafts).sort())
assert.ok(Object.values(drafts.drafts).some(value => value.length > 0), 'Empty drafts cannot certify original nonempty drafts')
for (const [key, text] of Object.entries(drafts.drafts)) assert.ok(restoredDrafts.drafts[key] === text, 'Original durable draft bytes changed for Session: ' + key)

// The installer really returned unknown. An independently qualified, finite
// identity/recoverability scope can close this task while retaining that unknown;
// it cannot promote complete Browser navigation or live composer text to confirmed.
const workReview = await approval(manifest.originalWorkQualification ?? work.qualification, 'integration')
assert.equal(workReview.sourceCommit, work.build.commit); assert.equal(workReview.sourceTree, work.build.tree)
for (const [name, digest] of sourceEntries(workReview.source, 'Original work recovery scope')) assert.equal(digest, manifest.source[name])
const qualification = record(workReview.qualifiedOriginalWork, 'Exact original-work qualification required')
for (const [key, reference] of Object.entries(work).filter(([key]) => Object.hasOwn(workInputs, key))) {
  assert.equal(qualification[key + 'Sha256'], reference.sha256)
}
assert.equal(qualification.installTransactionSha256, sha(JSON.stringify(work.installTransaction)))
assert.equal(qualification.scope, 'original-identities-and-recoverable-drafts')
assert.equal(work.installTransaction.intent, 'full')
assert.equal(work.installTransaction.ui.status, 'unknown')
assert.equal(work.installTransaction.native.status, 'unchanged')
assert.equal(qualification.installerActivation, 'unknown'); assert.equal(qualification.browserNavigationSemantics, 'unknown')
const sortDifferences = items => [...items].sort((a, b) => (a.tabId + '/' + a.regionId + '/' + a.field).localeCompare(b.tabId + '/' + b.regionId + '/' + b.field))
assert.deepEqual(sortDifferences(qualification.browserDescriptorDifferences), sortDifferences(browserDifferences), 'Qualification must name the exact actual URL/title differences')
console.log(JSON.stringify({ scope: 'durable', passed: true, actualNativeCalls: native.calls.length,
  actualNativeMainPids: [main1.pid, main2.pid], actualGuiPids: [gui.renderer.pid, gui.reader.pid, delta.renderer.pid],
  originalMainPids: [before.main.pid, after.main.pid], originalTabs: oldTabs.length, originalHealthyRuns: healthy.length,
  originalPersistedDrafts: Object.keys(drafts.drafts).length, originalNonemptyPersistedDrafts: Object.values(drafts.drafts).filter(value => value.length > 0).length,
  mutants: mutationIds.size, independentlyViewedFullImages: imagePaths.size,
  originalWork: { identitiesAndRecoverableDrafts: 'confirmed', installerActivation: qualification.installerActivation,
    browserNavigationSemantics: qualification.browserNavigationSemantics, liveComposerText: 'not-observed',
    qualifiedBrowserDescriptorDifferences: browserDifferences.length },
  boundary: 'Checks actual source-bound consumers, separate processes and independent scoped approvals. The original installer activation and complete Browser navigation semantics remain unknown; no full-application green or live composer text claim.' }))
