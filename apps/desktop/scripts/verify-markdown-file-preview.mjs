// Mutation proof for the Markdown File Preview ports in Desktop: remote README images and the reading layout.
// Each named mutant in vitest.markdown-file-preview.config.mts rewrites one exact source anchor; the owning test
// must load, hit that anchor and fail a behavior assertion, and the unmutated source must pass.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const config = 'apps/desktop/test/vitest.markdown-file-preview.config.mts'
const mutants = ['remote-port-undefined', 'layout-not-passed', 'expected-not-current', 'save-from-render-value', 'receipt-not-applied', 'failure-silenced']
const proof = await mkdtemp(join(root, '.tmp/markdown-file-preview-mutation-'))

async function run(mode, mutation) {
  const output = join(proof, `${mode}.json`), hits = join(proof, `${mode}.hits`)
  const env = { ...process.env, ...(mutation ? { MARKDOWN_FILE_PREVIEW_MUTATION: mutation, MARKDOWN_FILE_PREVIEW_HITS: hits } : {}) }
  const exitCode = await new Promise((done, reject) => {
    const child = spawn(join(root, 'node_modules/.bin/vitest'), ['run', '--config', join(root, config), '--reporter=json', `--outputFile=${output}`], { cwd: root, env, stdio: 'ignore' })
    child.on('error', reject); child.on('exit', done)
  })
  const result = JSON.parse(await readFile(output, 'utf8'))
  const collected = result.testResults.filter(file => file.assertionResults.length > 0).length
  const failures = result.testResults.flatMap(file => file.assertionResults).filter(test => test.status === 'failed')
  const hit = mutation ? (await readFile(hits, 'utf8').catch(() => '')).split('\n').includes(mutation) : true
  return { exitCode, collected, passed: result.numPassedTests, failed: result.numFailedTests, failures, hit }
}

try {
  const green = await run('green')
  assert.equal(green.exitCode, 0, 'Unmutated Desktop source passes')
  assert.equal(green.collected, 1, 'The owning test file loads and collects tests')
  console.log(`green: ${green.passed} passed`)
  for (const mutation of mutants) {
    const mutant = await run(mutation, mutation)
    const killed = mutant.exitCode !== 0 && mutant.collected === 1 && mutant.hit && mutant.failures.some(test => test.failureMessages.some(message => /AssertionError|expected/u.test(message)))
    console.log(`${killed ? 'killed  ' : 'SURVIVED'} ${mutation} (hit ${mutant.hit}, ${mutant.passed} passed, ${mutant.failed} failed)`)
    assert.ok(killed, `Mutant ${mutation} must hit its anchor and fail a behavior assertion`)
  }
  console.log(`all ${mutants.length} Desktop mutants killed`)
} finally {
  await rm(proof, { recursive: true, force: true })
}
