import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// Consume exact task evidence; never replay an App, CLI, screenshot or typecheck producer.
const root = resolve(import.meta.dirname, '../../..'), directory = '.artifacts/browser-clean-capture/spatial-mote-defaults'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const production = ['packages/core/src/space-control.ts', 'packages/core/src/space-control-parser.ts']
const testFile = 'apps/desktop/test/spatial-mote-defaults.test.ts'
const owners = ['packages/core/src/mote/preferences.ts', 'apps/desktop/src/renderer/src/lib/mobile-presentation.ts',
  'apps/desktop/src/renderer/src/lib/space-agent-control.ts', 'packages/core/src/rpc-business-codec.ts']
const qualification = { passed: false, sourceQualified: false, installedQualified: false,
  boundary: 'Original Desktop producer/public catalog/fresh Source CLI on a private transport. No lifecycle, preference save, user page, Native capture or installed delivery claim.' }
async function bytes(ref) {
  assert.ok(ref && typeof ref.path === 'string' && /^[a-f0-9]{64}$/u.test(ref.sha256), 'Exact evidence reference required')
  const value = await readFile(resolve(root, ref.path)); assert.equal(sha(value), ref.sha256, ref.path); return value
}
const json = async ref => JSON.parse((await bytes(ref)).toString())
try {
  assert.equal(process.argv.length, 2)
  const evidencePath = directory + '/evidence.json', evidenceBytes = await readFile(resolve(root, evidencePath)), evidence = JSON.parse(evidenceBytes)
  assert.equal(evidence.schema, 'agentmux.spatial-mote-defaults.evidence.v1')
  const proof = await json(evidence.proof); assert.equal(proof.passed, true)
  for (const file of [...production, ...owners, testFile, 'apps/desktop/scripts/fixtures/spatial-mote-defaults/vitest.config.mts', 'apps/desktop/test/helpers/source-core-cli.mjs'])
    assert.equal(sha(await readFile(resolve(root, file))), proof.sources[file], 'Current original source: ' + file)
  assert.deepEqual(proof.runs.map(run => run.name), ['normal', 'old-whitelist', 'restored'])
  for (const run of proof.runs) {
    const report = await json(run.report), tests = report.testResults.flatMap(test => test.assertionResults).filter(test => !['pending', 'skipped'].includes(test.status))
    assert.equal(tests.length, 3, 'Nonempty original producer/public consumer/CLI')
    assert.deepEqual(run.assertions, tests.map(({ title, status }) => ({ title, status })))
    const loaded = (await bytes(run.loaded)).toString().trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    await bytes(run.log)
    for (const file of [...owners, testFile, production[1]]) assert.ok(loaded.some(row => row.file === file && row.original === proof.sources[file]), 'Original consumer loaded: ' + file)
    if (run.mutation) {
      assert.equal(run.exitCode, 1)
      assert.equal(run.mutation.file, production[1])
      assert.ok(tests.some(test => test.status === 'failed' && test.failureMessages.some(message => message.includes('Settings resource JSON is invalid'))), 'Legal owner data rejected through original business validator')
      assert.ok(loaded.some(row => row.file === run.mutation.file && row.mutated && row.loaded !== row.original), 'Obsolete whitelist actually loaded')
    } else {
      assert.equal(run.exitCode, 0); assert.equal(report.numPassedTests, 3); assert.ok(tests.every(test => test.status === 'passed'))
      const cli = await json(run.cli)
      for (const file of [production[1], owners[0], owners[3]]) assert.equal(cli.cli.inputs[file], proof.sources[file], 'Fresh Source CLI: ' + file)
      assert.ok(loaded.every(row => !row.mutated))
    }
  }
  const review = await json(evidence.review)
  assert.equal(review.accepted, true); assert.deepEqual(review.mustFix, [])
  for (const file of [...production, testFile, 'apps/desktop/scripts/fixtures/spatial-mote-defaults/vitest.config.mts']) assert.equal(review.sources[file], proof.sources[file])
  const types = await json(evidence.types)
  for (const file of [...production, testFile]) {
    assert.ok(types.loaded.some(row => row.file === file && row.sha256 === proof.sources[file]), 'Current typed source: ' + file)
    assert.ok(!types.all.some(diagnostic => diagnostic.file === file), 'No affected type diagnostic: ' + file)
  }
  Object.assign(qualification, { passed: true, sourceQualified: true, normal: 3, bearingMutations: 1, restored: 3,
    evidence: { path: evidencePath, sha256: sha(evidenceBytes) } })
} catch (error) { qualification.failure = { message: error.message, stack: error.stack }; process.exitCode = 1 }
await writeFile(resolve(root, directory + '/qualification.json'), JSON.stringify(qualification, null, 2) + '\n')
console.log(JSON.stringify({ passed: qualification.passed, installedQualified: false, failure: qualification.failure?.message }))
