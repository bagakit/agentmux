import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const evidence = join(root, ".tmp/session-recovery-context-fixture")
const slice = process.argv[process.argv.indexOf('--slice') + 1]
assert.ok(['source', 'review'].includes(slice), 'Use --slice source|review')
await mkdir(evidence, { recursive: true })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const config = 'apps/desktop/scripts/fixtures/session-recovery-context/vitest.config.mts'
const uiTests = ['apps/desktop/test/session-recap.test.tsx', 'apps/desktop/test/session-connecting-surface.test.tsx']
const product = [
  'apps/desktop/src/renderer/src/components/SessionRecap.tsx',
  'apps/desktop/src/renderer/src/components/SessionConnectingSurface.tsx',
  'apps/desktop/src/renderer/src/components/SessionPane.tsx',
  'apps/desktop/src/renderer/src/styles/session-recap.css',
  'packages/core/src/types.ts', 'packages/core/src/session-history.ts',
  'packages/core/src/native-jsonl-history-reader.ts', 'packages/core/src/providers/claude-native-history.ts'
]
async function fingerprints(paths) {
  return Object.fromEntries(await Promise.all(paths.map(async path => [path, hash(await readFile(join(root, path)))])))
}
async function checkInputs(inputs) {
  assert.ok(Object.keys(inputs).length > 0, 'Empty candidate identity')
  for (const [path, sha] of Object.entries(inputs)) assert.equal(hash(await readFile(join(root, path))), sha, `Changed input: ${path}`)
}
async function runTests(name, mutation, filter) {
  const output = join(evidence, `${name}.json`), loaded = join(evidence, `${name}-loaded.jsonl`)
  await writeFile(loaded, '')
  const args = ['node_modules/vitest/vitest.mjs', 'run', '--config', config, '--maxWorkers=1', ...uiTests,
    '--reporter=json', `--outputFile=${output}`, ...(filter ? ['-t', filter] : [])]
  const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env,
    AGENTMUX_CONTEXT_MUTATION: mutation ?? '', AGENTMUX_CONTEXT_LOADED: loaded }, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log += bytes })
  const code = await new Promise((done, fail) => { child.once('error', fail); child.once('exit', (code, signal) => signal ? fail(new Error(signal)) : done(code)) })
  const logPath = join(evidence, `${name}.log`); await writeFile(logPath, log)
  const report = await json(output), modules = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.ok(modules.length && report.numTotalTests > 0, 'No actual modules or tests')
  if (mutation) {
    assert.notEqual(code, 0)
    assert.ok(report.testResults.filter(result => result.status === 'failed').every(result => result.assertionResults.some(item => item.status === 'failed')), 'Mutation failed outside an assertion')
    const assertions = report.testResults.flatMap(result => result.assertionResults)
    assert.ok(assertions.some(result => result.status === 'failed' && result.failureMessages.some(message => /AssertionError/.test(message))), 'No causal assertion RED')
    assert.ok(modules.some(module => module.mutation === mutation && module.sourceSHA256 !== module.loadedSHA256), 'Mutant not actually loaded')
  } else { assert.equal(code, 0, log.slice(-3000)); assert.equal(report.success, true); assert.equal(report.numFailedTests, 0) }
  return { name, mutation, code, testsPassed: report.numPassedTests, testsFailed: report.numFailedTests,
    report: output, reportSHA256: hash(await readFile(output)), loaded, loadedSHA256: hash(await readFile(loaded)),
    log: logPath, logSHA256: hash(await readFile(logPath)) }
}

if (slice === 'source') {
  const inputs = await fingerprints([...product, ...uiTests, config, 'packages/core/test/session-recovery-context.test.ts'])
  const priorPath = join(evidence, 'source.json')
  try {
    const prior = await json(priorPath)
    await checkInputs(prior.inputs)
    assert.deepEqual(prior.inputs, inputs); assert.equal(prior.passed, true)
    assert.equal(hash(await readFile(join(evidence, 'core/receipt.json'))), prior.coreReceiptSHA256)
    for (const run of prior.runs) for (const key of ['report', 'loaded', 'log']) assert.equal(hash(await readFile(run[key])), run[`${key}SHA256`])
    console.log('Consumed current source qualification.'); process.exit(0)
  } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ERR_ASSERTION') throw error }
  const corePath = join(evidence, 'core/receipt.json'), core = await json(corePath)
  assert.equal(core.passed, true)
  await checkInputs(Object.fromEntries(core.source.map(file => [file.path, file.afterSHA256])))
  for (const run of [core.baseline, ...core.mutants, core.restored]) {
    assert.equal(hash(await readFile(join(root, run.report))), run.sha256)
    assert.ok(run.totalTests > 0)
  }
  assert.equal(core.baseline.success, true); assert.equal(core.restored.success, true)
  assert.ok(core.mutants.length > 0 && core.mutants.every(run => run.failedAssertions.some(item => item.failureMessages.some(message => /AssertionError/.test(message)))))
  assert.equal(hash(await readFile(join(root, core.productionCallers.path))), core.productionCallers.sha256)
  assert.ok(core.productionCallers.nonempty && core.productionCallers.count > 0)
  const runs = [await runTests('ui-baseline')]
  for (const [mutation, filter] of [
    ['wrong-host', 'passes the actual recovery Host'],
    ['fake-time', 'does not invent total counts'],
    ['page-as-total', 'shares one bounded native page'],
    ['foreign-capture', 'does not use an old Host capture']
  ]) runs.push(await runTests(`ui-${mutation}`, mutation, filter))
  runs.push(await runTests('ui-restored'))
  await checkInputs(inputs)
  const callerSpecs = [
    ['apps/desktop/src/renderer/src/components/SessionPane.tsx', '<SessionConnectingSurface'],
    ['apps/desktop/src/renderer/src/components/SessionPane.tsx', '<SessionRecap'],
    ['apps/desktop/src/renderer/src/components/SessionConnectingSurface.tsx', '<SessionRecap'],
    ['packages/core/src/client.ts', 'normalizeSessionHistoryPage'],
    ['packages/core/src/providers/claude-native-history.ts', 'reader.sourceSizeBytes']
  ]
  const callers = []
  for (const [path, symbol] of callerSpecs) {
    const text = await readFile(join(root, path), 'utf8')
    text.split('\n').forEach((line, index) => { if (line.includes(symbol)) callers.push({ path, line: index + 1, text: line.trim() }) })
    assert.ok(callers.some(caller => caller.path === path && caller.text.includes(symbol)), `Missing production caller: ${path} ${symbol}`)
  }
  assert.ok(callers.length >= callerSpecs.length)
  await writeFile(priorPath, JSON.stringify({ passed: true, inputs, runs, callers, coreReceiptSHA256: hash(await readFile(corePath)) }, null, 2) + '\n')
  console.log(`Qualified ${runs[0].testsPassed} UI tests, 4 actual assertion mutants, restored GREEN and ${callers.length} production callers; consumed Core proof.`)
} else {
  const scenePath = join(evidence, 'presentation.json'), scene = await json(scenePath)
  assert.equal(scene.passed, true); assert.equal(scene.userRuntimeTouched, false); assert.equal(scene.exit.code, 0)
  await checkInputs(scene.inputsAfter); assert.deepEqual(scene.inputsBefore, scene.inputsAfter)
  const reviewPath = join(evidence, 'independent-visual-review.json'), review = await json(reviewPath)
  assert.equal(review.conclusion, 'accepted'); assert.ok(review.reviewer && review.reviewer !== '/root')
  assert.equal(review.presentationSHA256, hash(await readFile(scenePath)))
  assert.deepEqual(review.unresolvedMustFix, []); assert.equal(scene.images.length, 13); assert.equal(review.images.length, scene.images.length)
  for (const frame of scene.images) {
    assert.equal(hash(await readFile(frame.path)), frame.sha256)
    assert.ok(review.images.some(image => image.path === frame.path && image.sha256 === frame.sha256 && image.viewed === true), `Full frame not independently viewed: ${frame.label}`)
  }
  const source = await json(join(evidence, 'independent-source-review.json'))
  assert.equal(source.conclusion, 'accepted'); assert.deepEqual(source.unresolvedMustFix, []); await checkInputs(source.inputs)
  console.log('Consumed exact 13 full native Electron frames and independent source/visual acceptance. No lifecycle or installed-package claim.')
}
