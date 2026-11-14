import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const outputRoot = join(root, '.tmp/settings-inputs-browser')
await mkdir(outputRoot, { recursive: true })
const output = await mkdtemp(join(outputRoot, 'attempt-'))
const testRoot = 'apps/desktop/test/'
const profileSuite = testRoot + 'browser-profiles-settings.test.tsx'
const capsuleSuite = testRoot + 'capsule-settings.test.tsx'
const suites = [capsuleSuite, ...[
  'browser-profile-bookmarks-ui.test.tsx', 'browser-profile-cookie-files-ui.test.tsx',
  'browser-profiles-settings-network.test.tsx', 'browser-profile-views-ui.test.tsx',
  'browser-start-page-personalization-settings.test.tsx', 'settings-browser-agent-control.test.tsx',
  'settings-browser-draft.test.tsx'
].map(file => testRoot + file)]
const profiles = 'apps/desktop/src/renderer/src/components/settings/BrowserProfilesSettingsPane.tsx'
const select = 'packages/client-ui/src/input/NativeSelect.tsx'
const mutants = [
  { id: 'composition-blur', file: profiles, suite: profileSuite,
    from: 'if (draft.composing) { draft.deferredBlur = true; return }', to: '',
    test: 'commits only the completed note when a blur interrupts IME composition' },
  { id: 'saved-note-revision', file: profiles, suite: profileSuite,
    from: 'draft.revision = confirmed.revision', to: '',
    test: 'keeps later note input mounted and submits its next blur on the confirmed revision' },
  { id: 'earlier-save-badge', file: profiles, suite: profileSuite,
    from: '{saved && !noting ? <span', to: '{saved ? <span',
    test: 'does not label a conflicting note with an earlier confirmed save' },
  { id: 'select-change', file: select, suite: capsuleSuite,
    from: '<select {...props}', to: '<select {...props} onChange={undefined}',
    test: 'saves domain defaults with the original revision and preserves existing absolute page resources' }
]
const sha = text => createHash('sha256').update(text).digest('hex')
for (const mutant of mutants) {
  const source = await readFile(join(root, mutant.file), 'utf8')
  assert.equal(source.split(mutant.from).length, 2, 'A single exact mutation target for ' + mutant.id)
  mutant.original = sha(source)
  mutant.mutated = sha(source.replace(mutant.from, mutant.to))
}
await writeFile(join(output, 'plan.json'), JSON.stringify({ root, suites, mutants }))
const config = join(output, 'vitest.config.mts')
await writeFile(config, `import base from ${JSON.stringify(join(root, testRoot, 'capsule-settings.config.mts'))}
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
const plan = JSON.parse(readFileSync(${JSON.stringify(join(output, 'plan.json'))}, 'utf8'))
const mutant = plan.mutants.find(value => value.id === process.env.SETTINGS_BROWSER_MUTATION)
const hash = text => createHash('sha256').update(text).digest('hex')
export default { ...base,
  cacheDir: ${JSON.stringify(join(output, 'cache'))},
  test: { ...base.test, include: process.env.SETTINGS_BROWSER_SUITE ? [process.env.SETTINGS_BROWSER_SUITE] : plan.suites, passWithNoTests: false },
  plugins: [...base.plugins, { name: 'settings-browser-original-inputs', enforce: 'pre', transform(input, id) {
    if (!mutant || relative(plan.root, id.split('?')[0]) !== mutant.file) return
    const code = input.replace(mutant.from, mutant.to)
    writeFileSync(process.env.SETTINGS_BROWSER_CONSUMED, JSON.stringify({ original: hash(input), mutated: hash(code) }))
    return { code, map: null }
  } }]
}
`)
const results = []
const profileTests = [
  ...mutants.filter(mutant => mutant.suite === profileSuite).map(mutant => mutant.test),
  'a refused edit keeps the editor usable and offers Reload for a changed list',
  'renames in place with the exact Profile token and shows the saved name everywhere',
  'turns Agents off and on for this Profile with its configuration token'
]
const variants = [{ id: 'control' }, { id: 'profile-inputs', suite: profileSuite, tests: profileTests },
  ...mutants.map(mutant => ({ id: mutant.id, mutant, suite: mutant.suite, tests: [mutant.test] }))]
for (const { id, mutant, suite, tests } of variants) {
  const report = join(output, id + '.tests.json'), consumed = join(output, id + '.source.json')
  const run = spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config,
    '--reporter=json', '--outputFile.json=' + report, ...(tests ? ['--testNamePattern', tests.join('|')] : [])], {
    cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, SETTINGS_BROWSER_MUTATION: mutant?.id ?? '', SETTINGS_BROWSER_SUITE: suite ?? '', SETTINGS_BROWSER_CONSUMED: consumed }
  })
  const log = (run.stdout ?? '') + (run.stderr ?? '')
  await writeFile(join(output, id + '.log'), log)
  assert.ifError(run.error)
  const summary = JSON.parse(await readFile(report, 'utf8'))
  const expectedSuites = suite ? [suite] : suites
  assert.deepEqual(summary.testResults.map(test => test.name).sort(), expectedSuites.map(file => join(root, file)).sort())
  assert.ok(summary.testResults.every(test => test.assertionResults.length > 0), 'Every intended consumer ran assertions')
  assert.doesNotMatch(log, /Unhandled Errors|Unhandled Rejection|Uncaught Exception/u)
  if (mutant) {
    assert.equal(run.status, 1, log)
    assert.deepEqual(JSON.parse(await readFile(consumed, 'utf8')), { original: mutant.original, mutated: mutant.mutated })
    const failed = summary.testResults[0].assertionResults.find(test => test.title === mutant.test)
    assert.equal(failed?.status, 'failed', 'Expected consumer assertion failed under ' + id)
    assert.ok(failed.failureMessages.some(message => /AssertionError|expected .* to /su.test(message)), 'No setup failure can qualify')
  } else {
    assert.equal(run.status, 0, summary.testResults.flatMap(test =>
      test.assertionResults.filter(result => result.status === 'failed').map(result => result.failureMessages)).join('\n') || log)
    if (tests) {
      for (const title of tests) assert.equal(summary.testResults[0].assertionResults.find(test => test.title === title)?.status, 'passed', title)
      assert.equal(summary.numPassedTests, tests.length)
    } else assert.equal(summary.numPassedTests, summary.numTotalTests)
  }
  results.push({ id, passed: summary.numPassedTests, failed: summary.numFailedTests })
  console.log(JSON.stringify(results.at(-1)))
}
await writeFile(join(output, 'receipt.json'), JSON.stringify({ passed: true, results }, null, 2))
console.log(output)
