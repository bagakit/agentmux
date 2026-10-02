import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '../../..')
const evidence = resolve(root, '.tmp/host-ui-qualification/launcher')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const read = path => readFileSync(resolve(root, path))
const json = path => JSON.parse(read(path))
const binding = path => ({ path, sha256: sha(read(path)) })
const source = name => `apps/desktop/src/renderer/src/${name}`
const targetTest = 'apps/desktop/test/launcher-host-target.test.tsx'
const spatialTest = 'apps/desktop/test/desktop-spatial-state.test.ts'
const tests = [targetTest, spatialTest, 'apps/desktop/test/new-tab-resource-contract.test.ts',
  'apps/desktop/test/launcher-entry-polish.test.tsx', 'apps/desktop/test/create-note-wiring.test.tsx',
  'apps/desktop/test/workbench-tabs.test.ts', 'apps/desktop/test/workbench-region-store.test.ts']
const product = ['components/NewTabSurface.tsx', 'components/LauncherEnvironment.tsx',
  'components/LauncherExecutionPicker.tsx', 'components/LauncherFileReferences.tsx',
  'lib/launcher-workspace.ts', 'lib/note-creation.ts', 'lib/session-state.ts',
  'lib/desktop-spatial-state.ts', 'lib/control.ts', 'lib/workbench-tabs.ts',
  'lib/workbench-resource-display.ts', 'store.ts', 'styles/launcher.css'].map(source)
const receiptPath = resolve(evidence, 'source-receipt.json')
const mode = process.argv[2]
assert.ok(['--source', '--receipt'].includes(mode) && process.argv.length === 3, 'Use --source or --receipt')
const output = mode === '--source' ? resolve(evidence, ("run-" + (globalThis.crypto.randomUUID()) + "")) : evidence
mkdirSync(output, { recursive: true })

function checkReport(record, red = false) {
  const result = json(record.report)
  assert.equal(sha(read(record.report)), record.reportSHA256, 'Exact completed test report')
  const assertions = result.testResults.flatMap(file => file.assertionResults)
  assert.ok(assertions.length > 0 && result.numTotalTests > 0, 'Nonempty actual test collection')
  const failures = assertions.filter(test => test.status === 'failed')
  assert.equal(record.exitCode, red ? 1 : 0)
  if (red) assert.ok(failures.some(test => test.failureMessages.some(message => message.includes('AssertionError'))), 'Actual assertion RED, not setup failure')
  else assert.ok(result.numPassedTests > 0 && result.numFailedTests === 0, 'Restored product GREEN')
  return result
}
function run(label, paths = tests, name, mutation) {
  const report = resolve(output, `${label}.json`)
  const args = ['node_modules/vitest/vitest.mjs', 'run', ...paths, '--maxWorkers=1', '--reporter=json', `--outputFile=${report}`]
  if (name) args.push('-t', name)
  let capture
  if (mutation) {
    const path = resolve(root, mutation.path), original = read(mutation.path).toString()
    assert.equal(original.split(mutation.from).length, 2, 'One actual production block')
    capture = resolve(output, `${label}.consumed.json`)
    const config = resolve(output, `${label}.config.mts`)
    // Transform the real Vite input in a private test process. The shared file and
    // Farm's compiled candidate remain untouched while independent proofs run.
    writeFileSync(config, `import base from ${JSON.stringify(resolve(root, 'vitest.config.ts'))};
import {defineConfig} from 'vitest/config';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
const target=${JSON.stringify(path)},before=${JSON.stringify(mutation.from)},after=${JSON.stringify(mutation.to)},expected=${JSON.stringify(sha(original))};
const sha=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
export default defineConfig({...base,root:${JSON.stringify(root)},plugins:[...(base.plugins??[]),{
name:'private-launcher-product-mutation',enforce:'pre',transform(code:string,id:string){
 if(id.split('?')[0]!==target)return;
 if(sha(readFileSync(target))!==expected||sha(code)!==expected||code.split(before).length!==2)throw Error('Exact production input changed');
 const changed=code.replace(before,after);
 writeFileSync(${JSON.stringify(capture)},JSON.stringify({sourceSHA256:expected,consumedSHA256:sha(changed),bytes:Buffer.byteLength(changed)}));
 return {code:changed,map:null};
}}],test:{...base.test,include:${JSON.stringify(paths)},passWithNoTests:false,maxWorkers:1,fileParallelism:false}});
`)
    args.push('--config', config)
  }
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 120_000 })
  writeFileSync(resolve(output, `${label}.log`), (result.stdout ?? '') + (result.stderr ?? '') + (result.error?.stack ?? ''))
  assert.ok(!result.error, 'Test process completed')
  const consumed = capture ? json(capture) : undefined
  return { exitCode: result.status, report: relative(root, report), reportSHA256: sha(read(report)), ...(consumed ? { consumed } : {}) }
}
const mutations = [
  { id: 'borrow-tab-resource', path: source('lib/launcher-workspace.ts'),
    from: 'input.launcherWorkspaceId ?? input.launcherTabWorkspaceId', to: 'input.launcherTabWorkspaceId ?? input.launcherWorkspaceId',
    test: targetTest, name: 'selects the exact remote project' },
  { id: 'drop-empty-group-input', path: source('components/NewTabSurface.tsx'),
    from: 'const createdId = state.openLauncher({ workspaceId: workspace.id, tabGroupId, reveal: false,\n          initialInputs: { prompt, names, optionsByProvider } })',
    to: "const createdId = state.openLauncher({ workspaceId: workspace.id, tabGroupId, reveal: false,\n          initialInputs: { prompt: '', names, optionsByProvider } })",
    test: targetTest, name: 'materializes the empty Group' },
  { id: 'drop-spatial-region-resource', path: source('lib/desktop-spatial-state.ts'),
    from: 'const { regionId: _, kind, ...metadata } = surface;',
    to: 'const { regionId: _, kind, workspaceId: __, ...metadata } = surface;',
    test: spatialTest, name: 'keeps a Launcher execution resource separate' },
  { id: 'control-borrows-tab-resource', path: source('lib/control.ts'),
    from: 'workspaceId: launcher.workspaceId,', to: 'workspaceId: tab.workspaceId,',
    test: targetTest, name: 'public Control' },
  { id: 'terminal-failure-drops-executor', path: source('lib/session-state.ts'),
    from: '        ...launcher,\n        regionId,', to: '        regionId,',
    test: targetTest, name: 'a cold Terminal failure remounts' },
  { id: 'note-borrows-tab-resource', path: source('lib/note-creation.ts'),
    from: "surface?.kind !== 'launcher' || surface.workspaceId !== input.workspaceId",
    to: "surface?.kind !== 'launcher' || tab?.workspaceId !== input.workspaceId",
    test: targetTest, name: 'a remote Note writes and reads' }
]

if (mode === '--source') {
  const sourceBindings = product.map(binding)
  const inputBindings = [...tests, 'apps/desktop/test/helpers/composer-dom-fixture.tsx',
    'apps/desktop/test/helpers/client-ui-render.tsx', 'vitest.config.ts', 'vitest.setup.ts',
    'apps/desktop/tsconfig.json', 'tsconfig.base.json', 'packages/core/package.json',
    relative(root, import.meta.filename)].map(binding)
  const baseline = run('baseline'); checkReport(baseline)
  const results = []
  for (const mutation of mutations) {
    const path = resolve(root, mutation.path), original = read(mutation.path)
    assert.equal(sha(original), sourceBindings.find(input => input.path === mutation.path).sha256, 'Preserve concurrent Source')
    assert.equal(original.toString().split(mutation.from).length, 2, `Unique production block: ${mutation.id}`)
    const changed = original.toString().replace(mutation.from, mutation.to)
    const red = run(`red-${mutation.id}`, [mutation.test], mutation.name, mutation); checkReport(red, true)
    assert.equal(red.consumed.sourceSHA256, sha(original)); assert.equal(red.consumed.consumedSHA256, sha(changed))
    assert.ok(red.consumed.bytes > 0); assert.equal(sha(read(mutation.path)), sha(original), 'Shared product unchanged')
    const restored = run(`green-${mutation.id}`, [mutation.test], mutation.name); checkReport(restored)
    results.push({ id: mutation.id, path: mutation.path, originalSHA256: sha(original), mutatedSHA256: sha(changed), red, restored })
    console.log(`${mutation.id}: Assertion RED / exact restore GREEN`)
  }
  const definitions = [['resolveLauncherWorkspaceId', 'lib/launcher-workspace.ts'], ['setLauncherExecutionWorkspace', 'store.ts'],
    ['LauncherExecutionPicker', 'components/LauncherExecutionPicker.tsx'], ['LauncherFileReferences', 'components/LauncherFileReferences.tsx'],
    ['desktopSpatialGraph', 'lib/desktop-spatial-state.ts'], ['desktopWorkbenchFromSpatial', 'lib/desktop-spatial-state.ts'],
    ['workbenchTabDisplayWorkspaceId', 'lib/workbench-resource-display.ts'], ['reduceSessionLaunchFailed', 'lib/session-state.ts'],
    ['planControlOpen', 'lib/control.ts']]
  const callers = definitions.map(([symbol, owner]) => {
    const definition = source(owner), uses = []
    for (const path of product.filter(path => /\.tsx?$/.test(path) && path !== definition)) {
      const file = ts.createSourceFile(path, read(path).toString(), ts.ScriptTarget.Latest, true)
      function visit(node) {
        const expression = ts.isCallExpression(node) ? node.expression : ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node) ? node.tagName : null
        const name = expression && (ts.isIdentifier(expression) ? expression.text : ts.isPropertyAccessExpression(expression) ? expression.name.text : null)
        if (name === symbol) uses.push({ path, use: node.getText(file) })
        ts.forEachChild(node, visit)
      }
      visit(file)
    }
    assert.ok(uses.length > 0, `Real non-definition production caller: ${symbol}`)
    return { symbol, definition, uses }
  })
  const restored = run('restored'); checkReport(restored)
  const typecheck = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'apps/desktop/tsconfig.json'], { cwd: root, encoding: 'utf8', timeout: 120_000 })
  writeFileSync(resolve(output, 'typecheck.log'), (typecheck.stdout ?? '') + (typecheck.stderr ?? ''))
  assert.equal(typecheck.status, 0, 'Current production compiler')
  for (const input of [...sourceBindings, ...inputBindings]) assert.equal(sha(read(input.path)), input.sha256, `Closed qualification input: ${input.path}`)
  const bytes = JSON.stringify({ schema: 'agentmux.launcher-host-target.source.v1', passed: true, sharedSourceModified: false,
    sourceBindings, inputBindings, baseline, restored, mutations: results, callers, typecheck: { exitCode: typecheck.status } }, null, 2) + '\n'
  writeFileSync(resolve(output, 'source-receipt.json'), bytes); writeFileSync(receiptPath, bytes)
  console.log(receiptPath)
} else {
  const proof = json(receiptPath)
  assert.equal(proof.schema, 'agentmux.launcher-host-target.source.v1'); assert.equal(proof.passed, true)
  for (const input of [...proof.sourceBindings, ...proof.inputBindings]) assert.equal(sha(read(input.path)), input.sha256, `Current input: ${input.path}`)
  checkReport(proof.baseline); checkReport(proof.restored)
  assert.equal(proof.mutations.length, mutations.length)
  for (const mutation of proof.mutations) {
    assert.notEqual(mutation.originalSHA256, mutation.mutatedSHA256)
    assert.equal(sha(read(mutation.path)), mutation.originalSHA256)
    assert.equal(mutation.red.consumed.sourceSHA256, mutation.originalSHA256)
    assert.equal(mutation.red.consumed.consumedSHA256, mutation.mutatedSHA256)
    checkReport(mutation.red, true); checkReport(mutation.restored)
  }
  assert.ok(proof.callers.length > 0 && proof.callers.every(caller => caller.uses.length > 0))
  for (const caller of proof.callers) for (const use of caller.uses) {
    assert.notEqual(use.path, caller.definition); assert.ok(!use.path.includes('/test/')); assert.ok(read(use.path).toString().includes(use.use))
  }
  assert.equal(proof.typecheck.exitCode, 0)
  const nativePath = process.env.AGENTMUX_HOST_UI_EXECUTION_PROOF ?? '.tmp/host-ui-execution/proof.json'
  const nativeBytes = read(nativePath), native = JSON.parse(nativeBytes)
  assert.equal(native.schema, 'agentmux.host-ui-execution.proof.v1'); assert.equal(native.passed, true)
  assert.equal(native.phases.length, 2); assert.ok(native.phases.every(phase => phase.exit.exitCode === 0 && phase.native.passed))
  assert.notEqual(native.phases[0].native.electronPid, native.phases[1].native.electronPid)
  assert.deepEqual(native.compiledBefore, native.compiledAfter)
  assert.ok(native.cleanup.errors.length === 0 && native.cleanup.remaining.length === 0)
  for (const input of proof.sourceBindings) assert.equal((native.consumedModules[input.path] ?? native.consumedModules[resolve(root, input.path)])?.sourceSHA256, input.sha256, `Actual compiled product: ${input.path}`)
  const review = json(process.env.AGENTMUX_HOST_UI_VISUAL_REVIEW ?? '.tmp/host-ui-execution/independent-visual-review.json')
  assert.equal(review.conclusion, 'accepted'); assert.ok(review.reviewer); assert.equal(review.proofSHA256, sha(nativeBytes))
  assert.ok(native.screenshots.length > 0 && review.screenshots.length === native.screenshots.length)
  for (const frame of native.screenshots) {
    assert.equal(sha(read(frame.absolutePath)), frame.sha256)
    const viewed = review.screenshots.find(one => one.absolutePath === frame.absolutePath)
    assert.ok(viewed?.viewed); assert.equal(viewed.sha256, frame.sha256)
  }
  console.log(JSON.stringify({ passed: true, sourceReceipt: receiptPath, nativeProof: nativePath, reviewer: review.reviewer,
    sourceInputs: proof.sourceBindings.length, causalMutations: proof.mutations.length, screenshots: native.screenshots.length }))
}
