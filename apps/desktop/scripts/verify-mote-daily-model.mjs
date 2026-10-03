import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkModelSourceGuards, modelHarnessPaths, probeRealMoteModel } from './fixtures/mote-daily-model/probe.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const repository = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const args = process.argv.slice(2)
function option(name) { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1] }
async function bound(locator) {
  assert.ok(locator?.path && /^[a-f0-9]{64}$/.test(locator.sha256 ?? ''), 'A nonempty exact evidence locator is required')
  const bytes = await readFile(resolve(repository, locator.path))
  assert.equal(hash(bytes), locator.sha256, 'Evidence bytes changed: ' + locator.path)
  return JSON.parse(bytes)
}

/** Normal Task qualification consumes genuine evidence; a prepared harness cannot pass it. */
export async function verifyRealMoteModel(locatorPath = '.tmp/mote-daily-model/approved.json') {
  const locator = await readFile(resolve(repository, locatorPath), 'utf8').then(JSON.parse).catch(error => {
    if (error.code === 'ENOENT') throw Error('T-008 is pending: genuine five-input raw evidence and independent usefulness approval are required; --prepare does not qualify a model')
    throw error
  })
  const raw = await bound(locator.raw), review = await bound(locator.review), manifest = await bound(locator.sourceManifest)
  assert.equal(raw.schema, 'agentmux.mote.real-model.v1'); assert.equal(raw.taskId, 'T-008'); assert.equal(raw.passed, true)
  assert.equal(raw.modelTurns, 5); assert.equal(raw.authFilesRead, true); assert.equal(raw.authCopied, true)
  assert.equal(raw.userRunTouched, false)
  assert.equal(raw.owner?.passed, true); assert.equal(raw.owner?.modelTurns, 5)
  assert.equal(raw.owner.attemptedModelRequests, 5); assert.equal(raw.owner.admittedModelRequests, 5)
  assert.equal(raw.owner.completedModelTurns, 5); assert.equal(raw.owner.inputRequests.length, 5)
  assert.deepEqual(raw.owner.rejectedInputs, [])
  assert.equal(raw.modelBudget.attemptedModelRequests, 5); assert.equal(raw.modelBudget.gateClosed, true)
  assert.equal(raw.guardian, undefined); assert.equal(raw.modelRequestsUnknown, undefined)
  assert.equal(raw.cleanup?.authCopyRemoved, true); assert.equal(raw.cleanup?.privateRuntimeRemoved, true)
  assert.deepEqual(raw.cleanup.errors, []); assert.deepEqual(raw.owner.cleanup.errors, [])
  assert.equal(raw.owner.cleanup.exactPrivateRunsStopped, true)
  assert.equal(raw.owner.cleanup.nativeConfirmation.stopped, true)
  assert.equal(raw.owner.cleanup.nativeConfirmation.schedulingDrained, true)
  assert.equal(raw.owner.cleanup.nativeConfirmation.inflight, 0)
  assert.ok(raw.owner.cleanup.nativeConfirmation.runs.length > 0)
  assert.ok(raw.owner.cleanup.nativeConfirmation.runs.every(run => run.state.type !== 'running'))
  assert.equal(raw.nativeCleanupConfirmation.stopped, true)
  assert.ok(raw.nativeCleanupConfirmation.runs.length > 0 && raw.nativeCleanupConfirmation.runs.every(run => run.state.type !== 'running'))
  assert.equal(review.status, 'approved'); assert.ok(review.taskIds?.includes('T-008'))
  assert.equal(review.sourceGate?.sha256, locator.raw.sha256)
  assert.equal(review.sourceManifestSha256, locator.sourceManifest.sha256)
  assert.equal(review.realModelQualification, true, 'Source/UI review cannot substitute for real-model review')
  assert.ok(typeof review.usefulnessAssessment === 'string' && review.usefulnessAssessment.trim())
  assert.equal(manifest.sourcePinnedMain, raw.sourcePinnedMain)
  assert.deepEqual(manifest.harnessSource, raw.harnessSource)
  assert.ok(Object.keys(raw.source ?? {}).length > 0)
  assert.ok(Object.keys(raw.compiledImports?.mainOwner ?? {}).length > 0 && Object.keys(raw.compiledImports?.renderer ?? {}).length > 0)
  assert.ok(Object.keys(raw.compiledImports?.sourceCLI ?? {}).length > 0 && Object.keys(raw.compiledImports?.sourceHook ?? {}).length > 0)
  for (const file of modelHarnessPaths) {
    assert.ok(raw.harnessSource[file]); assert.equal(hash(await readFile(resolve(repository, file))), raw.harnessSource[file], 'Harness Source changed: ' + file)
  }
  // The bounded journey qualifies its immutable reviewed candidate. Fresh Main
  // and any peer deltas are checked by final integration, rather than changing
  // the candidate while an authorized model journey is in flight.
  const main = raw.sourcePinnedMain
  assert.match(main, /^[a-f0-9]{40}$/)
  assert.equal(execFileSync('git', ['cat-file', '-t', main], { cwd: repository, encoding: 'utf8' }).trim(), 'commit')
  for (const [file, sha256] of Object.entries(raw.source)) {
    if (file in raw.harnessSource) continue
    assert.equal(hash(execFileSync('git', ['show', main + ':' + file], { cwd: repository, maxBuffer: 8 * 1024 * 1024 })), sha256,
      'Affected actual Source changed: ' + file)
  }
  const turns = raw.owner.turns
  assert.equal(turns.length, 5)
  for (const [index, turn] of turns.entries()) {
    const attempt = raw.owner.attempts[index], request = raw.owner.inputRequests[index]
    assert.equal(turn.number, index + 1)
    assert.equal(attempt.number, turn.number); assert.equal(attempt.phase, 'completed')
    assert.equal(request.number, turn.number); assert.equal(request.index, turn.requestIndex)
    assert.equal(request.admission, 'confirmed'); assert.equal(request.phase, 'original-input-returned')
    assert.equal(turn.startedAt, request.enteredAt)
    assert.ok(attempt.completedAt <= attempt.deadlineAt && attempt.deadlineAt <= request.enteredAt + 120000)
    assert.ok(turn.completedAt >= turn.startedAt && turn.completedAt - turn.startedAt <= 120000)
    assert.ok(turn.nativeSource?.nativeSessionId && turn.nativeSource.providerId === 'codex')
    assert.ok(turn.tools?.length && turn.toolResults?.length && turn.assistant?.length && turn.pages?.length)
    assert.equal(turn.environment.AGENTMUX_ENV, '1'); assert.equal(turn.environment.AGENTMUX_AGENT_SESSION_ID, turn.agent.control.agentSessionId)
    assert.equal(turn.environment.AGENTMUX_CLI, turn.cli.path)
    assert.equal(turn.completion.run.runId, turn.agent.control.run.runId)
    assert.equal(turn.completion.session.hookReceipt.eventName, 'Stop')
    assert.equal(turn.pages[0].agentSessionId, turn.agent.control.agentSessionId)
    assert.deepEqual(turn.pages[0].source, turn.nativeSource)
    assert.ok(turn.screenshot?.path && /^[a-f0-9]{64}$/.test(turn.screenshot.sha256))
    assert.equal(hash(await readFile(resolve(repository, dirname(locator.raw.path), turn.screenshot.path))), turn.screenshot.sha256)
  }
  assert.equal(new Set(turns.slice(0, 3).map(turn => turn.agent.control.agentSessionId)).size, 3, 'A/B/C must be new original discussions')
  assert.equal(raw.owner.feedbackBeforeDiscussionC?.result.status, 'read')
  assert.ok(raw.owner.feedbackBeforeDiscussionC.result.document.content.trim())
  assert.equal(review.functionalOutcomes?.length, 6)
  assert.deepEqual(review.functionalOutcomes.map(one => one.id).sort(), [
    'tool-save-readback', 'neutral-material-reuse', 'corrected-fact',
    'saved-behavior-feedback', 'calendar-sourced-idea', 'confirmed-goal-result'
  ].sort())
  assert.ok(review.functionalOutcomes.every(one => one.qualified === true))
  assert.ok(raw.owner.currentReads.length >= 4 && raw.owner.editorSaves.length === 2)
  assert.ok(raw.owner.realOutcome?.result.status === 'read' && raw.owner.realOutcome.result.document.content.trim())
  assert.equal(raw.owner.humanChoice.humanConfirmed, true); assert.ok(raw.owner.humanChoice.authorizationEvidence.trim())
  assert.ok(raw.owner.arrangement.creationOperationId && raw.owner.arrangement.calendar)
  assert.equal(raw.owner.workfaceChecks.length, 3); assert.ok(raw.owner.workfaceChecks.every(one => one.preserved === true))
  assert.equal(raw.owner.originalUnsentDraftsPreserved, true)
  console.log(JSON.stringify({ passed: true, taskId: 'T-008', realModelQualified: true, modelTurns: 5, raw: locator.raw, review: locator.review }))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (args.includes('--check-guards')) await checkModelSourceGuards({ repository, evidence: option('--evidence'), scenario: option('--guard-case') })
    else if (args.includes('--prepare')) await probeRealMoteModel({ repository, prepareOnly: true, evidence: option('--evidence') })
    else if (args.includes('--run')) await probeRealMoteModel({ repository, authorization: option('--authorization'),
      authorizationSha256: option('--authorization-sha256'), evidence: option('--evidence') })
    else await verifyRealMoteModel(option('--approved'))
  } catch (error) {
    console.error(JSON.stringify({ passed: false, taskId: 'T-008', qualification: 'pending or failed; no Source/fixture replacement for genuine model evidence', error: error.message }))
    process.exitCode = 1
  }
}
