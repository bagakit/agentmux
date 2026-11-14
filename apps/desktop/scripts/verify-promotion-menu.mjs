import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
const root = resolve(import.meta.dirname, '../../..'), evidence = join(root, '.tmp/promotion-menu-refinement')
const files = [
 'apps/desktop/src/renderer/src/components/AgentMenuContent.tsx',
 'apps/desktop/src/renderer/src/components/TopicContextMenu.tsx',
 'apps/desktop/src/renderer/src/components/settings/TopicDirectorySettingsPane.tsx',
 'packages/client-ui/src/theme/icon-authored.ts', 'packages/client-ui/src/theme/icon-catalog.ts',
 'apps/desktop/test/agent-promotion-ui.test.tsx', 'apps/desktop/test/agent-promotion-settings.test.ts',
 'apps/desktop/test/promotion-menu.config.mts', 'apps/desktop/test/agent-promotion-ui.config.mts', 'apps/desktop/scripts/verify-promotion-menu.mjs',
 ...['entry.tsx', 'main.cjs', 'capture.mjs', 'scenario.md'].map(file => 'apps/desktop/scripts/fixtures/agent-promotion/' + file)
]
const mutants = ['language', 'topic-icon', 'shared-drawing']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const json = async file => JSON.parse(await readFile(file, 'utf8'))
const sources = async () => Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(join(root, file)))])))
const assertions = result => result.testResults.flatMap(suite => suite.assertionResults)
async function run(args, env = {}) {
 const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
 let stdout = '', stderr = ''; child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes)
 const code = await new Promise((yes, no) => { child.once('error', no); child.once('exit', yes) })
 return { code, stdout, stderr }
}
async function behavior(name, mutation) {
 const output = join(evidence, name + '-tests.json'), loaded = join(evidence, name + '-loaded.ndjson')
 await writeFile(loaded, '')
 const result = await run(['node_modules/vitest/vitest.mjs', 'run', '--config', 'apps/desktop/test/promotion-menu.config.mts',
  '--reporter=json', '--outputFile=' + output], { NO_COLOR: '1', PROMOTION_MENU_MUTANT: mutation ?? '', PROMOTION_MENU_LOADED: loaded })
 const log = result.stdout + result.stderr; await writeFile(join(evidence, name + '.log'), log)
 const tests = await json(output), cases = assertions(tests)
 assert.ok(cases.length > 0, 'The actual menu/settings suite is nonempty')
 assert.equal(tests.numPendingTests, 0)
 const traces = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
 assert.ok(traces.length > 0, 'Current production modules were actually loaded')
 const loadedSources = {}
 for (const trace of traces) {
  assert.equal(hash(await readFile(join(root, trace.path))), trace.originalSHA256, 'Loaded source matches this candidate: ' + trace.path)
  if (loadedSources[trace.path]) assert.equal(loadedSources[trace.path], trace.originalSHA256)
  loadedSources[trace.path] = trace.originalSHA256
 }
 if (!mutation) {
  assert.equal(result.code, 0, log); assert.equal(tests.numFailedTests, 0); assert.equal(tests.numPassedTests, cases.length)
  assert.ok(cases.every(test => test.status === 'passed'))
 } else {
  assert.notEqual(result.code, 0, 'Actual implementation mutation survived: ' + mutation)
  const failed = cases.filter(test => test.status === 'failed')
  assert.ok(failed.length > 0 && failed.every(test => test.failureMessages.some(message => message.startsWith('AssertionError:'))), 'Only owning assertion failures qualify')
  assert.ok(log.includes('PROMOTION_MENU_MUTANT_LOADED ' + mutation))
  assert.ok(traces.some(trace => trace.mutation === mutation && trace.originalSHA256 !== trace.loadedSHA256), 'The actual loaded implementation changed')
  assert.doesNotMatch(log, /ERR_MODULE_NOT_FOUND|Cannot find module|SyntaxError|No test files/u)
 }
 return { mutation: mutation ?? null, code: result.code, passed: tests.numPassedTests, failed: tests.numFailedTests,
  total: cases.length, testNames: cases.map(test => test.fullName).sort(), output, loaded, loadedSources }
}
function captured(visual) {
 assert.equal(visual.passed, true); assert.equal(visual.actual.passed, true)
 assert.equal(visual.captureSubset, 'promotion-settings-and-menus')
 assert.ok(visual.frames.length > 0, 'Actual Renderer frames are nonempty')
 assert.equal(new Set(visual.frames.map(frame => frame.file)).size, visual.frames.length)
}
await mkdir(evidence, { recursive: true })
if (process.argv.includes('--prepare') || process.argv.includes('--tests-only')) {
 const before = await sources(), baseline = await behavior('baseline'), results = []
 for (const mutation of mutants) {
  const changed = await behavior(mutation, mutation)
  assert.deepEqual(changed.testNames, baseline.testNames, 'Every mutation runs the same complete current suite')
  results.push(changed); console.log(mutation + ': owning assertion red')
 }
 for (const check of [baseline, ...results]) for (const [file, digest] of Object.entries(check.loadedSources))
  assert.equal(hash(await readFile(join(root, file))), digest, 'The loaded candidate changed during verification: ' + file)
 assert.deepEqual(await sources(), before, 'Verification cannot modify its source candidate')
 if (process.argv.includes('--tests-only')) {
  await writeFile(join(evidence, 'behavior.json'), JSON.stringify({ passed: true, baseline, results, sources: before,
   boundary: 'Behavior and loaded source mutations only. No Renderer capture or independent visual approval.' }, null, 2))
  console.log('Current menu/settings behavior: ' + baseline.total + ' tests; ' + results.length + ' loaded implementation mutations. No Renderer capture.')
 } else {
  const capture = await run(['apps/desktop/scripts/fixtures/agent-promotion/capture.mjs'])
  await writeFile(join(evidence, 'capture.log'), capture.stdout + capture.stderr)
  assert.equal(capture.code, 0, capture.stdout + capture.stderr)
  const latest = await json(join(root, '.tmp/agent-mote-promotion/latest-visual.json'))
  const visual = await json(join(root, latest.evidence, 'receipt.json')); captured(visual)
  assert.deepEqual(await sources(), before, 'Capture cannot modify its source candidate')
  await writeFile(join(evidence, 'prepared.json'), JSON.stringify({ passed: true, baseline, results, sources: before, visual: latest.evidence }, null, 2))
  console.log('Prepared current menu/settings candidate: ' + baseline.total + ' tests; ' + results.length + ' mutations; ' + visual.frames.length + ' actual frames.')
 }
} else {
 const prepared = await json(join(evidence, 'prepared.json')); assert.equal(prepared.passed, true)
 assert.deepEqual(await sources(), prepared.sources, 'The accepted menu/settings candidate changed')
 for (const check of [prepared.baseline, ...prepared.results]) for (const [file, digest] of Object.entries(check.loadedSources))
  assert.equal(hash(await readFile(join(root, file))), digest, 'Changed loaded production source: ' + file)
 const baseline = await json(prepared.baseline.output), cases = assertions(baseline)
 assert.ok(cases.length > 0); assert.equal(baseline.numFailedTests, 0); assert.equal(baseline.numPendingTests, 0)
 assert.ok(cases.every(test => test.status === 'passed')); assert.equal(baseline.numPassedTests, cases.length)
 assert.deepEqual(prepared.results.map(result => result.mutation), mutants)
 for (const result of prepared.results) {
  const report = await json(result.output), failed = assertions(report).filter(test => test.status === 'failed')
  assert.notEqual(result.code, 0); assert.equal(report.numPendingTests, 0)
  assert.deepEqual(assertions(report).map(test => test.fullName).sort(), prepared.baseline.testNames)
  assert.ok(failed.length > 0 && failed.every(test => test.failureMessages.some(message => message.startsWith('AssertionError:'))))
  const traces = (await readFile(result.loaded, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.ok(traces.some(trace => trace.mutation === result.mutation && trace.originalSHA256 !== trace.loadedSHA256))
 }
 const visual = await json(join(root, prepared.visual, 'receipt.json')); captured(visual)
 for (const frame of visual.frames) assert.equal(hash(await readFile(join(root, prepared.visual, frame.file))), frame.sha256)
 const review = await readFile(join(evidence, 'visual-review.md'), 'utf8')
 assert.match(review, /(?:Decision|结论):\s*(?:approved|可交付)/u); assert.ok(review.includes(prepared.visual))
 const receipt = { ...prepared, independentlyReviewed: true, boundary: visual.boundary }
 await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2))
 console.log('Promotion menus: ' + cases.length + ' current behavior tests, ' + mutants.length + ' loaded implementation mutations and ' + visual.frames.length + ' independently reviewed Renderer frames match this candidate.')
}
