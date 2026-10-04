import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const evidence = resolve(root, '.tmp/footer-navigation-groups'); mkdirSync(evidence, { recursive: true })
const sourcePaths = ['components/TopRowChrome.tsx', 'components/SurfaceNavigation.tsx', 'styles/agent.css'].map(p => 'apps/desktop/src/renderer/src/' + p)
const hashes = () => Object.fromEntries(sourcePaths.map(p => [p, createHash('sha256').update(readFileSync(resolve(root, p))).digest('hex')]))
const originalHashes = hashes()
const app = readFileSync(resolve(root, 'apps/desktop/src/renderer/src/App.tsx'), 'utf8')
assert.match(app, /<footer className="window-status-bar">[\s\S]*?<SurfaceSwitch[\s\S]*?<\/footer>/, 'Existing App footer must actually consume SurfaceSwitch')
const chrome = readFileSync(resolve(root, sourcePaths[0]), 'utf8')
assert.match(chrome, /SURFACE_NAVIGATION_PLUGINS\.filter\([\s\S]*?plugin\.navigationContext/, 'Group metadata has an outside production consumer')
assert.match(readFileSync(resolve(root, 'apps/desktop/src/renderer/src/styles/index.css'), 'utf8'), /@import '\.\/agent\.css'/, 'Styles are consumed through original App CSS')
const file = 'apps/desktop/test/footer-navigation-groups.test.tsx'
let count
function run(name, mutation, files) {
  const report = resolve(evidence, name + '.json'), witness = resolve(evidence, name + '.loaded.jsonl')
  rmSync(report, { force: true }); rmSync(witness, { force: true })
  const log = openSync(resolve(evidence, name + '.log'), 'w')
  const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'apps/desktop/scripts/fixtures/footer-navigation-groups.config.mts', ...files, '--reporter=json', '--outputFile=' + report], { cwd: root, stdio: ['ignore', log, log], env: { ...process.env, AGENTMUX_FOOTER_MUTATION: mutation ?? '', AGENTMUX_FOOTER_WITNESS: witness } })
  closeSync(log); assert.ifError(result.error)
  const data = JSON.parse(readFileSync(report, 'utf8')); assert.ok(data.numTotalTests > 0, 'Nonempty collection')
  if (!mutation) {
    assert.equal(result.status, 0, 'Inspect ' + name + '.log'); assert.equal(data.numFailedTests, 0); assert.equal(data.testResults.length, files.length)
    count = data.testResults.find(s => s.name.endsWith('/' + file)).assertionResults.length
  } else {
    const loaded = readFileSync(witness, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.equal(loaded.length, 1); assert.equal(loaded[0].mutation, mutation); assert.notEqual(loaded[0].original, loaded[0].loaded)
    assert.equal(data.numTotalTests, count, 'Import failure is not a killed mutant'); assert.ok(result.status !== 0 && data.numFailedTests > 0, 'Mutant survived')
  }
  return { name, total: data.numTotalTests, failed: data.numFailedTests, exit: result.status }
}
const baseline = run('baseline', null, [file, 'apps/desktop/test/focus-navigation-preview.test.tsx'])
const mutants = ['survey-in-work', 'missing-work-label'].map(name => run(name, name, [file]))
assert.deepEqual(hashes(), originalHashes, 'Source checkout must remain unchanged')
writeFileSync(resolve(evidence, 'receipt.json'), JSON.stringify({ passed: true, baseline, mutants, sources: originalHashes, callers: ['App.tsx → SurfaceSwitch', 'TopRowChrome.tsx → SurfaceNavigation metadata', 'App CSS → agent.css'], scope: 'Presentation grouping only; original view/settings owners and identity checks remain real. Visual signoff is additional independent evidence.' }, null, 2) + '\n')
console.log(JSON.stringify({ passed: true, baseline, mutants }))
