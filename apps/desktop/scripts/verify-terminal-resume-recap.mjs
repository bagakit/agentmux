import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const directory = join(root, '.tmp/terminal-resume-recap')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const slice = process.argv[process.argv.indexOf('--slice') + 1]
assert.ok(['source', 'scene', 'review'].includes(slice), 'Use --slice source|scene|review')
await mkdir(directory, { recursive: true })
async function run(command, args, env = {}) {
  const child = spawn(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: 'inherit' })
  const code = await new Promise((done, fail) => { child.on('error', fail); child.on('exit', (code, signal) => signal ? fail(new Error(`${command} ended by ${signal}`)) : done(code)) })
  assert.equal(code, 0, `${command} ${args.join(' ')} failed`)
}
async function json(path) { return JSON.parse(await readFile(path, 'utf8')) }
async function currentInputs(scene) {
  assert.ok(Object.keys(scene.inputsAfter).length > 0, 'Scene must bind nonempty source and compiled inputs')
  for (const [path, expected] of Object.entries(scene.inputsAfter)) assert.equal(sha(await readFile(path)), expected, `Candidate changed: ${path}`)
}
if (slice === 'source') {
  const tests = ['session-recap', 'full-page-loading-surface', 'session-native-history-surface', 'terminal-history-wheel'].map(name => `apps/desktop/test/${name}.test.tsx`)
  const testReport = join(directory, 'tests.json')
  await run('pnpm', ['exec', 'vitest', 'run', '--maxWorkers=1', ...tests, '--reporter=json', `--outputFile=${testReport}`])
  const report = await json(testReport)
  assert.equal(report.success, true)
  assert.ok(report.numPassedTests >= 44, 'Real mounted consumers and bounded history tests must all be collected')
  assert.equal(report.numFailedTests, 0)
  const callers = []
  for (const name of ['SessionPane', 'TerminalView']) {
    const path = `apps/desktop/src/renderer/src/components/${name}.tsx`
    const source = await readFile(join(root, path), 'utf8')
    const lines = source.split('\n').flatMap((line, i) => line.includes('<SessionRecap ') && line.includes('supplement=') ? [{ path, line: i + 1, text: line.trim() }] : [])
    assert.ok(lines.length > 0, `${name} must consume the real component, excluding imports and definitions`)
    callers.push(...lines)
  }
  await run(process.execPath, ['apps/desktop/scripts/fixtures/terminal-resume-recap/source-mutations.mjs'])
  const mutationPath = join(directory, 'source-mutations.json')
  const mutations = await json(mutationPath)
  assert.equal(mutations.passed, true, 'Production assertion RED and exact restoration GREEN required')
  await writeFile(join(directory, 'source.json'), JSON.stringify({ passed: true, testReportSha256: sha(await readFile(testReport)), testsPassed: report.numPassedTests, callers, mutationReceiptSha256: sha(await readFile(mutationPath)) }, null, 2) + '\n')
  process.stdout.write(`Recap source passed: ${report.numPassedTests} tests, ${callers.length} real product callers and finite production mutations.\n`)
} else if (slice === 'scene') {
  const receipt = join(directory, 'scene.json')
  await run(process.execPath, ['apps/desktop/scripts/fixtures/terminal-resume-recap/scene.mjs'], { AGENTMUX_VERIFY_RECEIPT: receipt })
  const scene = await json(receipt)
  assert.equal(scene.passed, true)
  assert.equal(scene.userRuntimeTouched, false)
  assert.equal(scene.cleanup.rootRemoved, true)
  assert.deepEqual(scene.cleanup.remaining, [])
  assert.ok(Object.keys(scene.loadedAfter).length > 0)
  await currentInputs(scene)
  process.stdout.write('Private GUI scene passed; screenshots await independent visual review.\n')
} else {
  // A reviewer opens the actual PNGs and writes this independent receipt. Capturing
  // a frame, DOM facts or this verifier succeeding cannot manufacture that review.
  const scenePath = join(directory, 'scene.json'), reviewPath = join(directory, 'review.json')
  const sceneBytes = await readFile(scenePath), scene = JSON.parse(sceneBytes)
  assert.equal(scene.passed, true)
  await currentInputs(scene)
  let review
  const waitUntil = Date.now() + 180_000
  // The independent reviewer may be opening this newly captured scene while the
  // sequential task gate reaches its final step. Time never supplies a verdict.
  while (Date.now() < waitUntil) {
    try { const candidate = await json(reviewPath); if (candidate.sceneSha256 === sha(sceneBytes)) { review = candidate; break } }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    await new Promise(done => setTimeout(done, 1000))
  }
  assert.ok(review, 'No independent review bound to this exact scene arrived')
  assert.equal(review.schema, 'agentmux.terminal-resume-recap-review.v1')
  assert.equal(review.verdict, 'satisfied')
  assert.equal(review.actualImagesOpened, true)
  assert.ok(review.reviewedBy && review.reviewedBy !== '/root')
  assert.equal(review.sceneSha256, sha(sceneBytes), 'Review must describe this exact scene')
  const screenshots = Object.entries(scene).filter(([key, value]) => key.startsWith('screenshot') && value?.path)
  assert.ok(screenshots.length >= 5, 'Normal, narrow, unavailable, restart and resuming frames required')
  assert.equal(review.images.length, screenshots.length)
  for (const [key, frame] of screenshots) {
    assert.equal(sha(await readFile(frame.path)), frame.sha256, `${key} bytes changed`)
    assert.ok(review.images.some(image => image.path === frame.path && image.sha256 === frame.sha256 && image.opened === true), `${key} was not actually reviewed`)
  }
  const reportBytes = await readFile(resolve(root, review.reportPath))
  assert.ok(reportBytes.length > 0)
  assert.equal(sha(reportBytes), review.reportSha256)
  process.stdout.write(`Independent visual review passed: ${review.reviewedBy}, ${screenshots.length} exact frames.\n`)
}
