import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..'), directory = resolve(root, '.tmp/mobile-exact-first-read')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const json = async file => JSON.parse(await readFile(resolve(root, file), 'utf8'))
async function current(source) {
  assert.ok(Object.keys(source).length > 0, 'Evidence needs nonempty original inputs')
  for (const [file, digest] of Object.entries(source)) assert.equal(sha(await readFile(resolve(root, file))), digest, 'Current original source: ' + file)
}
async function artifact(value) {
  const bytes = await readFile(resolve(root, value.file))
  assert.equal(sha(bytes), value.sha256, 'Retained original evidence: ' + value.file)
  return bytes
}
const result = { passed: false, boundary: 'Consumes original product/Relay tests, evaluated counterexamples, standard Mobile build and independently viewed complete images. Does not operate a user Session, page or package.' }
try {
  const authorBytes = await artifact(await json('.tmp/mobile-exact-first-read/author/latest.json'))
  const author = JSON.parse(authorBytes)
  assert.equal(author.passed, true); await current(author.source)
  assert.deepEqual(author.rounds.map(round => round.name), ['baseline', 'wait-whole-directory', 'directory-closes-conversation', 'focus-misses-empty-ready', 'references-miss-empty-ready', 'restored'])
  for (const round of author.rounds) {
    const data = JSON.parse(await artifact(round.report))
    const rows = (await artifact(round.loaded)).toString().trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.phase === 'evaluated')
    const graph = (await artifact(round.graph)).toString().trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    await artifact(round.log)
    const tests = data.testResults.flatMap(file => file.assertionResults).filter(test => ['passed', 'failed'].includes(test.status))
    assert.ok(tests.length > 0 && rows.length > 0 && graph.length > 0)
    assert.ok(data.testResults.every(file => !file.message), 'No collection failures')
    for (const row of graph) assert.equal(sha(await readFile(resolve(root, row.file))), row.sha256)
    for (const row of rows) assert.equal(sha(await readFile(resolve(root, row.file))), row.originalSHA256)
    if (round.mutation) {
      assert.equal(round.exitCode, 1); assert.equal(tests.length, 1); assert.equal(data.numFailedTests, 1)
      assert.match(tests[0].failureMessages.join('\n'), /AssertionError:/)
      assert.ok(rows.some(row => row.mutation === round.mutation && row.loadedSHA256 !== row.originalSHA256), 'The changed original producer executed')
    } else {
      assert.equal(round.exitCode, 0); assert.equal(tests.length, 2); assert.equal(data.numFailedTests, 0)
      assert.ok(tests.every(test => test.status === 'passed'))
      for (const file of ['apps/mobile/src/main.tsx', 'apps/mobile/src/MobileApp.tsx', 'packages/core/src/relay-hosted.ts', 'packages/core/src/hosted-client.ts']) {
        assert.ok(rows.some(row => row.file === file), 'Actual original consumer executed: ' + file)
      }
    }
  }
  const related = JSON.parse(await artifact(author.related.report)); await artifact(author.related.loaded); await artifact(author.related.log)
  assert.equal(author.related.exitCode, 0); assert.equal(related.numFailedTests, 0); assert.equal(related.numPassedTests, 34)
  assert.equal(related.numPendingTests, 0)
  const build = await json('.tmp/mobile-exact-first-read/build.json')
  assert.equal(build.passed, true); assert.equal(build.typecheck.exitCode, 0); await current(build.source)
  assert.ok(build.staticChunks.length > 0 && !build.staticChunks.includes(build.appDynamicChunk))
  const release = await json('apps/mobile/dist/mobile-release.json'); assert.equal(release.digest, build.release.digest)
  assert.deepEqual(release.files.map(file => file.path).sort(), Object.keys(build.emitted).sort())
  for (const file of release.files) assert.equal('sha256:' + sha(await readFile(resolve(root, 'apps/mobile/dist', file.path))), file.digest)
  const accepted = await json('.tmp/mobile-exact-first-read/acceptance.json')
  const capture = JSON.parse(await artifact(accepted.capture)), review = JSON.parse(await artifact(accepted.review))
  assert.equal(capture.passed, true); await current(capture.source)
  assert.equal(review.verdict, 'deliverable'); assert.ok(review.reviewer && review.reviewer !== '/root')
  assert.deepEqual(review.capture, accepted.capture)
  assert.ok(Object.keys(capture.images).length >= 5)
  assert.deepEqual(Object.fromEntries(review.images.map(value => [value.file, value.sha256])), capture.images)
  for (const [file, digest] of Object.entries(capture.images)) assert.equal(sha(await readFile(resolve(root, file))), digest)
  assert.equal(capture.process.exitCode, 0); assert.equal(capture.restartProcess.exitCode, 0)
  assert.notEqual(capture.process.originalPid, capture.restartProcess.originalPid)
  assert.equal(capture.process.exitConfirmed, true); assert.equal(capture.restartProcess.exitConfirmed, true)
  await current(author.source); await current(build.source); await current(capture.source)
  result.passed = true
} catch (error) { result.error = { name: error.name, message: error.message }; process.exitCode = 1 }
finally { await writeFile(resolve(directory, 'gate.json'), JSON.stringify(result, null, 2) + '\n'); console.log('.tmp/mobile-exact-first-read/gate.json') }
