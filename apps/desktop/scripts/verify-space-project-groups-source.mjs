import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../../..')
const renderer = 'apps/desktop/src/renderer/src/'
const catalog = renderer + 'lib/space-agent-control.ts', adapter = renderer + 'lib/desktop-spatial-state.ts'
const store = renderer + 'store.ts', helper = renderer + 'lib/cross-device-project-groups.ts'
const sidebar = renderer + 'components/WorkspaceSidebar.tsx', tree = renderer + 'components/ProjectGroupsTree.tsx'
const dialog = renderer + 'components/ProjectGroupDialog.tsx', owner = 'packages/core/src/spatial-state.ts'
const graph = 'packages/core/src/spatial-graph.ts'
const tests = ['apps/desktop/test/cross-device-project-groups.test.ts', 'apps/desktop/test/cross-device-project-groups.test.tsx']
const testHelper = 'apps/desktop/test/helpers/cross-device-project-groups.ts'
const desktopGlobals = renderer + 'global.d.ts'
const sources = [catalog, adapter, store, helper, sidebar, tree, dialog, owner, graph, 'packages/core/src/space-control.ts',
  renderer + 'components/WorkspaceRowContextMenu.tsx', renderer + 'hooks/useGitProjectAssociations.ts', renderer + 'lib/api.ts',
  renderer + 'lib/workspace-projects.ts', renderer + 'lib/workbench-persistence.ts', renderer + 'lib/workbench-tabs.ts',
  renderer + 'components/SpaceCreateMenu.tsx', renderer + 'components/SpaceSectionHeader.tsx', renderer + 'components/HostFolderDialog.tsx', renderer + 'styles/project-groups.css', renderer + 'styles/index.css', 'apps/desktop/src/shared/space-addresses.ts',
  'apps/desktop/src/shared/contracts.ts', desktopGlobals]
const captured = [catalog, adapter, store, helper, sidebar, tree, dialog, owner, graph, renderer + 'components/SpaceCreateMenu.tsx', renderer + 'components/HostFolderDialog.tsx', ...tests, testHelper]
const inputs = [...sources, ...tests, testHelper, 'apps/desktop/scripts/verify-space-project-groups-source.mjs',
  'vitest.config.ts', 'vitest.setup.ts', 'vitest.dist-freshness.ts', 'tsconfig.base.json', 'apps/desktop/tsconfig.json', 'pnpm-lock.yaml']
const dependencies = ['packages/core/package.json', 'packages/core/dist/index.js', 'packages/core/dist/index.d.ts',
  'packages/core/dist/spatial-graph.js', 'packages/core/dist/spatial-graph.d.ts', 'packages/core/dist/spatial-state.js',
  'packages/core/dist/spatial-state.d.ts', 'packages/core/dist/space-control.d.ts', 'packages/demand/package.json',
  'packages/demand/dist/src/index.js', 'packages/demand/dist/src/index.d.ts']
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const read = file => fs.readFile(path.isAbsolute(file) ? file : path.join(root, file))
const json = async file => JSON.parse(await read(file))
const hashes = async files => Object.fromEntries(await Promise.all(files.map(async file => [file, sha(await read(file))])))
const evidence = path.join(root, '.tmp/cross-device-project-groups')
await fs.mkdir(evidence, { recursive: true, mode: 0o700 })
const run = path.join(evidence, ("source-run-" + (globalThis.crypto.randomUUID()) + "")); await fs.mkdir(run, { mode: 0o700 })
const receipt = { schema: 'agentmux.cross-device-project-groups.source.v1', passed: false, sourceRoot: root, runRoot: run,
  sharedSourceModified: false, sharedDistModified: false, originalAppOrRunTouched: false, checks: [], errors: [],
  boundary: 'Actual Store initialization, mounted Sidebar/Dialog/Tree and private filesystem Core spatial owner. No Native, SSH, visual or whole Feature approval.' }
const write = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
async function execute(args, logPath) {
  const log = await fs.open(logPath, 'w', 0o600)
  try { return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env }, stdio: ['ignore', log.fd, log.fd] })
    child.once('error', reject); child.once('exit', (code, signal) => signal ? reject(Error(`Private qualification terminated by ${signal}`)) : resolve(code))
  }) } finally { await log.close() }
}

async function consumers() {
  const ts = createRequire(import.meta.url)('typescript')
  const required = [
    { definition: helper, file: store, expression: 'validateProjectGroup' },
    { definition: catalog, file: adapter, expression: 'spatialCatalog' },
    { definition: adapter, file: store, expression: 'desktopSpatialGraph' },
    { definition: store, file: dialog, expression: 'save', selector: 'saveProjectGroup' },
    { definition: helper, file: tree, expression: 'projectGroupMember' },
    { definition: store, file: sidebar, expression: 'dissolveProjectGroup', selector: 'dissolveProjectGroup' },
    { definition: tree, file: sidebar, jsx: 'ProjectGroupsTree' }
  ], result = []
  for (const entry of required) {
    assert.notEqual(entry.definition, entry.file)
    const source = (await read(entry.file)).toString(), ast = ts.createSourceFile(entry.file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const hits = [], bindings = []
    const visit = node => {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === entry.expression) hits.push(node.getText(ast))
      if (entry.jsx && (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(ast) === entry.jsx) hits.push(node.getText(ast))
      if (entry.selector && ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === entry.expression &&
        node.initializer && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(ast) === 'useAppStore') {
        const callback = node.initializer.arguments[0]
        if (callback && ts.isArrowFunction(callback) && callback.parameters.length === 1 && ts.isIdentifier(callback.parameters[0].name) &&
          ts.isPropertyAccessExpression(callback.body) && callback.body.expression.getText(ast) === callback.parameters[0].name.text &&
          callback.body.name.text === entry.selector) bindings.push(node.getText(ast))
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
    assert.ok(hits.length > 0, `Actual non-import production caller is required: ${JSON.stringify(entry)}`)
    if (entry.selector) assert.ok(bindings.length > 0, 'Actual Store selector binding and alias call are both required')
    result.push({ ...entry, sourceSHA256: sha(source), hits, bindings })
  }
  return result
}

try {
  receipt.head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  receipt.inputsBefore = await hashes(inputs); receipt.dependencyInputsBefore = await hashes(dependencies)
  const typeConfig = path.join(run, 'owning-types.json')
  await write(typeConfig, { extends: path.join(root, 'apps/desktop/tsconfig.json'),
    compilerOptions: { types: ['node', path.join(root, 'apps/desktop/node_modules/vite/client')] },
    include: [...tests, desktopGlobals].map(file => path.join(root, file)) })
  receipt.typechecks = []
  for (const [id, config] of [['owning-types', typeConfig], ['desktop-types', path.join(root, 'apps/desktop/tsconfig.json')]]) {
    const log = path.join(run, id + '.log'), args = ['node_modules/typescript/bin/tsc', '--project', config, '--noEmit']
    const exitCode = await execute(args, log)
    receipt.typechecks.push({ id, command: [process.execPath, ...args], exitCode, log, logSHA256: sha(await read(log)) })
    assert.equal(exitCode, 0, 'Actual owning tests and strict Desktop Source must typecheck')
  }
  const mutations = [
    { id: 'omit-catalog-group-capture', target: catalog, before: '...(state.projectGroups ? { projectGroups: state.projectGroups } : {}), ', after: '',
      testcase: 'saves a manual group through Core ACK and keeps exact original surfaces' },
    { id: 'allow-omitted-group-removal', target: owner,
      before: 'if (current?.graph.projectGroups?.some(group => !groupIds.has(group.groupId) && !removedGroupIds.has(group.groupId))) {', after: 'if (false) {',
      testcase: 'requires exact group deletion intent and retains data on an omitted group write' },
    { id: 'drop-watch-during-config-gap', target: store,
      before: 'if(!current.config) { set({projectGroups:saved.graph.projectGroups ?? []}); return }', after: 'if(!current.config) return',
      testcase: 'applies a group watch without resource config and does not overwrite the new name when config returns' },
    { id: 'hide-original-folder-selection', target: sidebar,
      before: 'const active = project.id === activeProjectId', after: 'const active = false',
      testcase: 'shows Git associations through the real API consumer and creates a manually chosen group' },
    { id: 'dissolve-as-entity-removal', target: store,
      before: 'coreSpatialPersistence?.removeProjectGroup(groupId)', after: 'coreSpatialPersistence?.removeEntity(groupId)',
      testcase: 'dissolves only organization, even if its opaque ID equals an unavailable Tab ID' },
    { id: 'reject-overlapping-core-members', target: graph,
      before: "    facts(g.projectGroups, 'groupId', group => {",
      after: "    const members = new Set<string>(); facts(g.projectGroups, 'groupId', group => { if (Array.isArray(group.projectIds)) for (const member of group.projectIds) { if (members.has(member)) invalid('exclusive group mutant'); members.add(member); }",
      testcase: 'persists overlapping groups and dissolves only the exact group without losing the workface' },
    { id: 'mix-host-folder-buckets', target: sidebar,
      before: 'groups: shownGroups.filter(group => group.hostId === hostId)', after: 'groups: shownGroups',
      testcase: 'separates host folders, keeps independent disclosure and renders original member icons in overlapping groups' },
    { id: 'hide-git-hint-when-grouped', target: sidebar,
      before: 'related.length > 0 ? <button', after: '!memberships.length && related.length > 0 ? <button',
      testcase: 'shows Git associations through the real API consumer and creates a manually chosen group' }

  ]
  const phases = [{ id: 'baseline', target: mutations[0].target, before: mutations[0].before, after: mutations[0].before }]
  for (const mutation of mutations) phases.push(mutation, { ...mutation, id: 'restored-' + mutation.id, after: mutation.before, testcase: undefined })
  let names
  for (const phase of phases) {
    assert.deepEqual(await hashes(inputs), receipt.inputsBefore, 'Owning Source/test/caller inputs changed')
    assert.deepEqual(await hashes(dependencies), receipt.dependencyInputsBefore, 'Public compiled inputs changed')
    const original = (await read(phase.target)).toString()
    assert.equal(original.split(phase.before).length - 1, 1, 'Exactly one real owning product block is required')
    const consumed = original.replace(phase.before, phase.after), own = path.join(run, phase.id)
    await fs.mkdir(own, { mode: 0o700 })
    const config = path.join(own, 'readonly.config.mts'), report = path.join(own, 'vitest.json'), capture = path.join(own, 'consumed-source.json')
    const taskReport = path.join(own, 'task-results.json'), taskReporter = path.join(own, 'task-reporter.mjs')
    await fs.writeFile(taskReporter, `import{writeFileSync}from'node:fs';
export default class { rows=[]; onTestCaseResult(test){const result=test.result();this.rows.push({name:test.name,fullName:test.fullName,state:result.state,errors:result.errors??[]});writeFileSync(${JSON.stringify(taskReport)},JSON.stringify(this.rows,null,2));}}\n`, { mode: 0o600 })
    const expected = Object.fromEntries(captured.map(file => [path.join(root, file), receipt.inputsBefore[file]]))
    await fs.writeFile(config, `import base from ${JSON.stringify(path.join(root, 'vitest.config.ts'))};
import{defineConfig}from'vitest/config';import{createHash}from'node:crypto';import{readFileSync,writeFileSync}from'node:fs';
const expected=${JSON.stringify(expected)},target=${JSON.stringify(path.join(root, phase.target))},before=${JSON.stringify(phase.before)},after=${JSON.stringify(phase.after)},loaded:Record<string,unknown>={};
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
export default defineConfig({...base,root:${JSON.stringify(root)},plugins:[...(base.plugins??[]),{name:'readonly-project-groups',enforce:'pre',transform(code:string,id:string){
const file=id.split('?')[0];if(!(file in expected))return;
if(hash(readFileSync(file))!==expected[file]||hash(code)!==expected[file])throw Error('Frozen actual Source must equal the Vite input');
let consumed=code;if(file===target){if(code.split(before).length-1!==1)throw Error('Owning product block count changed');consumed=code.replace(before,after);}
loaded[file]={sourceSHA256:expected[file],viteInputSHA256:hash(code),consumedCodeSHA256:hash(consumed),bytes:Buffer.byteLength(consumed),changed:consumed!==code};
writeFileSync(${JSON.stringify(capture)},JSON.stringify(loaded,null,2));return{code:consumed,map:null};
}}],test:{...base.test,include:${JSON.stringify(tests)},passWithNoTests:false,fileParallelism:false,maxWorkers:1}});\n`, { mode: 0o600 })
    await fs.writeFile(path.join(own, 'original-block.txt'), phase.before, { mode: 0o600 })
    await fs.writeFile(path.join(own, 'consumed-block.txt'), phase.after, { mode: 0o600 })
    const args = ['node_modules/vitest/vitest.mjs', 'run', ...tests, '--config', config, '--maxWorkers=1', '--reporter=json', '--reporter=' + taskReporter, '--outputFile=' + report]
    if (phase.testcase) args.push('--testNamePattern', phase.testcase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$')
    const exitCode = await execute(args, path.join(own, 'vitest.log')), result = await json(report)
    const loaded = await json(capture), taskResults = await json(taskReport)
    assert.deepEqual(result.testResults.map(suite => path.relative(root, suite.name)).sort(), [...tests].sort())
    const cases = result.testResults.flatMap(suite => suite.assertionResults.map(item => ({ name: item.fullName, status: item.status,
      failureMessages: item.failureMessages ?? [] }))).sort((a, b) => a.name.localeCompare(b.name))
    assert.ok(cases.length > 0); assert.equal(cases.length, result.numTotalTests); assert.equal(result.numTodoTests, 0)
    names ??= cases.map(item => item.name); assert.deepEqual(cases.map(item => item.name), names)
    const active = cases.filter(item => item.status === 'passed' || item.status === 'failed')
    const expectedActive = phase.testcase ? cases.filter(item => item.name.endsWith(phase.testcase)) : cases
    assert.ok(active.length > 0); assert.deepEqual(active.map(item => item.name), expectedActive.map(item => item.name))
    if (phase.testcase) assert.equal(active.length, 1, 'The exact named original assertion must execute once')
    const filteredCaseCount = cases.length - active.length
    assert.equal(result.numPendingTests, filteredCaseCount)
    assert.ok(cases.every(item => active.includes(item) || phase.testcase && (item.status === 'pending' || item.status === 'skipped')))
    for (const file of captured) {
      const item = loaded[path.join(root, file)]; assert.ok(item?.bytes > 0, `Actual Source must be consumed: ${file}`)
      assert.equal(item.sourceSHA256, receipt.inputsBefore[file]); assert.equal(item.viteInputSHA256, receipt.inputsBefore[file])
      assert.equal(item.consumedCodeSHA256, sha(file === phase.target ? consumed : await read(file)))
      assert.equal(item.changed, file === phase.target && phase.before !== phase.after)
    }
    const failed = cases.filter(item => item.status === 'failed')
    const check = { id: phase.id, target: phase.target, expectedFailingCase: phase.testcase, command: [process.execPath, ...args], exitCode,
      total: cases.length, activeCaseCount: active.length, filteredCaseCount, activeCaseNames: active.map(item => item.name),
      passed: result.numPassedTests, failed: result.numFailedTests, cases, loaded, report, reportSHA256: sha(await read(report)),
      taskResults, taskReport, taskReportSHA256: sha(await read(taskReport)), taskReporterSHA256: sha(await read(taskReporter)),
      originalBlockSHA256: sha(phase.before), consumedBlockSHA256: sha(phase.after), qualifiedAssertionRed: false, qualifiedOriginalGreen: false }
    receipt.checks.push(check); await write(path.join(run, 'receipt.json'), receipt)
    if (phase.testcase) {
      assert.equal(exitCode, 1); assert.equal(result.success, false); assert.ok(failed.length > 0)
      assert.ok(failed.some(item => item.name.endsWith(phase.testcase)), 'The named original product assertion must fail')
      for (const item of failed) {
        const actual = taskResults.find(task => item.name.endsWith(task.name))
        assert.equal(actual?.state, 'failed')
        assert.ok(actual.errors.some(error => {
          if (error.name !== 'AssertionError' || !tests.some(file => error.stack?.includes(path.join(root, file) + ':'))) return false
          if (!error.message?.startsWith('promise resolved ')) return item.failureMessages.some(message => message.startsWith('AssertionError:'))
          return phase.id === 'allow-omitted-group-removal' && error.stack.includes('__VITEST_REJECTS__') &&
            typeof error.expected === 'string' && error.expected.includes('rejected promise') &&
            typeof error.actual === 'string' && /["']?schemaVersion["']?:\s*1/u.test(error.actual) &&
            /["']?projectGroups["']?:\s*(?:Array\s*)?\[\]/u.test(error.actual) && error.actual.includes('original-tab')
        }), 'Only a real owning AssertionError qualifies; async rejection also requires its actual/expected and framework frame')
      }
      check.qualifiedAssertionRed = true
    } else {
      assert.equal(exitCode, 0); assert.equal(result.success, true); assert.equal(result.numFailedTests, 0)
      assert.equal(result.numPassedTests, cases.length); assert.ok(cases.every(item => item.status === 'passed'))
      check.qualifiedOriginalGreen = true
    }
    assert.deepEqual(await hashes(inputs), receipt.inputsBefore, 'Readonly qualification changed original inputs')
    process.stdout.write(`${phase.id}: ${check.passed}/${check.total} passed, ${check.failed} actual assertion failures\n`)
  }
  receipt.productionCallers = await consumers()
  receipt.inputsAfter = await hashes(inputs); assert.deepEqual(receipt.inputsAfter, receipt.inputsBefore)
  receipt.dependencyInputsAfter = await hashes(dependencies); assert.deepEqual(receipt.dependencyInputsAfter, receipt.dependencyInputsBefore)
  receipt.passed = true
} catch (error) { receipt.errors.push({ name: error.name, message: error.message, stack: error.stack }) }
finally {
  await write(path.join(run, 'receipt.json'), receipt)
  if (receipt.passed) await write(path.join(evidence, 'source-receipt.json'), receipt)
}
console.log(JSON.stringify({ passed: receipt.passed, receipt: path.join(run, 'receipt.json'), sha256: sha(await read(path.join(run, 'receipt.json'))),
  checks: receipt.checks.map(({ id, total, passed, failed }) => ({ id, total, passed, failed })), errors: receipt.errors }))
if (!receipt.passed) process.exitCode = 1
