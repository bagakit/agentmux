import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const evidence = resolve(root, '.tmp/navigation-contexts')
mkdirSync(evidence, { recursive: true })
const config = 'apps/desktop/scripts/fixtures/navigation-contexts.config.mts'
const work = 'apps/desktop/test/navigation-contexts.test.tsx'
const mote = 'apps/desktop/test/mote-navigation-context.test.tsx'
const session = 'apps/desktop/test/session-pane-navigation-context.test.tsx'
const tests = [work, mote, session, 'apps/desktop/test/navigation-context-process-restore.test.ts',
  'apps/desktop/test/focus-navigation-preview.test.tsx',
  'apps/desktop/test/desktop-focus-navigation.test.tsx', 'apps/desktop/test/mote-materials-exact-reference.test.tsx',
  'apps/desktop/test/session-file-navigation-context.test.tsx', 'apps/desktop/test/terminal-link-mount.test.tsx',
  'apps/desktop/test/survey-zone-reference.test.ts',
  'apps/desktop/test/survey-collection.test.ts', 'apps/desktop/test/survey-zone-controls.test.tsx']
function run(name, files, mutation) {
  const report = resolve(evidence, name + '.json'), witness = resolve(evidence, name + '.loaded.jsonl')
  rmSync(report, { force: true }); rmSync(witness, { force: true })
  const log = openSync(resolve(evidence, name + '.log'), 'w')
  const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', config,
    ...files, '--reporter=json', '--outputFile=' + report], { cwd: root, encoding: 'utf8', stdio: ['ignore', log, log],
    env: { ...process.env, AGENTMUX_NAVIGATION_MUTATION: mutation ?? '', AGENTMUX_NAVIGATION_WITNESS: witness } })
  closeSync(log)
  assert.ifError(result.error)
  const data = JSON.parse(readFileSync(report, 'utf8'))
  assert.ok(data.numTotalTests > 0, name + ': a real test collection is required')
  if (!mutation) {
    assert.equal(result.status, 0, name + ': inspect .tmp/navigation-contexts/' + name + '.log')
    assert.equal(data.numFailedTests, 0)
    assert.equal(data.testResults.length, files.length, 'Every named suite must execute')
  } else {
    const loaded = readFileSync(witness, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.equal(loaded.length, 1); assert.equal(loaded[0].mutation, mutation)
    assert.notEqual(loaded[0].loaded, loaded[0].original, 'Actual loaded source must change')
    assert.equal(data.numTotalTests, baselineCounts.get(files[0]), 'Import failure cannot kill a mutant')
    assert.ok(result.status !== 0 && data.numFailedTests > 0, name + ': mutant survived')
  }
  const receipt = { name, total: data.numTotalTests, failed: data.numFailedTests, exit: result.status }
  process.stdout.write(JSON.stringify(receipt) + '\n')
  return data
}
// Consumers are outside their defining files; mounted tests below exercise these calls.
const sourceRoot = resolve(root, 'apps/desktop/src/renderer/src')
function filesAt(dir) { return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
  ? filesAt(resolve(dir, entry.name)) : /\.[jt]sx?$/.test(entry.name) ? [resolve(dir, entry.name)] : []) }
const sources = filesAt(sourceRoot)
assert.ok(sources.length > 0)
const callers = ['selectMainRegion', 'setSurveyZoneSelection', 'moteWorkbenchProjection',
  'usePmoTeamsTopicTarget', 'readPmoTeamsTopicFloatingState'].map(symbol => {
  const found = sources.filter(file => new RegExp('\\b' + symbol + '\\s*\\(').test(readFileSync(file, 'utf8')))
  assert.ok(found.length >= 2, symbol + ': definition plus production caller required')
  return { symbol, files: found.map(file => file.slice(root.length + 1)) }
})
const diskHashes = new Map(sources.map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]))
const baseline = run('baseline', tests)
const baselineCounts = new Map(baseline.testResults.map(suite => [suite.name.slice(root.length + 1), suite.assertionResults.length]))
for (const [mutation, file] of [
  ['focus-preview-execution-label', 'apps/desktop/test/focus-navigation-preview.test.tsx'],
  ...['work-selection', 'goal-ambiguity', 'survey-follows-work', 'survey-agent-navigates', 'http-local-domain', 'http-late-navigation', 'execution-reference-identity'].map(name => [name, work]),
  ...['mote-first-discussion', 'mote-shared-region', 'mote-shared-observation'].map(name => [name, mote]),
  ...['session-local-callback', 'session-local-fallback', 'session-exact-group', 'history-late-context'].map(name => [name, session])
]) run(mutation, [file], mutation)
for (const [file, hash] of diskHashes) assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), hash, 'Source checkout unchanged: ' + file)
writeFileSync(resolve(evidence, 'callers.json'), JSON.stringify(callers, null, 2) + '\n')
process.stdout.write('Navigation contexts: baseline, real source mutants, consumers and process restart passed.\n')
