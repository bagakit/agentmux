import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

// Consume the task's actual qualified evidence; collecting images is not visual approval.
const root = path.resolve(import.meta.dirname, '../../..')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const read = file => fs.readFile(path.isAbsolute(file) ? file : path.join(root, file))
const json = async file => JSON.parse(await read(file))
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const mode = process.argv.includes('--identity') ? 'identity' : process.argv.includes('--groups') ? 'groups' : null
assert.ok(mode, 'Select the reviewed task with --identity or --groups')
const evidence = []

async function exactInputs(inputs) {
  assert.ok(Object.keys(inputs).length > 0, 'Evidence needs actual nonempty Source bindings')
  for (const [file, digest] of Object.entries(inputs)) assert.equal(sha(await read(file)), digest, `Current input differs: ${file}`)
}

async function sourceProof(file, schema, expectedMutants, expectedCallers) {
  const bytes = await read(file), proof = JSON.parse(bytes)
  assert.equal(proof.schema, schema)
  assert.equal(proof.passed, true, 'Actual Source qualification is required')
  assert.equal(proof.sharedSourceModified, false)
  assert.equal(proof.sharedDistModified, false)
  assert.equal(proof.originalAppOrRunTouched, false)
  assert.deepEqual(proof.inputsBefore, proof.inputsAfter)
  assert.deepEqual(proof.dependencyInputsBefore, proof.dependencyInputsAfter)
  await exactInputs(proof.inputsAfter)
  await exactInputs(proof.dependencyInputsAfter)
  const baseline = proof.checks.find(check => check.id === 'baseline')
  assert.ok(baseline?.qualifiedOriginalGreen && baseline.total > 0)
  const names = baseline.cases.map(item => item.name).sort()
  assert.equal(new Set(names).size, names.length)
  const reds = proof.checks.filter(check => check.qualifiedAssertionRed)
  assert.equal(reds.length, expectedMutants)
  for (const check of proof.checks) {
    const report = await json(check.report)
    assert.equal(sha(await read(check.report)), check.reportSHA256)
    assert.equal(report.numTotalTests, check.total)
    assert.equal(report.numFailedTests, check.failed)
    assert.equal(report.numPassedTests, check.passed)
    assert.ok(check.total > 0 && check.cases.length > 0)
    const active = check.cases.filter(item => !['pending', 'skipped'].includes(item.status))
    assert.ok(active.length > 0 && active.every(item => names.includes(item.name)))
    assert.ok(check.loaded && Object.keys(check.loaded).length > 0)
    if (check.qualifiedAssertionRed) {
      assert.equal(check.exitCode, 1)
      assert.ok(check.failed > 0)
      assert.ok(check.cases.some(item => item.status === 'failed' && item.failureMessages.length > 0))
      const restored = proof.checks.find(item => item.id === 'restored-' + check.id)
      assert.ok(restored?.qualifiedOriginalGreen, `Exact original restoration required: ${check.id}`)
      assert.deepEqual(restored.cases.map(item => item.name), check.cases.map(item => item.name))
    } else {
      assert.equal(check.qualifiedOriginalGreen, true)
      assert.equal(check.exitCode, 0)
      assert.equal(check.failed, 0)
      assert.ok(active.every(item => item.status === 'passed'))
    }
  }
  assert.equal(proof.productionCallers.length, expectedCallers)
  for (const caller of proof.productionCallers) {
    assert.notEqual(caller.definition, caller.file)
    assert.ok(caller.hits.length > 0, 'Imports alone are not production callers')
    assert.equal(sha(await read(caller.file)), caller.sourceSHA256)
  }
  evidence.push({ file, sha256: sha(bytes), tests: baseline.total, mutants: reds.length, productionCallers: proof.productionCallers.length })
  return proof
}

async function nativeAndVisual() {
  const file = '.tmp/cross-device-project-groups-native/proof.json', bytes = await read(file), proof = JSON.parse(bytes)
  assert.equal(proof.schema, 'agentmux.cross-device-project-groups.native.v1')
  assert.equal(proof.passed, true)
  assert.deepEqual(proof.sourceBefore, proof.sourceAfter)
  const currentHead = git(['rev-parse', 'HEAD'])
  // Documentation or this evidence consumer can change without recompiling the product.
  // Require all actual product/fixture/SDK inputs below and disclose that bounded delta.
  const qualificationDelta = proof.sourceBefore.head === currentHead ? []
    : git(['diff', '--name-only', proof.sourceBefore.head, currentHead]).split('\n').filter(Boolean)
  assert.ok(qualificationDelta.every(file => file.startsWith('docs/') && file.endsWith('.md')
    || file === 'apps/desktop/scripts/verify-cross-device-project-groups.mjs'),
    'Changed product or proof Source requires its own qualified candidate')
  if (!qualificationDelta.length) assert.equal(proof.sourceBefore.tree, git(['rev-parse', 'HEAD^{tree}']))
  assert.equal(proof.sourceBefore.trackedStatus, '')
  assert.deepEqual(proof.sdkBefore, proof.sdkAfter)
  assert.deepEqual(proof.compiledBefore, proof.compiledAfter)
  await exactInputs(proof.sdkAfter)
  assert.ok(proof.consumedModules.length > 0)
  for (const input of proof.consumedModules) assert.equal(sha(await read(input.path)), input.sourceSHA256)
  assert.ok(proof.consumedModules.some(input => input.path.endsWith('/styles/project-groups.css') && input.consumedBy === 'postcss-input'))
  assert.deepEqual(proof.phases.map(item => item.phase), ['seed', 'restore'])
  assert.equal(new Set(proof.phases.map(item => item.native.electronPid)).size, 2)
  const [seed, restore] = proof.phases.map(item => item.native)
  for (const phase of proof.phases) {
    assert.equal(phase.exit.exitCode, 0)
    assert.equal(phase.exit.timedOut, false)
    assert.equal(phase.native.passed, true)
    assert.deepEqual(phase.native.runtimeCalls, [])
    assert.ok(phase.native.spatialEvents.length > 0)
    assert.ok(phase.native.calls.some(call => call.operation === 'spatial-commit' && call.result?.revision > 0))
  }
  assert.deepEqual(seed.finalDurable, restore.originalDurable)
  assert.ok(seed.createdAck && seed.renamedAck && seed.aliasFocus && seed.remoteSelection && restore.restored && restore.dissolved)
  const topology = graph => Object.fromEntries(Object.entries(graph).filter(([key]) => key !== 'projectGroups'))
  for (const state of [seed.createdAck.durable, seed.renamedAck.durable, seed.remoteSelection.durable, restore.dissolved.durable])
    assert.deepEqual(topology(state.graph), topology(seed.originalDurable.graph))
  assert.deepEqual(proof.cleanup.errors, [])
  assert.deepEqual(proof.cleanup.remaining, [])
  assert.equal(proof.cleanup.privateRootRemoved, true)
  assert.equal(proof.userAppTouched, false)
  assert.equal(proof.originalRemoteOwnerTouched, false)
  assert.equal(proof.screenshots.length, 14)
  for (const shot of proof.screenshots) {
    const png = await read(shot.absolutePath)
    assert.equal(sha(png), shot.sha256)
    assert.equal(png.readUInt32BE(16), shot.width)
    assert.equal(png.readUInt32BE(20), shot.height)
    assert.ok(shot.width >= 900 && shot.height >= 760 && shot.scene)
  }
  const reviewFile = '.tmp/cross-device-project-groups-native/independent-visual-review.json'
  const reviewBytes = await read(reviewFile), review = JSON.parse(reviewBytes)
  assert.equal(review.conclusion, 'accepted', 'Independent actual full-image review must have no must-fix findings')
  assert.ok(review.reviewer)
  assert.equal(review.proofSHA256, sha(bytes))
  assert.deepEqual({ head: review.source?.head, tree: review.source?.tree },
    { head: proof.sourceBefore.head, tree: proof.sourceBefore.tree })
  assert.equal(review.screenshots.length, proof.screenshots.length)
  for (const shot of proof.screenshots) assert.ok(review.screenshots.some(item => item.absolutePath === shot.absolutePath && item.sha256 === shot.sha256 && item.viewed === true))
  evidence.push({ file, sha256: sha(bytes), ordinaryPids: proof.phases.map(item => item.native.electronPid), screenshots: proof.screenshots.length,
    reviewFile, reviewSHA256: sha(reviewBytes), conclusion: review.conclusion, capturedSource: proof.sourceBefore,
    deliverySource: currentHead, qualificationDelta })
}

await sourceProof('.tmp/cross-device-project-groups/source-receipt.json', 'agentmux.cross-device-project-groups.source.v1', 6, 7)
if (mode === 'identity') await sourceProof('.tmp/git-project-identity/source-receipt.json', 'agentmux.git-project-identity.source.v1', 5, 5)
await nativeAndVisual()
console.log(JSON.stringify({ passed: true, task: mode, source: { head: git(['rev-parse', 'HEAD']), tree: git(['rev-parse', 'HEAD^{tree}']) }, evidence }, null, 2))
