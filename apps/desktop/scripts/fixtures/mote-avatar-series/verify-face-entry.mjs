import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

const fixture = import.meta.dirname, root = path.resolve(fixture, '../../../../..')
const execute = promisify(execFile)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const reference = async file => ({ path: file, sha256: sha(await fs.readFile(file)) })
const cases = [
  { scope: 'face-entry-delta', exitCode: 0, expectedSeedCalls: 1 },
  { scope: 'restoreduplicate', exitCode: 1, expectedSeedCalls: 0, assertion: 'Fresh Series must hide bundled face2d duplicates while retaining image and GLB choices' },
  { scope: 'lose-saved-entry', exitCode: 1, expectedSeedCalls: 1, assertion: 'The exact saved bundled face entry must remain visible and selected after reopening' },
  { scope: 'missing-face-layout', exitCode: 1, expectedSeedCalls: 0, assertion: 'Exported face PNG must retain the center preview eyebrow, eye and mouth ink geometry' },
]
function validateActual(actual, test) {
  assert.equal(actual.scope, 'face-entry-delta')
  assert.ok(actual.process, 'The actual product process must run; setup failures do not prove a mutation')
  assert.equal(actual.process.exitCode, test.exitCode)
  assert.deepEqual(actual.sourceDrift, [], 'The real captured product source must remain fixed')
  for (const file of ['apps/desktop/src/renderer/src/components/SpaceIconPicker.tsx',
    'apps/desktop/src/renderer/src/components/MoteAvatarSeriesEditor.tsx',
    'apps/desktop/src/main/mote-avatar-writer.ts', 'apps/desktop/src/preload/index.ts']) assert.ok(actual.source[file], 'Missing original product source: ' + file)
  assert.equal(actual.renderer.saveCalls.length, 0, 'The GUI must not send Save in this readonly selection scope')
  assert.equal(actual.renderer.writes, 0)
  assert.equal(actual.renderer.flushRequests.length, 0)
  assert.equal(actual.renderer.themeFacts.spriteCount, 1)
  assert.equal(actual.renderer.themeFacts.unresolvedSemanticUses.length, 0)
  assert.ok(actual.renderer.themeFacts.nativeSelectImage.includes('data:image/svg+xml'))
  assert.equal(actual.passed, test.exitCode === 0)
  assert.equal(actual.renderer.passed, test.exitCode === 0)
  if (test.exitCode === 0) {
    assert.equal(actual.renderer.faceEntry.seedCalls, 1)
    assert.equal(actual.renderer.faceEntry.sameSavedAfterCancel, true)
    assert.deepEqual(actual.renderer.facePixelFacts.map(value => value.name), ['user-preset', 'saved-bundled-preset'])
    assert.ok(actual.renderer.facePixelFacts.every(value => value.parts.every(part => part.geometryMatched)))
    assert.equal(Object.keys(actual.images).length, 4, 'This bounded scope must capture exactly four original full product images')
  } else {
    assert.equal(actual.mutation.id, test.scope)
    assert.ok(actual.renderer.error.message.includes(test.assertion), 'The production mutant must fail its fixed intended business assertion')
  }
  assert.equal(actual.renderer.seedCalls.length, test.expectedSeedCalls)
  if (test.expectedSeedCalls === 1) {
    assert.equal(actual.renderer.seedCalls[0].value.state, 'saved', 'Loss must be detected after the genuine native saved seed')
    assert.equal(actual.renderer.seedCalls[0].value.operation.durability, 'confirmed')
  }
  if (test.scope === 'missing-face-layout') assert.ok(actual.renderer.facePixelFacts.some(value => value.parts.some(part => !part.geometryMatched)))
}
if (process.argv[2] === '--recorded') {
  assert.equal(process.argv.length, 4, 'Use --recorded with the original successful receipt path')
  const file = path.resolve(process.argv[3]), original = JSON.parse(await fs.readFile(file, 'utf8'))
  assert.equal(original.schema, 'agentmux.face-entry-product-verification.v1'); assert.equal(original.passed, true)
  const required = ['apps/desktop/src/renderer/src/components/SpaceIconPicker.tsx',
    'apps/desktop/src/renderer/src/components/MoteAvatarSeriesEditor.tsx',
    'apps/desktop/src/main/mote-avatar-writer.ts', 'apps/desktop/src/preload/index.ts',
    ...['editor-entry.tsx', 'editor-main.cjs', 'editor-capture.mjs', 'verify-face-entry.mjs'].map(name => path.relative(root, path.join(fixture, name)))]
  for (const source of required) assert.match(original.source[source] ?? '', /^[a-f0-9]{64}$/, 'Missing recorded product source: ' + source)
  for (const [source, expected] of Object.entries(original.source)) assert.equal(sha(await fs.readFile(path.resolve(root, source))), expected, 'Recorded product source drift: ' + source)
  assert.deepEqual(original.runs.map(run => run.scope), cases.map(test => test.scope))
  let baseline
  for (const [index, run] of original.runs.entries()) {
    assert.equal((await reference(run.receipt.path)).sha256, run.receipt.sha256)
    const actual = JSON.parse(await fs.readFile(run.receipt.path, 'utf8'))
    validateActual(actual, cases[index])
    for (const [source, expected] of Object.entries(actual.source)) {
      assert.equal(expected, original.source[source], 'Raw source/summary mismatch: ' + source)
      assert.equal(sha(await fs.readFile(path.resolve(root, source))), expected, 'Raw source drift: ' + source)
    }
    if (index === 0) baseline = actual
  }
  assert.equal(Object.keys(original.images).length, 4)
  assert.deepEqual(Object.keys(original.images).sort(), Object.keys(baseline.images).sort())
  for (const [name, expected] of Object.entries(baseline.images)) {
    const image = original.images[name]
    assert.equal(path.resolve(image.path), path.resolve(baseline.directory, name))
    assert.equal(image.sha256, expected)
    assert.equal((await reference(image.path)).sha256, expected)
  }
  console.log(file)
  process.exit(0)
}
assert.equal(process.argv.length, 2, 'Use no arguments for a new probe, or --recorded RECEIPT for the same source-bound evidence')
const directory = path.join(root, ".local/state/mote-avatar-entry-dedup/evidence", randomUUID())
await fs.mkdir(directory, { recursive: true })
const receipt = { schema: 'agentmux.face-entry-product-verification.v1', passed: false,
  aestheticReview: 'not-performed', source: {}, runs: [], images: {},
  boundary: 'Original production Picker/SeriesEditor, default API and production preload consume actual isolated Main source/writer owners. One actual native seed is distinct from zero GUI saves. No live App/Session, installed-package, full durable-chain replay or aesthetic approval claim.' }
try {
  for (const name of ['editor-main.cjs', 'editor-capture.mjs', 'verify-face-entry.mjs']) {
    const file = path.join(fixture, name)
    receipt.source[path.relative(root, file)] = sha(await fs.readFile(file))
  }
  for (const test of cases) {
    let processResult
    try {
      const actual = await execute(process.execPath, [path.join(fixture, 'editor-capture.mjs'), test.scope],
        { cwd: root, env: process.env, timeout: 120_000, killSignal: 'SIGTERM', maxBuffer: 4 * 1024 * 1024 })
      processResult = { exitCode: 0, stdout: actual.stdout, stderr: actual.stderr }
    } catch (error) {
      processResult = { exitCode: error.code, signal: error.signal ?? null, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
    }
    await fs.writeFile(path.join(directory, test.scope + '.log'), processResult.stdout + '\n' + processResult.stderr)
    const file = processResult.stdout.trim().split('\n').findLast(line => line.startsWith(root + '/.local/state/') && line.endsWith('/receipt.json'))
    assert.ok(file, 'The actual product capture must emit its original receipt')
    const actual = JSON.parse(await fs.readFile(file, 'utf8'))
    const row = { scope: test.scope, expectedExitCode: test.exitCode, exitCode: processResult.exitCode,
      receipt: await reference(file), directory: actual.directory, rendererPid: actual.renderer?.pid,
      mutation: actual.mutation ?? null, assertion: test.assertion ?? null,
      actualFailure: actual.renderer?.error?.message ?? null }
    receipt.runs.push(row)
    assert.equal(processResult.exitCode, test.exitCode, actual.error?.message)
    validateActual(actual, test)
    if (test.exitCode === 0) {
      Object.assign(receipt.source, actual.source)
      for (const [name, expected] of Object.entries(actual.images)) {
        const image = await reference(path.join(actual.directory, name))
        assert.equal(image.sha256, expected)
        receipt.images[name] = image
      }
    } else {
      row.detected = true
    }
    console.log(test.scope + ': ' + (test.exitCode === 0 ? 'actual product passed' : 'intended production mutation detected'))
  }
  receipt.sourceDrift = []
  for (const [file, expected] of Object.entries(receipt.source)) {
    if (sha(await fs.readFile(path.resolve(root, file))) !== expected) receipt.sourceDrift.push(file)
  }
  assert.deepEqual(receipt.sourceDrift, [], 'The final source-bound verification cannot promote drifting source')
  receipt.passed = true
} catch (error) { receipt.error = { message: error.message, stack: error.stack } }
receipt.directory = directory
await fs.writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log(path.join(directory, 'receipt.json'))
if (!receipt.passed) { console.error(receipt.error); process.exitCode = 1 }
