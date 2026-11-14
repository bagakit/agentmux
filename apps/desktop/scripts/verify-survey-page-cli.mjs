import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// Consume immutable T002 evidence. Capture pixels and installed delivery belong to the Feature join.
const root = resolve(import.meta.dirname, '../../..')
const index = resolve(root, '.artifacts/browser-clean-capture/survey-evidence.json')
const output = resolve(root, '.artifacts/browser-clean-capture/survey-qualification.json')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const receipt = { passed: false, sourceQualified: false, pngQualified: false, installedQualified: false,
  boundary: 'T002 original creation, exact registration, selection and discovery only. Real App/Core and Source CLI; Browser/Session paint and Native transport controlled. No Native pixels, OS focus, user work or installed-delivery claim.' }
async function referenced(ref) {
  assert.ok(ref && typeof ref.path === 'string' && /^[a-f0-9]{64}$/u.test(ref.sha256), 'An immutable evidence reference is required')
  const bytes = await readFile(resolve(root, ref.path))
  assert.equal(sha(bytes), ref.sha256, 'Evidence bytes: ' + ref.path)
  return { bytes, json: () => JSON.parse(bytes.toString()) }
}
try {
  assert.equal(process.argv.length, 2, 'Run without arguments; this verifier never reruns producers')
  const raw = await readFile(index), evidence = JSON.parse(raw)
  assert.equal(evidence.schema, 'agentmux.survey-page-cli.evidence.v1')
  const proof = (await referenced(evidence.sourceProof)).json()
  assert.equal(proof.passed, true)
  const requiredOwners = ['packages/core/src/control.ts', 'packages/core/src/control-codec.ts', 'packages/core/src/desktop-focus-control.ts',
    'packages/core/src/desktop-focus-parser.ts', 'packages/core/src/survey-organization.ts', 'packages/core/src/space-control-parser.ts',
    'packages/core/src/rpc-business-codec.ts', 'packages/core/src/agentmux-cli-commands.ts', 'apps/desktop/src/renderer/src/store.ts',
    'apps/desktop/src/renderer/src/App.tsx', 'apps/desktop/src/renderer/src/lib/desktop-focus-navigation.ts',
    'apps/desktop/src/renderer/src/lib/desktop-presentation.ts', 'apps/desktop/test/browser-profile-survey-control.test.ts',
    'apps/desktop/test/survey-tab-composition.test.tsx', 'apps/desktop/scripts/fixtures/survey-page-cli/vitest.config.mts']
  assert.deepEqual(Object.keys(proof.sources).sort(), requiredOwners.sort(), 'The complete original candidate is bound')
  let equivalent
  if (evidence.sourceEquivalence) {
    equivalent = (await referenced(evidence.sourceEquivalence)).json()
    assert.equal(equivalent.passed, true); assert.equal(equivalent.file, 'apps/desktop/src/renderer/src/App.tsx')
    assert.equal(equivalent.before, 'let profileId: string | undefined')
    assert.equal(equivalent.after, 'let profileId: string | null | undefined')
    const current = await readFile(resolve(root, equivalent.file), 'utf8')
    assert.equal(current.split(equivalent.after).length, 2)
    const original = current.replace(equivalent.after, equivalent.before)
    assert.equal(sha(original), proof.sources[equivalent.file]); assert.equal(sha(original), equivalent.beforeSha256)
    assert.equal(sha(current), equivalent.afterSha256)
    const { default: ts } = await import('typescript')
    const options = { compilerOptions: equivalent.emittedJS.options }
    const before = ts.transpileModule(original, options).outputText, after = ts.transpileModule(current, options).outputText
    assert.equal(before, after); assert.equal(sha(before), equivalent.emittedJS.beforeSha256); assert.equal(sha(after), equivalent.emittedJS.afterSha256)
  }
  for (const [file, expected] of Object.entries(proof.sources))
    assert.equal(sha(await readFile(resolve(root, file))), file === equivalent?.file ? equivalent.afterSha256 : expected, 'Current Source: ' + file)
  const requiredMutations = ['explicit-registration', 'saved-page-scope', 'original-app-navigator', 'actual-profile-view', 'nested-target-receipt', 'strict-registration-input']
  assert.equal(proof.runs.length, requiredMutations.length + 2)
  assert.deepEqual(proof.runs.map(run => run.name), ['green', ...requiredMutations, 'restored'])
  for (const run of proof.runs) {
    const result = (await referenced(run.report)).json()
    await referenced(run.log)
    const loaded = (await referenced(run.loaded)).bytes.toString().trim().split('\n').map(line => JSON.parse(line))
    const assertions = result.testResults.flatMap(test => test.assertionResults).filter(test => !['pending', 'skipped'].includes(test.status))
    assert.ok(assertions.length > 0 && assertions.every(test => test.title.startsWith('[survey-cli]')), 'Nonempty original consumers: ' + run.name)
    assert.deepEqual(run.assertions, assertions.map(({ title, status }) => ({ title, status })))
    if (run.mutation) {
      assert.equal(run.exitCode, 1)
      assert.ok(assertions.some(test => test.status === 'failed' && test.failureMessages.some(message => message.includes('AssertionError'))), 'Business assertion red: ' + run.name)
      const actual = loaded.filter(entry => entry.file === run.mutation.file && entry.mutated)
      assert.ok(actual.length > 0 && actual.every(entry => entry.original === proof.sources[entry.file] && entry.loaded !== entry.original), 'Actual Source mutation loaded: ' + run.name)
    } else {
      assert.equal(run.exitCode, 0); assert.equal(result.numFailedTests, 0)
      assert.equal(assertions.length, 13); assert.ok(assertions.every(test => test.status === 'passed'))
      // Type-only contracts have no JavaScript module. Commands execute in the actual CLI child below.
      for (const file of requiredOwners.filter(file => !['packages/core/src/desktop-focus-control.ts', 'packages/core/src/agentmux-cli-commands.ts'].includes(file) && !file.endsWith('/vitest.config.mts')))
        assert.ok(loaded.some(entry => entry.file === file && entry.original === proof.sources[file] && !entry.mutated), 'Actual candidate consumer loaded: ' + file)
    }
    if (run.listener) await referenced(run.listener)
  }
  const discovery = (await referenced(evidence.discovery)).json()
  assert.equal(discovery.passed, true); assert.equal(discovery.cleanup.completed, true)
  assert.equal(discovery.runs.length, 6)
  for (const run of discovery.runs) { assert.equal(run.exitCode, 0); await referenced(run.output) }
  for (const [file, expected] of Object.entries(evidence.documents)) assert.equal(sha(await readFile(resolve(root, file))), expected, 'Owning documentation: ' + file)
  for (const file of Object.keys(evidence.documents).filter(file => file.startsWith('packages/core/guides/'))) assert.equal(discovery.sources[file], evidence.documents[file], 'Real module help used the current guide: ' + file)
  for (const file of Object.keys(proof.sources).filter(file => file.startsWith('packages/core/src/') && file !== 'packages/core/src/desktop-focus-control.ts'))
    assert.equal(discovery.cli.inputs[file], proof.sources[file], 'Fresh CLI consumes the same Core owner: ' + file)
  if (evidence.captureProof) {
    const capture = (await referenced(evidence.captureProof)).json()
    assert.equal(capture.passed, true)
    receipt.captureProof = evidence.captureProof
  }
  Object.assign(receipt, { passed: true, sourceQualified: true, evidence: { path: index, sha256: sha(raw) },
    normal: 13, bearingMutations: requiredMutations.length, restored: 13, realDiscoveryCommands: discovery.runs.map(run => run.args) })
} catch (error) { receipt.failure = { message: error.message, stack: error.stack }; process.exitCode = 1 }
await writeFile(output, JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify({ passed: receipt.passed, sourceQualified: receipt.sourceQualified, pngQualified: false, installedQualified: false, receipt: output, failure: receipt.failure?.message }))
