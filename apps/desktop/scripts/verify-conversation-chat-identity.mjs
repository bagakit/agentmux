import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Verify the retained, bounded qualification. Do not rerun tests or operate a user Run.
const root = resolve(import.meta.dirname, '../../..')
const task = 'T-001'
const ownCount = 5
const owningTest = 'apps/desktop/test/conversation-chat-identity.integration.test.tsx'
const owningConfig = 'apps/desktop/scripts/fixtures/conversation-chat-identity/vitest.owning.config.mts'
const owningTypes = 'apps/desktop/scripts/fixtures/conversation-chat-identity/tsconfig.owning.json'
const productPaths = [
  "apps/desktop/src/renderer/src/lib/conversation-speaker.ts",
  "apps/desktop/src/renderer/src/components/ConversationMessage.tsx",
  "apps/desktop/src/renderer/src/components/ConversationAxis.tsx",
  "apps/desktop/src/renderer/src/components/ActivityView.tsx",
  "apps/desktop/src/renderer/src/components/SessionHistoryView.tsx",
  "apps/desktop/src/renderer/src/styles/activity-conversation.css"
]
const sourcePaths = [...productPaths, owningTest, owningConfig, owningTypes]
const loadedPaths = [
  "apps/desktop/src/renderer/src/lib/conversation-speaker.ts",
  "apps/desktop/src/renderer/src/components/ConversationMessage.tsx",
  "apps/desktop/src/renderer/src/components/ConversationAxis.tsx",
  "apps/desktop/src/renderer/src/components/ActivityView.tsx",
  "apps/desktop/src/renderer/src/components/SessionHistoryView.tsx"
]
const mutants = {
  "unknown-appearance": "apps/desktop/src/renderer/src/lib/conversation-speaker.ts",
  "peer-identity": "apps/desktop/src/renderer/src/components/ConversationMessage.tsx",
  "activity-context": "apps/desktop/src/renderer/src/components/ActivityView.tsx"
}
const adjacentTests = [
  "apps/desktop/test/conversation-reading-ui.integration.test.tsx",
  "apps/desktop/test/conversation-native-user-messages.integration.test.tsx",
  "apps/desktop/test/conversation-shared-surface.integration.test.tsx"
]
const callers = [
  [
    "messageDisplay",
    "apps/desktop/src/renderer/src/components/ConversationMessage.tsx",
    "speakerForDisplay(",
    1
  ],
  [
    "axisDisplay",
    "apps/desktop/src/renderer/src/components/ConversationAxis.tsx",
    "speakerForDisplay(",
    1
  ],
  [
    "activityContext",
    "apps/desktop/src/renderer/src/components/ActivityView.tsx",
    "conversationSessionId={sessionId}",
    2
  ],
  [
    "historyContext",
    "apps/desktop/src/renderer/src/components/SessionHistoryView.tsx",
    "conversationSessionId={control.agentSessionId}",
    1
  ]
]
const requiredImages = ['T001/activity-css332-r4.png', 'T001/activity-css1000-r4.png', 'T001/history-css332-r3.png']
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
function artifact(ref, json = true, allowEmpty = false) {
  assert.ok(ref && typeof ref.path === 'string' && ref.path.length > 0 && validHash(ref.sha256), 'Missing artifact path/hash')
  const bytes = readFileSync(resolve(root, ref.path))
  assert.ok(allowEmpty || bytes.length > 0, `Empty evidence: ${ref.path}`)
  assert.equal(sha(bytes), ref.sha256, `Evidence changed: ${ref.path}`)
  return json ? JSON.parse(bytes.toString()) : bytes.toString()
}
function stage(ref, expectedExit, source) {
  const receipt = artifact(ref)
  assert.equal(receipt.exit, expectedExit, 'Unexpected actual command exit')
  assert.ok(Array.isArray(receipt.argv) && receipt.argv.length > 0, 'Actual command missing')
  for (const path of productPaths) {
    assert.equal(receipt.sourceBefore?.[path], source[path], `Run Source mismatch: ${path}`)
    assert.equal(receipt.sourceAfter?.[path], source[path], `Source changed during run: ${path}`)
  }
  artifact({ path: receipt.log, sha256: receipt.logSHA256 }, false, true)
  return receipt
}
function report(run, green, expectedCount, source) {
  if (task === 'T-002' && !green) {
    const summary = artifact(run.mutationSummary)
    assert.ok(Array.isArray(summary) && summary.length > 0, 'No actual mutation summary')
    const found = summary.filter(item => item.mutation === run.name)
    assert.equal(found.length, 1, 'Mutation actual exit receipt missing or duplicated')
    assert.equal(found[0].exit, 1)
    assert.equal(found[0].total, expectedCount)
    assert.ok(found[0].assertionErrors > 0, 'No actual AssertionRED receipt')
  } else {
    const receipt = stage(run.receipt, green ? 0 : 1, source)
    assert.ok(receipt.argv.some(arg => arg.includes('vitest')) && receipt.argv.includes('run'), 'Actual Vitest command missing')
    if (expectedCount !== undefined) assert.ok(receipt.argv.includes(owningConfig), 'Wrong owning config command')
  }
  const data = artifact(run.report)
  const results = data.testResults
  assert.ok(Array.isArray(results) && results.length > 0, 'No collected test files')
  const assertions = results.flatMap(file => file.assertionResults ?? [])
  assert.ok(assertions.length > 0, 'No collected assertions')
  if (expectedCount !== undefined) {
    assert.equal(assertions.length, expectedCount, 'Owning assertions changed')
    assert.ok(results.every(file => file.name.endsWith(owningTest)), 'Wrong owning test file')
  }
  assert.equal(data.numTotalTests, assertions.length, 'Report count is not collected assertions')
  assert.equal(data.success, green, 'Unexpected report success')
  if (green) {
    assert.equal(data.numPassedTests, assertions.length)
    assert.equal(data.numFailedTests, 0)
    assert.ok(assertions.every(item => item.status === 'passed'), 'Skipped/failed assertions do not qualify')
  } else {
    const failed = assertions.filter(item => item.status === 'failed')
    assert.ok(failed.length > 0, 'No failed assertions; setup RED is not semantic RED')
    assert.equal(data.numFailedTests, failed.length)
    assert.ok(failed.every(item => item.failureMessages.some(message => message.includes('AssertionError'))), 'Only actual AssertionError RED qualifies')
  }
  return results
}
function loaded(ref, source, mutation) {
  const records = artifact(ref, false).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.ok(records.length > 0, 'No loaded Source')
  for (const path of loadedPaths) {
    const found = records.filter(item => item.path === path)
    assert.ok(found.length > 0, `Actual owner was not loaded: ${path}`)
    for (const item of found) {
      assert.ok(item.bytes > 0 && validHash(item.sha256), `Empty/invalid loaded owner: ${path}`)
      assert.equal(item.originalSHA256, source[path], `Wrong loaded original Source: ${path}`)
      if (!mutation) assert.equal(item.sha256, item.originalSHA256, `Restore still mutated: ${path}`)
    }
  }
  if (mutation) {
    assert.ok(records.some(item => item.path === mutants[mutation] && item.mutation === mutation && item.bytes > 0 && item.sha256 !== item.originalSHA256), `Mutation was not actually loaded: ${mutation}`)
  }
}
try {
  const option = process.argv.indexOf('--proof')
  assert.ok(option >= 0 && process.argv[option + 1], 'Use --proof <qualification.json>')
  const proof = JSON.parse(readFileSync(resolve(root, process.argv[option + 1]), 'utf8'))
  assert.equal(proof.task, task)
  assert.ok(proof.source && Object.keys(proof.source).length > 0, 'Source binding missing')
  for (const path of sourcePaths) {
    assert.ok(validHash(proof.source[path]), `Source hash missing: ${path}`)
    assert.equal(sha(readFileSync(resolve(root, path))), proof.source[path], `Current Source changed: ${path}`)
  }
  const config = readFileSync(resolve(root, owningConfig), 'utf8')
  assert.ok(config.includes(owningTest) && config.includes('passWithNoTests: false'), 'Owning config must collect its literal test and reject empty suites')
  report(proof.own, true, ownCount, proof.source); loaded(proof.own.loaded, proof.source)
  assert.ok(Array.isArray(proof.mutations) && proof.mutations.length === Object.keys(mutants).length, 'Mutation receipt count changed')
  assert.deepEqual(proof.mutations.map(item => item.name).sort(), Object.keys(mutants).sort())
  for (const mutation of proof.mutations) {
    report(mutation, false, ownCount, proof.source)
    loaded(mutation.loaded, proof.source, mutation.name)
  }
  report(proof.restore, true, ownCount, proof.source); loaded(proof.restore.loaded, proof.source)
  const adjacent = report(proof.adjacent, true, undefined, proof.source)
  for (const path of adjacentTests) {
    assert.ok(adjacent.some(file => file.name.endsWith(path) && file.assertionResults.length > 0), `Adjacent file did not collect assertions: ${path}`)
  }
  for (const [label, path, needle, minimum] of callers) {
    const source = readFileSync(resolve(root, path), 'utf8')
    const found = source.split(needle).length - 1
    assert.ok(found >= minimum, `Product caller missing outside definition: ${label}`)
  }
  for (const kind of ['production', 'owning']) {
    const receipt = stage(proof.types?.[kind], 0, proof.source)
    assert.ok(receipt.argv.some(arg => arg.includes('typescript')) && receipt.argv.includes('--noEmit'), `${kind} types command missing`)
    assert.ok(receipt.argv.includes(kind === 'production' ? 'apps/desktop/tsconfig.json' : owningTypes), `${kind} types config mismatch`)
  }
  const review = artifact(proof.visualReview)
  assert.equal(review.status, 'pass'); assert.equal(review.source_review?.status, 'pass'); assert.equal(review.visual_review?.status, 'pass')
  assert.ok(typeof review.reviewer === 'string' && review.reviewer.length > 0, 'Independent reviewer missing')
  for (const path of productPaths) assert.equal(review.source_binding?.files?.[path]?.sha256, proof.source[path], `Review Source mismatch: ${path}`)
  const viewed = review.visual_review.actually_opened
  assert.ok(Array.isArray(viewed) && viewed.length > 0, 'No actually viewed images')
  for (const path of requiredImages) {
    const image = viewed.find(item => item.path === path)
    assert.ok(image?.actually_opened && image.pixel_dimensions?.[0] > 0 && image.pixel_dimensions?.[1] > 0, `Image was not actually reviewed: ${path}`)
    artifact({ path: `${proof.artifactDirectory}/${path}`, sha256: image.sha256 }, false)
    assert.ok(review.visual_review.observations.some(item => item.image === path && item.judgment?.trim().length > 0), `No actual visual judgment: ${path}`)
  }
  console.log(JSON.stringify({ task, passed: true, ownAssertions: ownCount, loadedOwners: loadedPaths.length, mutations: Object.keys(mutants).length, bounded: true }))
} catch (error) {
  console.error(`${task}: ${error.message}`)
  process.exitCode = 1
}
