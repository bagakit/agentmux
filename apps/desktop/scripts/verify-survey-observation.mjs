import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// One task-local evidence consumer. No App, CLI, Native or typecheck producer is run here.
const root = resolve(import.meta.dirname, '../../..'), directory = '.artifacts/browser-clean-capture/survey-observation'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const production = ['packages/core/src/control.ts', 'apps/desktop/src/shared/desktop-focus-observation.ts', 'apps/desktop/src/shared/client-observation.ts']
const testFile = 'apps/desktop/test/survey-tab-composition.test.tsx'
const originalGuards = ['packages/core/src/desktop-focus-parser.ts', 'packages/core/src/survey-organization.ts', 'packages/core/src/settings-resource-json.ts',
  'apps/desktop/src/main/client-observation.ts', 'apps/desktop/src/main/control-ipc-bridge.ts', 'apps/desktop/src/renderer/src/store.ts',
  'apps/desktop/src/renderer/src/App.tsx', 'apps/desktop/src/renderer/src/lib/desktop-focus-navigation.ts', 'apps/desktop/src/renderer/src/lib/desktop-presentation.ts',
  'apps/desktop/src/renderer/src/lib/survey-page-references.ts']
const mutations = ['missing-desktop-survey', 'old-expanded-page-union', 'bypass-core-codec', 'drop-observed-choice']
const receipt = { passed: false, sourceQualified: false, nativeQualified: false, installedQualified: false,
  boundary: 'T003 actual private Source CLI/App/Core/Main strict observation and original ControlBridge. Browser transport/Session paint remain controlled. No Native PNG, OS focus, original business page, installed observation or field Space/Mote-fix claim.' }
async function ref(value) {
  assert.ok(value && typeof value.path === 'string' && /^[a-f0-9]{64}$/u.test(value.sha256), 'An immutable evidence reference is required')
  const bytes = await readFile(resolve(root, value.path)); assert.equal(sha(bytes), value.sha256, 'Evidence bytes: ' + value.path)
  return bytes
}
const json = async value => JSON.parse((await ref(value)).toString())
const assertions = report => report.testResults.flatMap(test => test.assertionResults).filter(test => !['pending', 'skipped'].includes(test.status))
const graph = async value => { const rows = (await ref(value)).toString().trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); assert.ok(rows.length > 0); return rows }
async function listener(value) {
  const rows = await graph(value)
  assert.ok(rows.some(row => row.kind === 'fork' && row.source.endsWith('/packages/core/src/control-endpoint-listener-worker.ts')))
  assert.ok(rows.some(row => row.kind === 'message' && row.identity && row.hasHandle))
  const restored = rows.filter(row => row.kind === 'restored')
  assert.ok(restored.length > 0 && restored.every(row => row.restored === true && row.observed.every(call => call.identity)))
}
try {
  assert.equal(process.argv.length, 2, 'Run without arguments; producers are never replayed')
  const path = directory + '/evidence.json', bytes = await readFile(resolve(root, path)), evidence = JSON.parse(bytes)
  assert.equal(evidence.schema, 'agentmux.survey-observation.evidence.v1')
  const proof = await json(evidence.proof), join = await json(evidence.currentJoin)
  assert.equal(proof.passed, true); assert.equal(join.passed, true)
  for (const file of [...production, ...originalGuards, testFile, 'packages/core/src/space-control-parser.ts', 'packages/core/src/public-rpc-service.ts',
    'apps/desktop/test/desktop-map-presentation.test.ts', 'apps/desktop/test/helpers/source-core-cli.mjs',
    'apps/desktop/scripts/fixtures/survey-observation/vitest.config.mts', 'apps/desktop/scripts/fixtures/survey-page-cli/vitest.config.mts']) {
    assert.match(join.sources[file] ?? '', /^[a-f0-9]{64}$/u, 'Expected actual source: ' + file)
  }
  for (const [file, expected] of Object.entries(join.sources)) assert.equal(sha(await readFile(resolve(root, file))), expected, 'Current Source join: ' + file)
  // The later join adds the original Host RPC port. The actual strict owners/guards remain the bearing candidate.
  for (const file of [...production, ...originalGuards]) assert.equal(join.sources[file], proof.sources[file], 'Same original schema/guard owner: ' + file)
  const delta = await json(join.fixtureDelta), currentTest = await readFile(resolve(root, testFile), 'utf8')
  assert.equal(delta.file, testFile); assert.equal(delta.beforeSha256, proof.sources[testFile]); assert.equal(delta.afterSha256, join.sources[testFile])
  assert.equal(currentTest.split(delta.after).length, 2); assert.equal(sha(currentTest.replace(delta.after, delta.before)), delta.beforeSha256)
  assert.ok(delta.before.startsWith('async function withObservedSurveyCli(') && delta.after.startsWith('async function withObservedSurveyCli('))
  assert.ok(!delta.before.includes("it('[survey-observation]") && !delta.after.includes("it('[survey-observation]"), 'Only the private port changes, never assertion bodies')

  assert.deepEqual(proof.runs.map(run => run.name), ['green', ...mutations, 'restored'])
  for (const run of proof.runs) {
    const report = await json(run.report), tests = assertions(report), loaded = await graph(run.loaded)
    await ref(run.log); assert.ok(tests.length > 0)
    assert.deepEqual(run.assertions, tests.map(({ title, status }) => ({ title, status })))
    if (run.mutation) {
      assert.equal(run.exitCode, 1)
      assert.ok(tests.some(test => test.status === 'failed' && test.failureMessages.some(message => message.includes('AssertionError'))), 'Actual business assertion red: ' + run.name)
      assert.ok(loaded.some(row => row.file === run.mutation.file && row.original === proof.sources[row.file] && row.mutated === true && row.loaded !== row.original), 'Original mutated source loaded: ' + run.name)
    } else {
      assert.equal(run.exitCode, 0); assert.equal(report.numFailedTests, 0); assert.equal(tests.length, 5); assert.ok(tests.every(test => test.status === 'passed'))
      for (const file of [...production, ...originalGuards, testFile]) assert.ok(loaded.some(row => row.file === file && row.original === proof.sources[file] && !row.mutated), 'Original consumer loaded: ' + file)
      const cli = await json(run.cli)
      for (const file of ['packages/core/src/control.ts', 'packages/core/src/desktop-focus-parser.ts', 'packages/core/src/survey-organization.ts']) assert.equal(cli.cli.inputs[file], proof.sources[file])
      await listener(run.listener)
    }
  }
  const joined = await json(join.report), joinedTests = assertions(joined), joinedLoaded = await graph(join.loaded)
  assert.equal(joined.numFailedTests, 0); assert.equal(joinedTests.length, 3)
  assert.ok(joinedTests.every(test => test.status === 'passed' && test.title.startsWith('[survey-observation] actual')))
  for (const file of [...production, ...originalGuards, testFile, 'packages/core/src/space-control-parser.ts', 'packages/core/src/public-rpc-service.ts'])
    assert.ok(joinedLoaded.some(row => row.file === file && row.original === join.sources[file] && !row.mutated), 'Current Main/Host consumer loaded: ' + file)
  const currentCli = await json(join.cli)
  for (const file of Object.keys(join.sources).filter(file => file.startsWith('packages/core/src/'))) assert.equal(currentCli.cli.inputs[file], join.sources[file], 'Original fresh CLI/Core join: ' + file)
  await listener(join.listener); await ref(join.log)

  const before = await json(evidence.before), failures = assertions(before).filter(test => test.status === 'failed')
  assert.equal(failures.length, 3)
  assert.ok(failures.some(test => test.failureMessages.some(message => message.includes('Unrecognized key') && message.includes('survey'))))
  const review = await json(evidence.review)
  assert.equal(review.accepted, true); assert.deepEqual(review.mustFix, [])
  for (const file of production) assert.equal(review.sources[file], join.sources[file], 'Independent current source review: ' + file)

  const types = await json(evidence.types.report)
  assert.ok(Array.isArray(types.owned) && Array.isArray(types.all) && Array.isArray(types.loaded))
  for (const file of [...production, testFile]) {
    assert.ok(types.loaded.some(row => row.file === file && row.sha256 === join.sources[file]), 'Actual current typed source: ' + file)
    assert.ok(!types.all.some(diagnostic => diagnostic.file === file), 'No affected production/test diagnostic: ' + file)
  }
  if (types.owned.length) {
    const baseline = await json(evidence.types.baselineBinding)
    assert.match(baseline.baseHead, /^[a-f0-9]{40}$/u); assert.ok(Array.isArray(baseline.rows))
    const current = await readFile(resolve(root, baseline.file), 'utf8')
    const original = execFileSync('git', ['show', `${baseline.baseHead}:${baseline.file}`], { cwd: root, encoding: 'utf8' })
    assert.equal(sha(current), baseline.currentFileSHA256); assert.equal(sha(original), baseline.baseFileSHA256)
    const signature = row => JSON.stringify({ file: row.file, code: row.code, line: row.line, message: row.message })
    assert.deepEqual(types.owned.map(signature).sort(), baseline.rows.map(signature).sort())
    for (const row of baseline.rows) {
      assert.equal(row.file, baseline.file)
      assert.equal(sha(current.split('\n')[row.line - 1]), row.lineSHA256); assert.equal(sha(original.split('\n')[row.originalLine - 1]), row.lineSHA256)
    }
  }
  Object.assign(receipt, { passed: true, sourceQualified: true, evidence: { path, sha256: sha(bytes) }, normal: 5, bearingMutations: 4, restored: 5, currentMainCoreJoin: 3, introducedDiagnostics: 0 })
} catch (error) { receipt.failure = { message: error.message, stack: error.stack }; process.exitCode = 1 }
const output = resolve(root, directory + '/qualification.json')
await writeFile(output, JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify({ passed: receipt.passed, sourceQualified: receipt.sourceQualified, nativeQualified: false, installedQualified: false, receipt: output, failure: receipt.failure?.message }))
