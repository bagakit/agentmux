import { fixturePath as _hygiene_fixturePath } from "./lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '../../..')
const evidence = join(root, '.tmp/launcher-mote-preference')
const component = 'apps/desktop/src/renderer/src/components/LauncherMoteAction.tsx'
const preferences = 'apps/desktop/src/renderer/src/lib/launcher-state.ts'
const stylesheet = 'apps/desktop/src/renderer/src/styles/launcher.css'
const config = 'apps/desktop/scripts/fixtures/launcher-mote-preference/vitest.owning.config.mts'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
await mkdir(evidence, { recursive: true })

async function consumeSource() {
  const proof = JSON.parse(await readFile(join(evidence, 'source-receipt.json')))
  assert.equal(proof.passed, true)
  assert.ok(proof.baseline.passed > 0 && proof.baseline.failed === 0)
  assert.equal(proof.cases.length, 7)
  assert.ok(proof.callers.length > 0 && proof.callers.every(caller => caller.hits.length > 0))
  assert.ok(Object.keys(proof.loadedInputs).length > 0, 'Actual executed production Source must be bound')
  for (const inputs of [proof.loadedInputs, proof.sources]) for (const [path, digest] of Object.entries(inputs))
    assert.equal(sha(await readFile(join(root, path))), digest, 'The proof input changed: ' + path)
  for (const test of proof.cases) {
    assert.notEqual(test.red.exit, 0); assert.ok(test.red.assertions.some(message => /AssertionError:/.test(message)))
    assert.equal(test.restored.exit, 0); assert.ok(test.restored.passed > 0)
  }
  console.log(JSON.stringify({ passed: true, receipt: relative(root, join(evidence, 'source-receipt.json')), tests: proof.baseline.passed, mutations: proof.cases.length }))
}

// Reuse only evidence whose executed Source, callers and verification inputs
// still match. This keeps parallel Git changes from forcing another mutation run.
if (!process.argv.includes('--consume-review') && !process.argv.includes('--generate-source')) {
  try { await consumeSource(); process.exit(0) }
  catch (error) { if (process.argv.includes('--consume-source')) throw error }
}

if (process.argv.includes('--consume-review')) {
  const capture = JSON.parse(await readFile(join(evidence, 'visual/capture-receipt.json')))
  const review = JSON.parse(await readFile(join(evidence, 'visual/independent-visual-review.json')))
  assert.equal(capture.passed, true)
  assert.equal(review.passed, true)
  assert.equal(review.sourceDigest, capture.sourceDigest)
  assert.ok(review.reviewer && review.reviewer !== 'launcher_visual_probe')
  assert.ok(capture.frames.length > 0)
  for (const frame of capture.frames) {
    const digest = sha(await readFile(join(evidence, 'visual', frame.file)))
    assert.equal(digest, frame.sha256)
    assert.equal(review.frames.find(item => item.file === frame.file)?.sha256, digest)
  }
  for (const path of [component, preferences, stylesheet]) {
    const key = path.replace('apps/desktop/src/renderer/src/', '')
    assert.equal(capture.identity.sources[key], sha(await readFile(join(root, path))), 'Reviewed owning Source must still match: ' + path)
  }
  console.log(JSON.stringify({ passed: true, review: relative(root, join(evidence, 'visual/independent-visual-review.json')), frames: capture.frames.length }))
  process.exit(0)
}

const clone = await mkdtemp(_hygiene_fixturePath("tmp/amx-launcher-mote-mutations-"))
const result = { schema: 'agentmux.launcher-mote-preference-source.v1', passed: false, cases: [], callers: [], sources: {},
  boundary: 'Current LauncherMoteAction, preference store and their real input/identity owners. Isolated Source mutations; excludes the unrelated Browser/Note default test, whole-App assembly and native Run behavior.' }
const tests = 'apps/desktop/test/launcher-mote-create.test.tsx'
async function run(label) {
  const report = join(evidence, label + '.vitest.json')
  const args = ['run', '--config', config, 'test/launcher-mote-create.test.tsx', '-t', 'explicit selected Mote creation request (?!defaults Browser)', '--reporter=json', '--outputFile=' + report]
  const trace = join(evidence, 'loaded-source-inputs.jsonl')
  if (label === 'baseline') await writeFile(trace, '')
  const run = spawnSync(join(root, 'node_modules/.bin/vitest'), args, { cwd: clone, encoding: 'utf8', timeout: 90000,
    env: { ...process.env, ...(label === 'baseline' ? { AGENTMUX_LAUNCHER_PROOF_INPUTS: trace } : {}) } })
  await writeFile(join(evidence, label + '.log'), (run.stdout ?? '') + (run.stderr ?? '') + (run.error?.message ?? ''))
  assert.ok(!run.error, 'Test process must complete')
  const facts = JSON.parse(await readFile(report))
  assert.ok(facts.numPassedTests + facts.numFailedTests > 0, 'A nonempty executed test set is required')
  return { exit: run.status, passed: facts.numPassedTests, failed: facts.numFailedTests,
    assertions: facts.testResults.flatMap(file => file.assertionResults.filter(item => item.status === 'failed').flatMap(item => item.failureMessages)), report: relative(root, report) }
}
async function sourceFiles(directory) {
  const rows = await readdir(directory, { withFileTypes: true })
  return (await Promise.all(rows.map(row => row.isDirectory() ? sourceFiles(join(directory, row.name)) : /\.tsx?$/.test(row.name) ? [join(directory, row.name)] : []))).flat()
}
try {
  for (const path of ['apps/desktop/src', 'packages/core/src', 'packages/demand', 'packages/layout'])
    await cp(join(root, path), join(clone, path), { recursive: true, filter: path => !/(?:^|\/)(?:node_modules|dist|\.git)(?:\/|$)/.test(path) })
  for (const path of ['package.json', 'tsconfig.base.json', 'vitest.setup.ts', 'apps/desktop/package.json', 'packages/core/package.json',
    config, relative(root, import.meta.filename), 'apps/desktop/scripts/fixtures/mote-navigation-footer/vitest.owning.config.mts', tests, 'apps/desktop/test/helpers/composer-dom-fixture.tsx']) {
    await mkdir(dirname(join(clone, path)), { recursive: true })
    await cp(join(root, path), join(clone, path))
  }
  for (const path of ['node_modules', 'apps/desktop/node_modules', 'packages/core/node_modules', 'packages/demand/node_modules', 'packages/layout/node_modules']) {
    await mkdir(dirname(join(clone, path)), { recursive: true }); await symlink(join(root, path), join(clone, path), 'dir')
  }
  for (const path of [component, preferences, stylesheet, tests, config, relative(root, import.meta.filename), 'apps/desktop/scripts/fixtures/mote-navigation-footer/vitest.owning.config.mts',
    'package.json', 'tsconfig.base.json', 'vitest.setup.ts', 'apps/desktop/test/helpers/composer-dom-fixture.tsx',
    'apps/desktop/package.json', 'packages/core/package.json', 'packages/demand/package.json', 'packages/layout/package.json'])
    result.sources[path] = sha(await readFile(join(clone, path)))
  const files = await sourceFiles(join(root, 'apps/desktop/src'))
  assert.ok(files.length > 0, 'Product source scan must be nonempty')
  for (const [symbol, definition] of [['LauncherMoteAction', component], ['selectMote', preferences], ['topicSpaceIconTarget', 'apps/desktop/src/renderer/src/lib/space-object-appearance.ts'], ['SpaceObjectIcon', 'apps/desktop/src/renderer/src/components/SpaceObjectIcon.tsx']]) {
    const hits = []
    for (const path of files) {
      if (relative(root, path) === definition) continue
      const bytes = await readFile(path)
      const source = ts.createSourceFile(path, bytes.toString('utf8'), ts.ScriptTarget.Latest, true)
      function visit(node) {
        const expr = ts.isCallExpression(node) ? node.expression : ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node) ? node.tagName : null
        if (expr && (ts.isIdentifier(expr) ? expr.text === symbol : ts.isPropertyAccessExpression(expr) && expr.name.text === symbol)) {
          hits.push({ path: relative(root, path), line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 })
          result.sources[relative(root, path)] = sha(bytes)
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
    assert.ok(hits.length > 0, 'Real production calls required outside definition/imports/tests: ' + symbol)
    result.callers.push({ symbol, definition, hits })
  }
  const baseline = await run('baseline')
  assert.equal(baseline.exit, 0); result.baseline = baseline
  const loaded = (await readFile(join(evidence, 'loaded-source-inputs.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.ok(loaded.length > 0, 'Baseline must load real production Source')
  result.loadedInputs = Object.fromEntries(loaded.map(input => [input.path, input.sha256]))
  const mutants = [
    ['forget-last-choice', component, 'state.moteTopicId ?? PMO_TEAMS_TOPIC_ID', 'PMO_TEAMS_TOPIC_ID'],
    ['omit-durable-choice', preferences, ', moteTopicId: state.moteTopicId', ''],
    ['use-primary-avatar-for-selected', component, 'mote={selectedMote} topicId={topicId}', 'mote={motes[0]} topicId={PMO_TEAMS_TOPIC_ID}'],
    ['recommend-archived-targets', component, "motes.filter(mote => mote.moteArchive?.state !== 'archived')", 'motes'],
    ['omit-archived-status-and-recovery', component, "selectedMote?.moteArchive?.state === 'archived' ? <div", "false ? <div"],
    ['cancel-newly-discovered-input', component, 'sourceTabId, sourceRegionId, topicId])', 'sourceTabId, sourceRegionId, topicId, tabId])'],
    ['silence-unconfirmed-directory', component, '{directoryIssue ? <ServiceWindowNotice', '{false ? <ServiceWindowNotice']
  ]
  assert.ok(mutants.length > 0)
  for (const [name, path, from, to] of mutants) {
    const original = await readFile(join(clone, path), 'utf8')
    assert.equal(original.split(from).length, 2, 'Exact, unique mutation anchor: ' + name)
    const changed = original.replace(from, to)
    await writeFile(join(clone, path), changed)
    const red = await run(name + '-red')
    assert.notEqual(red.exit, 0, 'Mutation must fail: ' + name)
    assert.ok(red.assertions.some(message => /AssertionError:/.test(message)), 'A real owning assertion must turn red: ' + name)
    await writeFile(join(clone, path), original)
    const restored = await run(name + '-restored')
    assert.equal(restored.exit, 0)
    result.cases.push({ name, path, original: sha(original), mutated: sha(changed), red, restored })
    console.log(name + ': assertion RED / restored GREEN')
  }
  for (const inputs of [result.loadedInputs, result.sources]) for (const [path, digest] of Object.entries(inputs))
    assert.equal(sha(await readFile(join(root, path))), digest, 'Candidate changed during proof: ' + path)
  result.passed = true
} catch (error) {
  result.failure = { name: error.name, message: error.message, stack: error.stack }
} finally {
  await rm(clone, { recursive: true, force: true }); result.temporarySourceRemoved = true
  await writeFile(join(evidence, 'source-receipt.json'), JSON.stringify(result, null, 2))
}
console.log(JSON.stringify({ passed: result.passed, receipt: relative(root, join(evidence, 'source-receipt.json')), cases: result.cases.length, failure: result.failure?.message }))
if (!result.passed) process.exitCode = 1
