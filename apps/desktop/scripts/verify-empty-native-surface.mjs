// Run the Desktop surface cases for a Session Core holds no native conversation for, unmutated, then
// once per loaded mutant. The candidate must pass every case it selects; each mutant must fail its case.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const config = 'apps/desktop/test/fixtures/empty-native-surface/vitest.mutation.config.mts'
const variants = [
  { name: 'candidate' },
  { name: 'reason-as-refresh', target: 'says only what Core knows when it holds no native conversation' },
  { name: 'start-sends-prompt', target: 'opens the original Executor in a new Tab beside the original' },
  { name: 'display-is-execution', target: 'keeps the original local execution' },
  { name: 'local-executor-required', target: 'keeps the original remote execution' },
  { name: 'execution-change-ignored', target: 'rechecks the original execution before dispatch' },
  { name: 'tab-not-beside', target: 'opens the original Executor in a new Tab beside the original' },
  { name: 'remount-mints-fresh', target: 'repeated clicks and a remount reuse the one original creation' },
  { name: 'restore-kept', target: 'offers one solid action to start a new conversation' },
  { name: 'shown-as-failure', target: 'offers one solid action to start a new conversation' },
  { name: 'enter-recovers', target: 'keeps the draft but does not offer Send when there is no native conversation' }
]
// The cases this proof owns; the rest of each file stays in its ordinary suite.
const filter = 'Core holds no native conversation|no native conversation to continue|with no native conversation as unavailable|whose native conversation exists'
const CASES = 11
const output = join(root, 'apps/desktop/.tmp/empty-native-surface')
await mkdir(output, { recursive: true })
const attempt = await mkdtemp(join(output, 'attempt-'))
const receipt = { schema: 'agentmux.empty-native-surface-proof.v1', passed: false, results: [] }
const save = () => writeFile(join(attempt, 'receipt.json'), JSON.stringify(receipt, null, 2))
let candidateCases = 0
for (const variant of variants) {
  const report = join(attempt, variant.name + '.json'), loaded = join(attempt, variant.name + '.loaded.ndjson')
  const args = [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, '--root', root, '-t', filter, '--reporter=json', '--outputFile=' + report]
  const result = await new Promise((yes, no) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AMX_EMPTY_NATIVE_SURFACE_LOADED: loaded, ...(variant.name === 'candidate' ? {} : { AMX_EMPTY_NATIVE_SURFACE_MUTATION: variant.name }) } })
    let text = ''; child.stdout.on('data', d => { text += d }); child.stderr.on('data', d => { text += d })
    child.once('error', no); child.once('close', code => yes({ code, text }))
  })
  await writeFile(join(attempt, variant.name + '.log'), result.text)
  const tests = JSON.parse(await readFile(report, 'utf8')), assertions = tests.testResults.flatMap(test => test.assertionResults)
  const failed = assertions.filter(test => test.status === 'failed').map(test => test.fullName)
  const loadedMutation = variant.name === 'candidate' || (await readFile(loaded, 'utf8').catch(() => '')).includes(`"mutation":"${variant.name}"`)
  receipt.results.push({ name: variant.name, code: result.code, passed: tests.numPassedTests, failed: tests.numFailedTests, loadedMutation, failures: failed })
  await save()
  if (variant.name === 'candidate') {
    candidateCases = tests.numPassedTests
    assert.ok(result.code === 0 && tests.numFailedTests === 0 && candidateCases === CASES, `Unmutated surface cases must all run and pass (${candidateCases}/${CASES})`)
  } else {
    assert.ok(loadedMutation, 'Mutation was not loaded: ' + variant.name)
    assert.ok(result.code === 1 && failed.some(name => name.includes(variant.target)), 'Loaded mutation did not fail its designated case: ' + variant.name)
  }
}
receipt.passed = true; receipt.candidateCases = candidateCases; await save()
console.log('Empty-native surface proof passed: ' + join(attempt, 'receipt.json'))
