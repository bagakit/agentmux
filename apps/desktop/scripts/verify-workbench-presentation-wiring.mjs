import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, mkdir, writeFile, copyFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { resolve, join, relative } from 'node:path'
const root = resolve(import.meta.dirname, '../../..'), exec = promisify(execFile)
const base = '6ca49cc2d503c17ada3bda902cc8715558c25652'
const owner = 'apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx'
const typedOwners = [owner, 'apps/desktop/src/renderer/src/components/NewTabSurface.tsx']
const mode = process.argv[2]
assert.ok(['--mutations', '--source'].includes(mode), 'Finite verification mode')
const evidence = join(root, '.tmp/workbench-presentation-wiring', mode.slice(2) + '-' + globalThis.crypto.randomUUID())
await mkdir(evidence, { recursive: true })
const original = await readFile(join(root, owner), 'utf8'), hash = bytes => createHash('sha256').update(bytes).digest('hex')
const proofPaths = [...typedOwners, 'apps/desktop/src/renderer/src/styles/index.css', 'apps/desktop/scripts/verify-workbench-presentation-wiring.mjs',
  'apps/desktop/scripts/fixtures/workbench-presentation-wiring/vitest.config.mts', 'apps/desktop/test/workbench-presentation-wiring.integration.test.tsx']
const inputs = Object.fromEntries(await Promise.all(proofPaths.map(async path => [path, hash(await readFile(join(root, path)))])))
const result = { schema: 'agentmux.workbench-presentation-wiring-proof.v1', mode, base,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  owner, sourceSHA: hash(original), inputs, passed: false, mutations: [] }
async function mounted(label, mutation) {
  const directory = join(evidence, label); await mkdir(directory)
  const env = { ...process.env, AGENTMUX_WORKBENCH_LOADED: join(directory, 'loaded.jsonl') }
  if (mutation) env.AGENTMUX_WORKBENCH_MUTATION = mutation
  else delete env.AGENTMUX_WORKBENCH_MUTATION
  const args = ['node_modules/vitest/vitest.mjs', 'run', '--config', 'apps/desktop/scripts/fixtures/workbench-presentation-wiring/vitest.config.mts',
    'apps/desktop/test/workbench-presentation-wiring.integration.test.tsx', '--maxWorkers=1']
  let output, exitCode = 0
  try { output = await exec(process.execPath, args, { cwd: root, env, timeout: 60000, maxBuffer: 8 * 1024 * 1024 }) }
  catch (error) { assert.equal(error.killed, false, 'Finite mounted process did not time out'); exitCode = error.code; output = error }
  await writeFile(join(directory, 'stdout.log'), output.stdout ?? ''); await writeFile(join(directory, 'stderr.log'), output.stderr ?? '')
  for (const file of ['discovery.json', 'results.json']) await copyFile(join(root, '.tmp/workbench-presentation-wiring/mounted', file), join(directory, file))
  const discovery = JSON.parse(await readFile(join(directory, 'discovery.json'), 'utf8'))
  assert.equal(discovery.passed, true, 'Actual requested suites execute nonempty tests')
  const tests = JSON.parse(await readFile(join(directory, 'results.json'), 'utf8'))
  const loaded = (await readFile(join(directory, 'loaded.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(loaded.length, 1, 'Actual Workbench producer loaded exactly once')
  assert.equal(loaded[0].sourceSHA, hash(original)); assert.equal(loaded[0].transformed, Boolean(mutation))
  if (mutation) { assert.equal(loaded[0].mutation, mutation); assert.notEqual(loaded[0].sourceSHA, loaded[0].loadedSHA) }
  return { directory: relative(root, directory), exitCode, discovery, loaded, tests }
}
async function mutations() {
  const baseline = await mounted('baseline'); assert.equal(baseline.exitCode, 0); result.baseline = baseline
  for (const name of ['drop-primary-reference', 'drop-secondary-presentations']) {
    const red = await mounted(name + '-red', name)
    assert.equal(red.exitCode, 1, 'Bearing producer mutation causes a real test failure')
    const failures = red.tests.testResults.flatMap(file => file.assertionResults.filter(test => test.status === 'failed'))
    assert.ok(failures.length > 0); assert.ok(failures.some(test => test.failureMessages.some(text => text.includes('AssertionError'))), 'Actual Assertion RED, not import/startup failure')
    const restored = await mounted(name + '-restored'); assert.equal(restored.exitCode, 0)
    result.mutations.push({ name, red, restored, sharedSourceWritten: false })
  }
}
async function source() {
  const ts = await import('typescript')
  const app = ts.getParsedCommandLineOfConfigFile(join(root, 'apps/desktop/tsconfig.json'), {}, ts.sys)
  const shared = ts.getParsedCommandLineOfConfigFile(join(root, 'packages/client-ui/tsconfig.json'), {}, ts.sys)
  assert.ok(app.fileNames.length > 0 && shared.fileNames.length > 0)
  const paths = { '@agentmux/client-ui/components/*': ['packages/client-ui/src/components/*.tsx'],
    '@agentmux/client-ui/terminal/*': ['packages/client-ui/src/terminal/*.ts'], '@agentmux/client-ui/platform': ['packages/client-ui/src/platform.tsx'],
    '@agentmux/client-ui': ['packages/client-ui/src/index.ts'], '@agentmux/client-ui/*': ['packages/client-ui/src/lib/*.ts'], '@agentmux/layout': ['packages/layout/src/index.ts'] }
  for (const pkg of ['core', 'demand']) for (const [key, entry] of Object.entries(JSON.parse(readFileSync(join(root, `packages/${pkg}/package.json`), 'utf8')).exports))
    if (typeof entry === 'object' && entry.import) paths[`@agentmux/${pkg}${key === '.' ? '' : key.slice(1)}`] =
      [`packages/${pkg}/` + entry.import.replace('./dist/', './src/').replace('./src/src/', './src/').replace(/\.js$/, '.ts')]
  const options = { ...app.options, baseUrl: root, paths }, roots = [...new Set([...app.fileNames, ...shared.fileNames])]
  const tracked = execFileSync('git', ['ls-tree', '-r', '--name-only', base], { cwd: root, encoding: 'utf8' }).trim().split('\n')
    .filter(path => /^(apps\/desktop|packages\/(core|demand|layout|client-ui))\//.test(path) && /\.(tsx?|json)$/.test(path))
  assert.ok(tracked.length > 0)
  const blobs = execFileSync('git', ['cat-file', '--batch'], { cwd: root, input: tracked.map(path => `${base}:${path}\n`).join(''), maxBuffer: 64 * 1024 * 1024 })
  const baselineFiles = new Map(); let offset = 0
  for (const path of tracked) { const end = blobs.indexOf(10, offset), size = Number(blobs.subarray(offset, end).toString().split(' ').at(-1));
    assert.ok(Number.isFinite(size)); baselineFiles.set(join(root, path), blobs.subarray(end + 1, end + 1 + size).toString()); offset = end + 2 + size }
  const build = (baseline = false, override = new Map()) => {
    const host = ts.createCompilerHost(options), read = host.readFile, exists = host.fileExists
    host.readFile = file => override.has(file) ? override.get(file) : baseline && baselineFiles.has(file) ? baselineFiles.get(file) : read(file)
    host.fileExists = file => baselineFiles.has(file) || exists(file)
    host.getSourceFile = (file, version) => { const text = host.readFile(file); return text === undefined ? undefined : ts.createSourceFile(file, text, version, true) }
    const program = ts.createProgram(baseline ? roots.filter(file => baselineFiles.has(file)) : roots, options, host)
    const diagnostics = ts.getPreEmitDiagnostics(program).map(d => ({ file: d.file ? relative(root, d.file.fileName) : '<config>',
      line: d.file ? d.file.getLineAndCharacterOfPosition(d.start ?? 0).line + 1 : 0,
      character: d.file ? d.file.getLineAndCharacterOfPosition(d.start ?? 0).character + 1 : 0,
      code: d.code, category: d.category, message: ts.flattenDiagnosticMessageText(d.messageText, '\n') })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    return { program, diagnostics }
  }
  const baseline = build(true), candidate = build(), owned = candidate.diagnostics.filter(d => typedOwners.includes(d.file))
  const others = candidate.diagnostics.filter(d => !typedOwners.includes(d.file)), baselineOthers = baseline.diagnostics.filter(d => !typedOwners.includes(d.file))
  const introduced = others.filter(d => !baselineOthers.some(old => JSON.stringify(old) === JSON.stringify(d)))
  const resolved = baselineOthers.filter(d => !others.some(next => JSON.stringify(next) === JSON.stringify(d)))
  result.program = { appRootCount: app.fileNames.length, sharedRootCount: shared.fileNames.length, consumedSourceFiles: candidate.program.getSourceFiles().length,
    ownedDiagnostics: owned, otherDiagnostics: others, baselineAllDiagnostics: baseline.diagnostics, baselineOtherDiagnostics: baselineOthers, introducedOtherDiagnostics: introduced, resolvedOtherDiagnostics: resolved }
  await writeFile(join(evidence, 'program.json'), JSON.stringify(result.program, null, 2))
  for (const path of typedOwners) assert.ok(candidate.program.getSourceFile(join(root, path)));  assert.equal(owned.length, 0, 'Restored typed Workbench Source has no diagnostics')
  assert.equal(introduced.length, 0, 'No unrelated diagnostic introduced against the full fixed Main Program')
  // Existing App callers had a type mismatch from the reverted singleton target API.
  // Record their resolved diagnostics explicitly rather than loosening the baseline.
  for (const item of resolved) assert.ok(['apps/desktop/src/renderer/src/App.tsx', 'apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx',
    'apps/desktop/src/renderer/src/components/GlobalSurveySurface.tsx'].includes(item.file), 'Only restored production consumers lose baseline diagnostics: ' + item.file)
  const specs = [
    [owner, 'NewTabSurface', 'tabGroupId'],
    ['apps/desktop/src/renderer/src/App.tsx', 'WorkspaceWorkbench', 'viewTargets'],
    ['apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx', 'WorkspaceWorkbench', 'projection'],
    ['apps/desktop/src/renderer/src/components/GlobalSurveySurface.tsx', 'WorkspaceWorkbench', 'projection'],
    [owner, 'StableWorkbenchView', 'reference'], [owner, 'StableWorkbenchView', 'projection'],
    [owner, 'SessionPane', 'presentations'], [owner, 'SessionPane', 'renderPresentationFrame'], [owner, 'SessionPane', 'onPresentationSelected'],
    [owner, 'WorkbenchBrowserTargetsContext.Provider', 'value'],
    ['apps/desktop/src/renderer/src/components/StableWorkbenchView.tsx', 'WorkbenchPresentationContext.Provider', 'value'],
    ['apps/desktop/src/renderer/src/components/SessionPane.tsx', 'SessionActivityPresentation', 'target']
  ]
  result.callers = specs.map(([path, tag, prop]) => {
    const file = candidate.program.getSourceFile(join(root, path)); assert.ok(file, 'Complete Source Program consumes external caller: ' + path)
    const matches = []; const visit = node => {
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(file) === tag &&
        node.attributes.properties.some(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(file) === prop))
        matches.push({ line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, tag, prop })
      ts.forEachChild(node, visit)
    }; visit(file); assert.ok(matches.length > 0, 'Actual production caller collection is nonempty: ' + path + ' ' + tag + '.' + prop)
    return { path, sourceSHA: hash(file.text), matches }
  })
  const file = candidate.program.getSourceFile(join(root, owner)), imports = file.statements.filter(ts.isImportDeclaration).map(node => node.moduleSpecifier.text)
  assert.ok(imports.length > 0); assert.ok(!imports.some(path => /(?:MoteWorkface|mote-workface)/.test(path)), 'Deleted Mote UI modules remain deleted')
  await writeFile(join(evidence, 'callers.json'), JSON.stringify({ callers: result.callers, imports }, null, 2))
  const from = 'reference={targetId === null ? homeReferences.get(tab.id) ?? undefined : projection?.reference}'
  assert.equal(original.split(from).length - 1, 1)
  const changed = original.replace(from, 'reference={42}'), red = build(false, new Map([[join(root, owner), changed]]))
  const redOwned = red.diagnostics.filter(d => typedOwners.includes(d.file))
  assert.ok(redOwned.some(d => d.code === 2322), 'Actual invalid primary reference yields a typed assignment Assertion RED')
  const restored = build(); assert.deepEqual(restored.diagnostics, candidate.diagnostics)
  result.mutations.push({ name: 'primary-reference-invalid-type', originalSHA: hash(original), mutatedSHA: hash(changed), redDiagnostics: redOwned,
    assertionRed: true, restoredDiagnosticsMatchCandidate: true, sharedSourceWritten: false })
}
try {
  if (mode === '--mutations') await mutations(); else await source()
  for (const [path, sha] of Object.entries(inputs)) assert.equal(hash(await readFile(join(root, path))), sha, 'Private verification leaves every owned Source unchanged: ' + path)
  result.passed = true
} catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack }; throw error }
finally { await writeFile(join(evidence, 'receipt.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ passed: result.passed, evidence: relative(root, evidence), failure: result.failure?.message ?? null })) }
