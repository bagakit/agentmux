import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const argument = process.argv.slice(2)
assert.equal(argument.length, 1, '只接受一个明确验证模式')
const mode = argument[0]
assert.ok(['--unit', '--mutations', '--callers'].includes(mode), '已知验证模式')
const execute = promisify(execFile), sha = bytes => createHash('sha256').update(bytes).digest('hex')
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const config = 'apps/desktop/scripts/fixtures/settings-parent-cost/vitest.config.mts'
const fixture = 'apps/desktop/test/settings-parent-cost.test.tsx'
const appPath = 'apps/desktop/src/renderer/src/App.tsx'
const panelPath = 'apps/desktop/src/renderer/src/components/SettingsPanel.tsx'
const proofPaths = [config, fixture, 'apps/desktop/scripts/fixtures/settings-parent-cost/observations.ts',
  'apps/desktop/scripts/verify-settings-parent-cost.mjs', 'apps/desktop/scripts/fixtures/settings-overview/vitest.config.mts',
  'apps/desktop/test/settings-search.test.ts', 'apps/desktop/test/helpers/composer-dom-fixture.tsx',
  'apps/desktop/test/helpers/config-owner-fixture.ts', 'vitest.setup.ts']
const adjacentTests = ['settings-search.test.ts', 'settings-draft-conflict.test.tsx', 'settings-keyboard-shortcuts.test.tsx',
  'settings-prompts-liquid.test.tsx', 'settings-workbench.test.tsx', 'settings-overview.test.tsx', 'app-smoke-workspace-selection.test.tsx']
const evidenceBase = resolve(root, '.bagakit/design/settings-followups-20261004/parent-cost-evidence', mode.slice(2))
await mkdir(evidenceBase, { recursive: true })
const evidence = await mkdtemp(resolve(evidenceBase, 'run-'))
const snapshots = async (paths, folder) => Object.fromEntries(await Promise.all(paths.map(async path => {
  const bytes = await readFile(resolve(root, path)), target = resolve(evidence, folder, path)
  await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes)
  return [path, sha(bytes)]
})))
const proofInputs = await snapshots([...proofPaths, ...adjacentTests.map(name => `apps/desktop/test/${name}`)], 'proof')
const originalProductSource = await snapshots([appPath, panelPath], 'source')
const results = []
let candidateInputs, loadedCandidate, baselineConsumed

async function callers() {
  const ts = createRequire(resolve(root, 'apps/desktop/package.json'))('typescript')
  const app = await readFile(resolve(root, appPath), 'utf8'), panel = await readFile(resolve(root, panelPath), 'utf8')
  const ast = ts.createSourceFile(appPath, app, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const callSites = [], surfaceSites = []
  const walk = node => {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === 'SettingsPanel') callSites.push(node)
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === 'SurfaceSwitch') surfaceSites.push(node)
    ts.forEachChild(node, walk)
  }
  walk(ast)
  assert.equal(callSites.length, 1, '排除定义/import/tests 的 actual App SettingsPanel JSX caller 必须非空唯一')
  assert.equal(surfaceSites.length, 1, '原 SurfaceSwitch JSX caller 必须非空唯一')
  function value(node, name) {
    const attributes = node.attributes.properties.filter(attr => ts.isJsxAttribute(attr) && attr.name.getText(ast) === name)
    assert.equal(attributes.length, 1, `真实 JSX prop 非空唯一: ${name}`)
    const initializer = attributes[0].initializer
    assert.ok(initializer && ts.isJsxExpression(initializer) && initializer.expression, `真实 JSX prop expression: ${name}`)
    return initializer.expression.getText(ast)
  }
  assert.equal(value(callSites[0], 'onClose'), 'closeSettings')
  assert.equal(value(surfaceSites[0], 'onCloseSettings'), 'closeSettings')
  assert.equal(value(callSites[0], 'initialSection'), 'settingsRoute.section')
  assert.equal(value(callSites[0], 'executorId'), 'settingsRoute.executorId')
  const panelAST = ts.createSourceFile(panelPath, panel, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const exports = panelAST.statements.filter(ts.isVariableStatement)
    .filter(node => node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword))
    .flatMap(node => [...node.declarationList.declarations])
    .filter(node => ts.isIdentifier(node.name) && node.name.text === 'SettingsPanel')
  assert.equal(exports.length, 1, '生产 SettingsPanel 公共导出非空唯一')
  const initializer = exports[0].initializer
  assert.ok(initializer && ts.isCallExpression(initializer))
  assert.equal(initializer.expression.getText(panelAST), 'memo')
  assert.equal(initializer.arguments.length, 1, '仅 React 默认 comparator')
  const name = initializer.arguments[0].getText(panelAST)
  const owners = panelAST.statements.filter(ts.isFunctionDeclaration).filter(node => node.name?.text === name)
  assert.equal(owners.length, 1, '公共导出消费同一原 Panel owner')
  assert.ok(owners[0].body.statements.length > 0, '原 Panel owner body 非空')
  const record = { completed: true, productionDefinitionsExcluded: [panelPath], importsAndTestsExcluded: true,
    sourceSHA256: originalProductSource,
    callers: [...callSites, ...surfaceSites].map(node => ({ path: appPath,
      line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1, source: node.getText(ast) })),
    exportedOwner: name, defaultMemoOnly: true }
  await writeFile(resolve(evidence, 'callers.json'), JSON.stringify(record, null, 2) + '\n')
  console.log(`callers: 原 App 两个 JSX 调用点非空，SettingsPanel 默认 memo → ${name}`)
}

async function run(name, mutant, expected) {
  const output = resolve(evidence, name); await mkdir(output, { recursive: true })
  const tests = [fixture, ...(mode === '--unit' ? adjacentTests.map(name => `apps/desktop/test/${name}`) : [])]
  const args = ['exec', 'vitest', 'run', '--config', config, ...tests, '--maxWorkers=1',
    '--reporter=json', '--outputFile', resolve(output, 'vitest.json')]
  const env = { ...process.env, pnpm_config_verify_deps_before_run: 'false',
    AGENTMUX_SETTINGS_PARENT_MUTANT: mutant, AGENTMUX_SETTINGS_PARENT_EVIDENCE: output }
  let exitCode = 0, stdout = '', stderr = ''
  try { const value = await execute('pnpm', args, { cwd: root, env, timeout: 150_000, maxBuffer: 20 * 1024 * 1024 })
    stdout = value.stdout; stderr = value.stderr
  } catch (error) { exitCode = typeof error.code === 'number' ? error.code : -1; stdout = error.stdout ?? ''; stderr = error.stderr ?? '' }
  await writeFile(resolve(output, 'run.log'), stdout + stderr)
  const report = await json(resolve(output, 'vitest.json'))
  assert.ok(report.numTotalTests > 0, `${name}: 测试必须真实收集非空`)
  const assertions = report.testResults.flatMap(file => file.assertionResults)
  assert.ok(assertions.length > 0, `${name}: actual assertions 非空`)
  const owningFiles = report.testResults.filter(file => file.name.endsWith(fixture))
  assert.equal(owningFiles.length, 1, `${name}: actual App owning 文件必须唯一收集`)
  assert.equal(owningFiles[0].assertionResults.length, 4, `${name}: setup/collection 失败，不是四个 actual App 行为断言`)
  const inputs = await json(resolve(output, 'source-inputs.json'))
  const loaded = (await readFile(resolve(output, 'loaded-source.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse)
  assert.ok(loaded.length > 0, `${name}: actual loaded Source 非空`)
  for (const [path, hash] of Object.entries(inputs)) {
    const entries = loaded.filter(value => value.path === path)
    assert.ok(entries.length > 0, `${name}: 必须实际加载 owning Source ${path}`)
    assert.ok(entries.every(value => value.originalSHA256 === hash), `${name}: owning input bytes 不同 ${path}`)
  }
  const inventory = Object.fromEntries(loaded.map(value => [value.path, value.originalSHA256]))
  if (!candidateInputs) {
    candidateInputs = inputs; loadedCandidate = inventory
    for (const [path, hash] of Object.entries(inventory)) {
      const bytes = await readFile(resolve(root, path)); assert.equal(sha(bytes), hash, `${name}: 消费后的候选输入不能漂移 ${path}`)
      const snapshot = resolve(evidence, 'source', path)
      await mkdir(dirname(snapshot), { recursive: true }); await writeFile(snapshot, bytes)
    }
    baselineConsumed = Object.fromEntries(loaded.filter(value => [appPath, panelPath].includes(value.path)).map(value => [value.path, value.consumedSHA256]))
  } else {
    assert.deepEqual(inputs, candidateInputs, `${name}: 所有 baseline/mutant/restored 的 original Source 相等`)
    assert.deepEqual(inventory, loadedCandidate, `${name}: 所有实际 loaded 输入集合与 SHA 相等`)
  }
  const parent = await json(resolve(output, 'parent-cost.json'))
  assert.ok(parent.rawEvents.length > 0, `${name}: runtime raw 非空`)
  assert.ok(parent.summary.notifications >= 6 && parent.summary.appRenders >= 6 && parent.summary.onCloseIdentities.length >= 6,
    `${name}: 必须先取得实际通知、App 更新及原 JSX callback 引用机会`)
  let owningFailures
  if (expected) {
    assert.notEqual(exitCode, 0, `${name}: 真实 Source mutant 白绿`)
    const failures = assertions.filter(value => value.status === 'failed' && value.fullName.includes(expected.test))
    assert.ok(failures.length > 0, `${name}: specific owning 场景没有红`)
    assert.ok(failures.some(value => value.failureMessages.some(message => message.includes('AssertionError') && message.includes(expected.message))),
      `${name}: 必须命中 specific owning AssertionError，setup/compile/旁支不算 RED`)
    const changed = loaded.filter(value => value.path === expected.path)
    assert.ok(changed.length > 0 && changed.every(value => value.consumedSHA256 !== baselineConsumed[expected.path]), `${name}: mutant Source 没实际消费`)
    owningFailures = failures.map(value => value.fullName)
  } else {
    assert.equal(exitCode, 0, `${name}: 必须 GREEN；见 ${output}/run.log`)
    assert.equal(report.numFailedTests, 0)
    for (const test of tests) {
      const files = report.testResults.filter(value => value.name.endsWith(test))
      assert.equal(files.length, 1, `${name}: 必须执行原非空 owning/adjacent 文件 ${test}`)
      assert.ok(files[0].assertionResults.length > 0)
    }
    for (const file of ['parent-cost', 'public-route', 'config-publication', 'prompt-and-close']) {
      const raw = await json(resolve(output, `${file}.json`))
      assert.equal(raw.passed, true, `${name}: 原 actual App ${file} 正控必须通过`)
      assert.ok(raw.rawEvents.length > 0, `${name}: 原 actual App ${file} raw 非空`)
    }
    if (name === 'restored') for (const path of [appPath, panelPath]) {
      const consumed = loaded.filter(value => value.path === path)
      assert.ok(consumed.length > 0 && consumed.every(value => value.consumedSHA256 === baselineConsumed[path]), 'exact restored consumed bytes 必须相等')
    }
  }
  results.push({ name, mutant, exitCode, collectedTests: report.numTotalTests, owningFailures,
    owningSourceInputs: inputs, loadedSourceSHA256: sha(await readFile(resolve(output, 'loaded-source.jsonl'))),
    vitestSHA256: sha(await readFile(resolve(output, 'vitest.json'))), parentCostSHA256: sha(await readFile(resolve(output, 'parent-cost.json'))),
    parentSummary: parent.summary })
  console.log(`${name}: ${expected ? 'specific AssertionRED' : 'GREEN'} (${report.numTotalTests} collected)`)
}

let completed = false, failure
try {
  if (mode === '--callers') await callers()
  else {
    await run('baseline', 'baseline')
    if (mode === '--mutations') {
      await run('memo-removed', 'memo-removed', { path: panelPath, test: 'actual App parent cost', message: '无关 App parent 不渲染原 Settings owner' })
      await run('callback-unstable', 'callback-unstable', { path: appPath, test: 'actual App parent cost', message: '实际 JSX close callback 唯一稳定身份' })
      await run('frozen-props', 'frozen-props', { path: panelPath, test: 'actual App public SettingsNavigation', message: 'App public route 的 initialSection 必须进入原 Panel' })
      await run('restored', 'baseline')
    }
  }
  completed = true
} catch (error) { failure = { name: error.name, message: error.message }; throw error }
finally {
  const productAfter = Object.fromEntries(await Promise.all(Object.keys(originalProductSource).map(async path => [path, sha(await readFile(resolve(root, path)))])))
  const proofAfter = Object.fromEntries(await Promise.all(Object.keys(proofInputs).map(async path => [path, sha(await readFile(resolve(root, path)))])))
  let integrityFailure
  try {
    assert.deepEqual(productAfter, originalProductSource, '私有 transform mutations 不得改真实产品 Source')
    assert.deepEqual(proofAfter, proofInputs, 'proof 输入不能跟随 mutant 改写')
    if (loadedCandidate) for (const [path, hash] of Object.entries(loadedCandidate)) assert.equal(sha(await readFile(resolve(root, path))), hash, `实际 Source 输入结束仍相等 ${path}`)
  } catch (error) { integrityFailure = error; completed = false }
  const receipt = { schema: 'agentmux.settings-parent-cost-verification.v1', completed, mode, failure,
    integrityFailure: integrityFailure ? { name: integrityFailure.name, message: integrityFailure.message } : undefined,
    originalProductSource, exactSourceAfter: productAfter, proofInputs, loadedCandidate,
    sourceIdentity: candidateInputs ? sha(JSON.stringify(candidateInputs)) : sha(JSON.stringify(originalProductSource)),
    noProductSourceWriter: true, mutationsInPrivateVitestTransformOnly: true,
    observationReferenceReturnedUnchanged: true, developmentSourceOnly: true, liveUserPerformanceClaimed: false,
    evidenceDirectory: evidence, results }
  await writeFile(resolve(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  if (completed) await writeFile(resolve(evidenceBase, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(`receipt: ${resolve(evidence, 'receipt.json')}`)
  if (integrityFailure) throw integrityFailure
}
