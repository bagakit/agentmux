import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

// Only current Source qualification. No build, capture, live Runtime or shared mutation.
const repository = resolve(import.meta.dirname, '../../..'), hash = bytes => createHash('sha256').update(bytes).digest('hex')
const evidence = join(repository, '.tmp/mote-launcher-identity-source', String(Date.now()))
await mkdir(evidence, { recursive: true })
const clone = await mkdtemp(join(repository, '.tmp/mote-launcher-identity-source-copy-'))
const component = name => `apps/desktop/src/renderer/src/components/${name}.tsx`
const owners = [component('NewTabSurface'), component('LauncherEnvironment')]
const test = 'test/mote-launcher-identity.test.tsx'
const result = { schema: 'agentmux.mote-launcher-identity-source.v1', passed: false, source: [], callers: {}, mutations: [], userAppOrRunTouched: false }
async function run(name, program, args) {
  const child = spawnSync(process.execPath, [program, ...args], { cwd: clone, encoding: 'utf8', timeout: 120000 })
  const output = (child.stdout ?? '') + (child.stderr ?? '') + (child.error ? '\n' + child.error.message : '')
  await writeFile(join(evidence, name + '.log'), output)
  assert(!child.error, name + ': command did not complete')
  return { exitCode: child.status, log: name + '.log', sha256: hash(output), output }
}
async function owning(name) {
  const report = join(evidence, name + '.json')
  const runResult = await run(name, 'node_modules/vitest/vitest.mjs', ['run', '--config',
    'apps/desktop/scripts/fixtures/mote-navigation-footer/vitest.owning.config.mts', test, '--maxWorkers=1', '--reporter=json', '--outputFile=' + report])
  const facts = JSON.parse(await readFile(report, 'utf8'))
  assert.equal(facts.numTotalTests, 18, 'All actual identity cases must be collected')
  return { ...runResult, output: undefined, tests: facts.numTotalTests, passed: facts.numPassedTests,
    failures: facts.testResults.flatMap(file => file.assertionResults.filter(one => one.status === 'failed').map(one => ({ name: one.fullName, messages: one.failureMessages }))) }
}
async function productSources(directory) {
  const found = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...await productSources(path))
    else if (entry.isFile() && /\.tsx$/.test(entry.name)) found.push(path)
  }
  return found
}
function replaceOnce(text, from, to) {
  assert.equal(text.split(from).length, 2, 'Mutation must hit one exact current owning block')
  return text.replace(from, to)
}
try {
  for (const path of ['apps/desktop/src', 'apps/desktop/resources', 'packages/core/src', 'packages/demand/src', 'packages/layout/src'])
    await cp(join(repository, path), join(clone, path), { recursive: true })
  for (const path of ['package.json', 'tsconfig.base.json', 'vitest.setup.ts', 'apps/desktop/package.json', 'apps/desktop/tsconfig.json', 'apps/desktop/tsconfig.test.json',
    'packages/core/package.json', 'packages/demand/package.json', 'packages/layout/package.json',
    'apps/desktop/scripts/fixtures/mote-navigation-footer/vitest.owning.config.mts',
    'apps/desktop/test/mote-launcher-identity.test.tsx', 'apps/desktop/test/fixtures/mote-workface.ts', 'apps/desktop/test/helpers/composer-dom-fixture.tsx']) {
    await mkdir(dirname(join(clone, path)), { recursive: true }); await cp(join(repository, path), join(clone, path))
  }
  for (const path of ['node_modules', 'apps/desktop/node_modules', 'packages/core/node_modules', 'packages/demand/node_modules', 'packages/layout/node_modules']) {
    await mkdir(dirname(join(clone, path)), { recursive: true }); await symlink(join(repository, path), join(clone, path), 'dir')
  }
  for (const path of owners) result.source.push({ path, sha256: hash(await readFile(join(repository, path))) })

  const files = await productSources(join(repository, 'apps/desktop/src/renderer/src'))
  assert(files.length > 0, 'Product caller scan cannot be empty')
  const definitions = { WorkspaceWorkbench: component('WorkspaceWorkbench'), NewTabSurface: owners[0], LauncherEnvironment: owners[1] }
  for (const [symbol, definition] of Object.entries(definitions)) {
    const hits = []
    for (const file of files) if (relative(repository, file) !== definition) {
      const text = await readFile(file, 'utf8'), source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
      const visit = node => {
        if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(source) === symbol) {
          assert(node.getStart(source) >= 0 && node.getText(source).length > 0)
          hits.push({ path: relative(repository, file), line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
            properties: node.attributes.properties.filter(ts.isJsxAttribute).map(attribute => attribute.name.getText(source)) })
        }
        ts.forEachChild(node, visit)
      }; visit(source)
    }
    assert(hits.length > 0, 'No non-definition actual JSX caller: ' + symbol); result.callers[symbol] = hits
  }
  assert(result.callers.WorkspaceWorkbench.some(row => row.path === component('PmoTeamsTopicFloatingPanel') && row.properties.includes('projectionTabId')))
  assert(result.callers.NewTabSurface.some(row => row.path === definitions.WorkspaceWorkbench && row.properties.includes('tabId') && row.properties.includes('regionId')))
  assert(result.callers.LauncherEnvironment.some(row => row.path === owners[0] && row.properties.includes('contextName')))
  const paths = {}
  for (const name of ['core', 'demand', 'layout']) {
    const manifest = JSON.parse(await readFile(join(clone, 'packages', name, 'package.json'), 'utf8'))
    assert(Object.keys(manifest.exports).length > 0)
    for (const [subpath, target] of Object.entries(manifest.exports)) {
      const source = target.import.replace('./dist/', name === 'core' ? './src/' : './').replace(/\.js$/, '.ts')
      paths['@agentmux/' + name + (subpath === '.' ? '' : subpath.slice(1))] = ['packages/' + name + '/' + source.slice(2)]
    }
  }
  await writeFile(join(clone, 'apps/desktop/tsconfig.identity-proof.json'), JSON.stringify({ extends: './tsconfig.test.json',
    compilerOptions: { baseUrl: '../..', paths }, include: [test, 'src/renderer/src/global.d.ts'] }))
  const types = await run('types', 'node_modules/typescript/bin/tsc', ['--noEmit', '--incremental', 'false', '-p', 'apps/desktop/tsconfig.identity-proof.json'])
  result.types = { ...types, output: undefined }; assert.equal(types.exitCode, 0, 'Current owning Source noEmit types must pass')
  result.baseline = await owning('baseline-green'); assert.equal(result.baseline.exitCode, 0)
  const variants = [
    { name: 'resource-name-instead-of-current-mote', path: owners[1],
      from: "const name = contextName ?? workspace?.name ?? 'Choose a workspace'", to: "const name = workspace?.name ?? 'Choose a workspace'" },
    { name: 'foreign-host-path-snapshot-accepted', path: owners[0],
      from: '? scratchTopicsForWorkspace(state.scratchTopicSnapshots, workspace) : null)', to: '? state.scratchTopicSnapshots[workspace.id]?.topics ?? null : null)' },
    { name: 'borrow-active-region-instead-of-exact-region', path: owners[0],
      from: "const region = regionId ? tab?.regions[regionId] : undefined\n    if (!tab || tab.id !== tabId || !region || region.regionId !== regionId || region.kind !== 'launcher' || region.workspaceId !== tab.workspaceId) return null",
      to: "const region = tab?.regions[tab.layout.activeRegionId]\n    if (!tab || tab.id !== tabId || !region || region.kind !== 'launcher' || region.workspaceId !== tab.workspaceId) return null" }
  ]
  for (const variant of variants) {
    const file = join(clone, variant.path), original = await readFile(file), changed = replaceOnce(original.toString('utf8'), variant.from, variant.to)
    await writeFile(join(evidence, variant.name + '.source.txt'), changed); await writeFile(file, changed)
    let red
    try {
      red = await owning(variant.name + '.red'); assert.notEqual(red.exitCode, 0)
      assert(red.failures.length > 0 && red.failures.some(one => one.messages.some(message => /AssertionError:/.test(message))), 'A setup failure is not semantic Assertion RED')
    } finally { await writeFile(file, original) }
    const green = await owning(variant.name + '.restored-green'); assert.equal(green.exitCode, 0)
    result.mutations.push({ name: variant.name, path: variant.path, originalSha256: hash(original), mutatedSha256: hash(changed), red, green })
  }
  for (const source of result.source) assert.equal(hash(await readFile(join(repository, source.path))), source.sha256, 'Shared original Source never mutated')
  result.passed = true
} catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  await rm(clone, { recursive: true, force: true }); result.temporarySourceRemoved = true
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(result, null, 2))
}
console.log(JSON.stringify({ passed: result.passed, receipt: relative(repository, join(evidence, 'receipt.json')), mutations: result.mutations.length }))
if (!result.passed) process.exitCode = 1
