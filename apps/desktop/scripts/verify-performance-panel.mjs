import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { capturePerformancePanel } from './fixtures/performance-panel/capture.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const args = process.argv.slice(2), mode = args[0]
assert.ok(['--interaction', '--mutations', '--callers', '--placement', '--buttons'].includes(mode), '必须选择一个非空验证模式')
assert.ok(args.length === 1 || args.length === 2 && ['--interaction','--buttons'].includes(mode) && args[1] === '--capture-only', '只接受明确模式及首次采图开关')
const execute = promisify(execFile), sha = bytes => createHash('sha256').update(bytes).digest('hex')
const base = resolve(root, '.bagakit/design/toolkit-performance-20261004/ui-evidence', mode.slice(2))
await mkdir(base, { recursive: true }); const evidence = await mkdtemp(resolve(base, 'run-'))
const component = 'apps/desktop/src/renderer/src/components/performance/'
const productPaths = ['apps/desktop/src/renderer/src/App.tsx', 'apps/desktop/src/renderer/src/components/TopRowChrome.tsx',
  'apps/desktop/src/renderer/src/components/WindowUtilityBar.tsx', 'apps/desktop/src/renderer/src/styles/agent.css',
  ...['PerformancePanel', 'PerformancePopover', 'PerformanceOverview', 'PerformanceScript'].map(name => component + name + '.tsx'),
  'apps/desktop/src/renderer/src/lib/use-performance-observation.ts', 'apps/desktop/src/renderer/src/styles/performance-toolkit.css', 'apps/desktop/src/renderer/src/styles/index.css']
const config = 'apps/desktop/scripts/fixtures/performance-panel/vitest.config.mts'
const test = 'apps/desktop/test/performance-panel-interaction.test.tsx'
const proofPaths = [fileURLToPath(import.meta.url), config, test, 'apps/desktop/scripts/fixtures/performance-panel/data.ts',
  'apps/desktop/scripts/fixtures/performance-panel/capture.mjs', 'apps/desktop/scripts/fixtures/performance-panel/entry.tsx',
  'apps/desktop/scripts/fixtures/performance-panel/main.cjs', 'apps/desktop/scripts/fixtures/performance-panel/preload.cjs',
  'apps/desktop/scripts/fixtures/performance-panel/owner-entry.ts',
  'apps/desktop/scripts/fixtures/performance-panel/index.html', 'apps/desktop/scripts/fixtures/settings-overview/vitest.config.mts',
  'apps/desktop/scripts/probe-process.mjs', 'apps/desktop/test/helpers/composer-dom-fixture.tsx', 'vitest.setup.ts']
const snapshot = async (paths, folder) => Object.fromEntries(await Promise.all(paths.map(async path => {
  const bytes = await readFile(resolve(root, path)), key = path.startsWith(root + '/') ? path.slice(root.length + 1) : path
  const output = resolve(evidence, folder, key); await mkdir(dirname(output), { recursive: true }); await writeFile(output, bytes)
  assert.equal(sha(await readFile(output)), sha(bytes)); return [key, sha(bytes)]
})))
const products = await snapshot(productPaths, 'source'), proof = await snapshot(proofPaths, 'proof')
const results = []; let inventory, consumed, completed = false, failure, native
const json = async file => JSON.parse(await readFile(file, 'utf8'))

async function callers() {
  const ts = createRequire(resolve(root, 'apps/desktop/package.json'))('typescript'), calls = []
  const collect = async (path, predicate) => {
    const ast = ts.createSourceFile(path, await readFile(resolve(root, path), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const found = []; const visit = node => { if (predicate(node, ast)) found.push({ path, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1, source: node.getText(ast) }); ts.forEachChild(node, visit) }; visit(ast)
    assert.ok(found.length > 0, '排除定义/import/test/fixture 的产品 caller 必须非空: ' + path); calls.push(...found)
    return found
  }
  const jsx = name => (node, ast) => (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(ast) === name
  const app = await collect(productPaths[0], jsx('PerformancePanel')); assert.equal(app.length, 1)
  await collect(productPaths[2], (node, ast) => ts.isJsxExpression(node) && node.expression?.getText(ast) === 'toolkit')
  const settings = await collect(productPaths[1], (node, ast) => ts.isCallExpression(node) && node.expression.getText(ast) === 'settings.open' && node.arguments[0]?.getText(ast) === "'overview'")
  assert.equal(settings.length, 1, '唯一普通 Settings 产品入口')
  await collect(component + 'PerformancePanel.tsx', (node, ast) => ts.isCallExpression(node) && node.expression.getText(ast) === 'usePerformanceObservation' && node.arguments[0]?.getText(ast) === 'api.toolkit')
  for (const name of ['PerformancePopover', 'PerformanceOverview', 'PerformanceScript']) await collect(component + 'PerformancePanel.tsx', jsx(name))
  await collect('apps/desktop/src/renderer/src/lib/use-performance-observation.ts', (node, ast) => ts.isCallExpression(node) && node.expression.getText(ast) === 'api.observe')
  await collect(component + 'PerformanceScript.tsx', (node, ast) => ts.isCallExpression(node) && node.expression.getText(ast) === 'api.script')
  if(mode==='--buttons') {
    await collect(productPaths[0], jsx('SurfaceSwitch'));await collect(productPaths[0], jsx('WindowUtilityBar'))
    const source=await readFile(resolve(root,'apps/desktop/src/renderer/src/styles/index.css'),'utf8')
    const imports=[...source.matchAll(/^\s*@import\s+['"]([^'"]+)['"];\s*$/gm)].map(match=>match[1]);assert.ok(imports.length>0,'产品stylesheet入口扫描非空')
    for(const file of ['./agent.css','./performance-toolkit.css'])assert.ok(imports.includes(file),'普通按钮owning stylesheet实际被产品入口消费: '+file)
    calls.push({path:'apps/desktop/src/renderer/src/styles/index.css',source:imports.filter(file=>file==='./agent.css'||file==='./performance-toolkit.css')})
  }
  await writeFile(resolve(evidence, 'callers.json'), JSON.stringify({ passed: true, calls, definitionsImportsTestsFixturesExcluded: true, source: products }, null, 2) + '\n')
  console.log(`callers: ${calls.length} 个非空产品调用点`)
}

async function buttons() {
  await callers()
  const sealedPath=resolve(base,'product/receipt.json')
  if(args[1]!=='--capture-only') {
    const sealed=await json(sealedPath)
    assert.equal(sealed.mode,'--buttons');assert.equal(sealed.captureOnly,true);assert.equal(sealed.completed,true,'先完成本候选有限正控/变异与精确恢复采图')
    assert.deepEqual(sealed.products,products,'封存的产品Source精确不变');assert.deepEqual(sealed.proof,proof,'封存的验证输入精确不变')
    assert.equal(sealed.results.length,4,'有限control/state/focus/restored四个实际入口')
    for(const result of sealed.results){
      const captured=await json(resolve(result.evidence,'receipt.json'));assert.equal(sha(await readFile(resolve(result.evidence,'receipt.json'))),result.receiptSHA256)
      for(const [path,input]of Object.entries(captured.inputs))assert.equal(sha(await readFile(resolve(root,path))),input.sha256,'sealed实际Source不漂移: '+path)
      for(const item of [...captured.compiled,...captured.frames])assert.equal(sha(await readFile(resolve(captured.evidence,item.file))),item.sha256,'sealed实际compiled/PNG读回')
    }
    native=sealed.native;results.push(...sealed.results)
    const review=await json(resolve(native.evidence,'independent-visual-review.json'))
    assert.equal(review.sourceIdentity,native.sourceIdentity);assert.equal(review.verdict,'PASS');assert.deepEqual(review.mustFix,[])
    assert.ok(review.images.length>0,'独立亲看实际图片非空')
    for(const frame of native.frames)assert.equal(review.images.find(item=>item.file===frame.file)?.sha256,frame.sha256,'图审精确消费本候选完整图/关键态')
    return
  }
  let originalInputs,originalCss
  for(const [name,cssMutant,message]of [['control','baseline'],['state','state','真实状态面与 idle 不同'],['focus','focus','键盘焦点有完整可见轮廓'],['restored','baseline']]){
    const captured=await capturePerformancePanel({root,evidence:resolve(evidence,name),captureScope:'buttons',cssMutant})
    assert.equal(captured.sourceCurrentReadbackExact,true,'有限actual App输入不得漂移')
    assert.deepEqual(captured.remainingPrivateProcesses,[]);assert.equal(captured.cssInputs.length,4,'actual PostCSS owning rules非空')
    const inputs=Object.fromEntries(Object.entries(captured.inputs).map(([path,value])=>[path,value.sha256]))
    if(!originalInputs){originalInputs=inputs;originalCss=captured.cssInputs}
    else assert.deepEqual(inputs,originalInputs,'control/mutant/exact restored实际original输入字节不变')
    const raw=await json(resolve(captured.evidence,'buttons-render.json'))
    if(message){
      assert.equal(captured.completed,false,'实际CSS mutant不得白绿');assert.equal(captured.processes.length,1);assert.equal(captured.processes[0].timedOut,false)
      assert.notEqual(captured.processes[0].exitCode,0);assert.equal(raw.failure?.name,'AssertionError');assert.ok(raw.failure.message.includes(message),'owning SpecificAssertionRED，不收setup/build/旁支错误: '+message)
      assert.equal(captured.cssInputs.filter(rule=>rule.mutated&&rule.originalSHA256!==rule.consumedSHA256).length,2,'两处owning CSS input真实变异')
    } else {
      assert.equal(captured.completed,true,'有限按钮actual App正控必须通过，见 '+captured.evidence)
      assert.equal(raw.qualified,true);assert.equal(raw.statusbarGeometry.length,9);assert.equal(raw.buttonPointer.length,7);assert.equal(raw.statusbarKeyboard.length,3);assert.ok(raw.buttonFocus.length>0)
      assert.equal(raw.buttonReduced.matchMedia,true);assert.equal(raw.afterDisposalLeases,0);assert.ok(captured.frames.length>=5)
      if(name==='control')native=captured
      else {
        assert.deepEqual(captured.cssInputs,originalCss,'exact restored实际owning CSS consumption精确一致')
        assert.deepEqual(captured.compiled.filter(item=>item.file.endsWith('.css')),native.compiled.filter(item=>item.file.endsWith('.css')),'exact restored实际compiled CSS精确一致')
      }
    }
    results.push({name,cssMutant,completed:captured.completed,specificAssertion:message??null,evidence:captured.evidence,
      receiptSHA256:sha(await readFile(resolve(captured.evidence,'receipt.json'))),sourceIdentity:captured.sourceIdentity})
    console.log(name+': '+(message?'loaded CSS SpecificAssertionRED':'有限按钮GREEN'))
  }
}

async function run(name, mutant, expected = []) {
  const directory = resolve(evidence, name); await mkdir(directory, { recursive: true })
  let exitCode = 0, stdout = '', stderr = ''
  try { const output = await execute('pnpm', ['exec', 'vitest', 'run', '--config', config, '--reporter=json', '--outputFile', resolve(directory, 'vitest.json')], {
    cwd: root, timeout: 120000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, pnpm_config_verify_deps_before_run: 'false',
      AGENTMUX_PERFORMANCE_UI_MUTANT: mutant, AGENTMUX_PERFORMANCE_UI_EVIDENCE: directory } }); stdout = output.stdout; stderr = output.stderr
  } catch (error) { exitCode = typeof error.code === 'number' ? error.code : -1; stdout = error.stdout ?? ''; stderr = error.stderr ?? '' }
  await writeFile(resolve(directory, 'run.log'), stdout + stderr)
  const report = await json(resolve(directory, 'vitest.json'))
  const files = report.testResults.filter(file => file.name.endsWith(test)); assert.equal(files.length, 1, 'actual owning 文件非空唯一')
  const assertions = files[0].assertionResults; assert.equal(assertions.length, 6, 'setup/collection 不能代签六个实际 owning cases')
  const loaded = (await readFile(resolve(directory, 'loaded-source.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.ok(loaded.length > 0)
  const inputs = Object.fromEntries(loaded.map(value => [value.path, value.originalSHA256]))
  for (const path of productPaths.filter(path => /\.[jt]sx?$/u.test(path))) {
    assert.ok(inputs[path], 'actual loaded owning Source 非空: ' + path); assert.equal(inputs[path], products[path])
  }
  const consumedNow = Object.fromEntries(loaded.map(value => [value.path, value.consumedSHA256]))
  if (!inventory) { inventory = inputs; consumed = consumedNow }
  else assert.deepEqual(inputs, inventory, 'control/mutant/exact restored 的实际原输入集合和字节必须相同')
  if (expected.length) {
    assert.notEqual(exitCode, 0, '实际 loaded mutant 不得白绿')
    for (const [title, message, path] of expected) {
      const owning = assertions.filter(value => value.status === 'failed' && value.fullName.includes(title)); assert.ok(owning.length > 0, 'specific owning case 必须 RED: ' + title)
      assert.ok(owning.some(value => value.failureMessages.some(text => text.includes('AssertionError') && text.includes(message))), '必须命中指定行为 Assertion，setup/编译/旁支失败不算: ' + message)
      assert.ok(loaded.some(value => value.path === path && value.consumedSHA256 !== consumed[path]), '变异承重点必须实际消费: ' + path)
    }
  } else {
    assert.equal(exitCode, 0, `actual owning GREEN 必须成立，见 ${directory}/run.log`); assert.equal(report.numFailedTests, 0)
    const cost = (await readFile(resolve(directory, 'cost.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(cost.length, 1); assert.equal(cost[0].sessionCount, 128); assert.equal(cost[0].hostCount, 8)
    for (const scope of ['closed', 'open', 'afterClose']) { assert.ok(cost[0][scope].app >= 6); assert.equal(cost[0][scope].panel, 0); assert.equal(cost[0][scope].visits, 0) }
    if (name === 'restored') assert.deepEqual(consumedNow, consumed, 'exact restore 实际 consumed 字节相同')
  }
  results.push({ name, mutant, exitCode, collected: assertions.length, owningAssertions: assertions.map(value => ({ title: value.fullName, status: value.status, failureMessages: value.failureMessages })),
    loadedSHA256: sha(await readFile(resolve(directory, 'loaded-source.jsonl'))), reportSHA256: sha(await readFile(resolve(directory, 'vitest.json'))) })
  console.log(`${name}: ${expected.length ? 'specific AssertionRED' : 'GREEN'}，6 actual owning cases`)
}

try {
  if(mode==='--buttons')await buttons()
  else if (mode === '--callers') await callers()
  else {
    await run('control', 'baseline')
    if (mode === '--mutations') {
      const hook = 'apps/desktop/src/renderer/src/lib/use-performance-observation.ts'
      await run('consumption', 'consumption', [['通过 actual App Settings', '实际 Toolkit 观察 consumer 非空', hook]])
      await run('release', 'release', [['同步跨桥 handle', 'Opening observation handle is immediately disposed after close', hook]])
      await run('focus', 'focus', [['实际 Prompt textarea', 'Hover preserves the original input focus', component + 'PerformancePopover.tsx']])
      await run('age', 'age', [['source 自身年龄', 'Source age uses its last successful reading', component + 'PerformanceOverview.tsx'],
        ['selected Run 来源时间', 'Cached available source must not append a duplicate point after the gap', component + 'PerformanceOverview.tsx'],
        ['source 自身年龄', 'Pausing this UI leaves an App gap even while another consumer continues', component + 'PerformanceOverview.tsx'],
        ['source 自身年龄', 'App source watermark must remain independent from the envelope gap time', component + 'PerformanceOverview.tsx']])
      await run('placement', 'placement', [['通过 actual App Settings', 'Settings remains in the left navigation', productPaths[1]]])
      await run('restored', 'baseline')
    } else if (mode === '--placement') {
      native = await capturePerformancePanel({ root, evidence: resolve(evidence, 'native'), captureScope: 'placement' })
      assert.equal(native.captureScope, 'placement')
      assert.equal(native.completed, true, '本次 placement 有限 Renderer 交互必须通过')
    } else {
      const captureOnly = args[1] === '--capture-only'
      native = captureOnly ? await capturePerformancePanel({ root, evidence: resolve(evidence, 'native') })
        : await json(resolve(base, 'product/receipt.json'))
      assert.equal(native.completed, true, 'actual mounted Renderer 交互必须通过')
      if (!captureOnly) {
        for (const [path, input] of Object.entries(native.inputs)) assert.equal(sha(await readFile(resolve(root, path))), input.sha256, 'sealed control 必须与当前实际 Source 相同: ' + path)
        for (const item of [...native.compiled, ...native.frames]) assert.equal(sha(await readFile(resolve(native.evidence, item.file))), item.sha256, 'sealed compiled/PNG readback exact')
        const review = await json(resolve(native.evidence, 'independent-visual-review.json'))
        assert.equal(review.sourceIdentity, native.sourceIdentity); assert.equal(review.verdict, 'PASS'); assert.deepEqual(review.mustFix, [])
        for (const frame of native.frames) assert.equal(review.images.find(image => image.file === frame.file)?.sha256, frame.sha256, '独立图审必须绑定本次实际 PNG')
      }
    }
  }
  completed = true
} catch (error) { failure = { name: error.name, message: error.message, stack: error.stack }; console.error(error); process.exitCode = 1 }
finally {
  let integrityFailure
  try {
    for (const [path, hash] of Object.entries({ ...products, ...proof, ...inventory })) assert.equal(sha(await readFile(resolve(root, path))), hash, '结束 actual Source/proof 不得漂移: ' + path)
  } catch (error) { completed = false; integrityFailure = String(error); process.exitCode = 1 }
  const receipt = { schema: 'agentmux.performance-ui-verification.v1', completed, mode, captureOnly: args[1] === '--capture-only', qualificationScope: mode === '--buttons' ? 'statusbar-seven-buttons-only' : mode === '--placement' ? 'settings-left-placement-only' : 'original-task-verification', products, proof, loadedSource: inventory,
    sourceIdentity: sha(JSON.stringify(products)), failure, integrityFailure, results, native, evidence,
    productSourceWriterUsed: false, mutationsInPrivateTransformOnly: true,
    boundary: '局部实际 App/UI owning 成本与私有 Renderer 交互；官方 Toolkit/ctxmux 链须 joined Backend 收据，不签用户现场卡顿或全 Native。' }
  await writeFile(resolve(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  if(mode==='--buttons'&&args[1]==='--capture-only'&&completed){await mkdir(resolve(base,'product'),{recursive:true});await writeFile(resolve(base,'product/receipt.json'),JSON.stringify(receipt,null,2)+'\n')}
  console.log('receipt: ' + resolve(evidence, 'receipt.json'))
}
