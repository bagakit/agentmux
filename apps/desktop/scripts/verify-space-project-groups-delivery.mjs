import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '../../..')
const read = file => fs.readFile(path.isAbsolute(file) ? file : path.join(root, file))
const json = async file => JSON.parse(await read(file))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const source = await json('.tmp/cross-device-project-groups/source-receipt.json')
assert.equal(source.passed, true)
assert.ok(source.productionCallers.length > 0 && source.productionCallers.every(one => one.definition !== one.file && one.hits.length > 0))
for (const [file, digest] of Object.entries({ ...source.inputsAfter, ...source.dependencyInputsAfter })) assert.equal(hash(await read(file)), digest, `Source evidence stale: ${file}`)
const baseline = source.checks.find(one => one.id === 'baseline')
assert.ok(baseline?.qualifiedOriginalGreen && baseline.total > 0)
const mutants = source.checks.filter(one => one.qualifiedAssertionRed)
assert.ok(mutants.length >= 9 && mutants.some(one => one.id === 'reject-overlapping-public-catalog'))
for (const mutant of mutants) {
  assert.equal(mutant.exitCode, 1)
  assert.ok(mutant.failed > 0 && mutant.loaded && Object.values(mutant.loaded).some(one => one.changed))
  assert.ok(source.checks.some(one => one.id === `restored-${mutant.id}` && one.qualifiedOriginalGreen))
}
const nativeFile = '.tmp/cross-device-project-groups-native/proof.json'
const bytes = await read(nativeFile), native = JSON.parse(bytes)
assert.equal(native.passed, true)
assert.deepEqual(native.sourceBefore, native.sourceAfter)
assert.deepEqual(native.compiledBefore, native.compiledAfter)
assert.deepEqual(native.sdkBefore, native.sdkAfter)
assert.equal(new Set(native.phases.map(one => one.native.electronPid)).size, 2)
assert.deepEqual(native.phases.map(one => one.phase), ['seed', 'restore'])
const [seed, restore] = native.phases.map(one => one.native)
assert.ok(seed.overlapping?.projectIds.length >= 2)
assert.deepEqual(seed.finalDurable, restore.originalDurable)
assert.ok(restore.dissolved.current.projectGroups.some(one => one.groupId === seed.overlapping.groupId))
assert.ok(native.phases.every(one => one.native.runtimeCalls.length === 0 && one.native.passed && one.exit.exitCode === 0))
assert.ok(native.consumedModules.length > 0)
for (const one of native.consumedModules) assert.equal(hash(await read(one.path)), one.sourceSHA256)
const review = await json('.tmp/cross-device-project-groups-native/independent-visual-review.json')
assert.equal(review.conclusion, 'accepted')
assert.ok(review.reviewer && review.proofSHA256 === hash(bytes))
assert.ok(native.screenshots.length > 0)
for (const shot of native.screenshots) {
  assert.equal(hash(await read(shot.absolutePath)), shot.sha256)
  assert.ok(review.screenshots.some(one => one.absolutePath === shot.absolutePath && one.sha256 === shot.sha256 && one.viewed === true))
}
execFileSync('git', ['merge-base', '--is-ancestor', native.sourceBefore.head, 'main'], { cwd: root })
console.log(JSON.stringify({ passed: true, mutants: mutants.length, tests: baseline.total, screenshots: native.screenshots.length,
  compiledSource: native.sourceBefore.head, main: execFileSync('git', ['rev-parse', 'main'], { cwd: root, encoding: 'utf8' }).trim(),
  visualReview: review.conclusion, restoredProcesses: native.phases.map(one => one.native.electronPid) }))
