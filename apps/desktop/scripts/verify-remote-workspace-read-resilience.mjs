import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../../..'), prefix = 'apps/desktop/src/renderer/src/'
const owner = 'apps/desktop/src/main/workspace-files.ts', factory = 'apps/desktop/src/main/host-factory.ts'
const launcher = prefix + 'components/LauncherFileReferences.tsx', hook = prefix + 'components/file-tree/useWorkspaceFileTree.ts'
const explorer = prefix + 'components/FileExplorer.tsx'
const tests = ['apps/desktop/test/remote-workspace-read-resilience.test.ts', 'apps/desktop/test/remote-workspace-read-resilience.test.tsx']
const helper = 'apps/desktop/test/helpers/remote-directory-fixture.ts', fixture = 'apps/desktop/test/fixtures/delayed-workspace-ssh.mjs'
const captured = [owner, factory, launcher, hook, explorer, ...tests, helper]
const callers = ['apps/desktop/src/main/ipc.ts', 'apps/desktop/src/main/runtime-controller.ts', 'apps/desktop/src/preload/index.ts',
  prefix + 'components/NewTabSurface.tsx', prefix + 'components/MoteDetailsPanel.tsx']
const inputs = [...captured, fixture, ...callers, 'apps/desktop/src/main/workspace-git-ignore.ts', prefix + 'lib/api.ts',
  prefix + 'components/file-tree/file-explorer-dir-load-tracker.ts', prefix + 'components/file-tree/file-explorer-stale-dir-cache.ts',
  'apps/desktop/test/helpers/composer-dom-fixture.tsx', 'apps/desktop/test/helpers/client-ui-render.tsx',
  'packages/core/src/execution-host.ts', 'packages/core/src/process-runner.ts', prefix + 'styles/index.css',
  'apps/desktop/scripts/verify-remote-workspace-read-resilience.mjs', 'vitest.config.ts', 'vitest.setup.ts', 'vitest.dist-freshness.ts',
  'tsconfig.base.json', 'apps/desktop/tsconfig.json', prefix + 'global.d.ts', 'pnpm-lock.yaml']
const dependencies = ['packages/core/package.json', 'packages/core/dist/index.js', 'packages/core/dist/index.d.ts',
  'packages/core/dist/execution-host.js', 'packages/core/dist/process-runner.js', 'packages/core/dist/errors.js',
  'packages/client-ui/package.json', 'packages/client-ui/dist/index.js', 'packages/demand/dist/src/index.js']
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const read = file => fs.readFile(path.isAbsolute(file) ? file : path.join(root, file))
const json = async file => JSON.parse(await read(file))
const hashes = async files => Object.fromEntries(await Promise.all(files.map(async file => [file, sha(await read(file))])))
const folder = path.join(root, '.tmp/remote-workspace-read-resilience')
const canonical = path.join(folder, 'source-receipt.json')
const write = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })

async function execute(args, log) {
  const handle = await fs.open(log, 'w', 0o600)
  try { return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env }, stdio: ['ignore', handle.fd, handle.fd] })
    child.once('error', reject); child.once('exit', (code, signal) => signal ? reject(Error('Qualification terminated by ' + signal)) : resolve(code))
  }) } finally { await handle.close() }
}

async function productionCallers() {
  const ts = createRequire(import.meta.url)('typescript')
  const requirements = [
    { definition: owner, file: callers[0], call: 'files.readDirectory' },
    { definition: factory, file: callers[1], call: 'createExecutionHost' },
    { definition: callers[0], file: callers[2], call: 'ipcRenderer.invoke', firstArgument: 'files:readDirectory' },
    { definition: launcher, file: callers[3], jsx: 'LauncherFileReferences' },
    { definition: hook, file: explorer, call: 'useWorkspaceFileTree' },
    { definition: hook, file: callers[4], call: 'useWorkspaceFileTree' }
  ]
  const results = []
  for (const entry of requirements) {
    assert.notEqual(entry.file, entry.definition)
    const source = (await read(entry.file)).toString(), ast = ts.createSourceFile(entry.file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const hits = []
    const visit = node => {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === entry.call && (!entry.firstArgument ||
        ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === entry.firstArgument)) hits.push(node.getText(ast))
      if (entry.jsx && (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(ast) === entry.jsx) hits.push(node.getText(ast))
      ts.forEachChild(node, visit)
    }
    visit(ast); assert.ok(hits.length > 0, 'Non-import production caller required: ' + entry.file)
    results.push({ ...entry, sourceSHA256: sha(source), hits })
  }
  return results
}

async function produce() {
  await fs.mkdir(folder, { recursive: true, mode: 0o700 })
  const run = path.join(folder, 'source-run-' + globalThis.crypto.randomUUID()); await fs.mkdir(run, { mode: 0o700 })
  const receipt = { schema: 'agentmux.remote-workspace-read-resilience.source.v1', passed: false, sourceRoot: root, runRoot: run,
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    sharedSourceModified: false, sharedDistModified: false, originalAppOrRunTouched: false, checks: [], errors: [],
    boundary: 'Real private filesystem and real child-process SSH/stdin/shell with a task-local delayed SSH executable substitute. No actual network diagnosis, native Agent lifecycle or visual approval.' }
  try {
    receipt.inputsBefore = await hashes(inputs); receipt.dependenciesBefore = await hashes(dependencies)
    const types = path.join(run, 'owning-types.json')
    await write(types, { extends: path.join(root, 'apps/desktop/tsconfig.json'), compilerOptions: {
      types: ['node', path.join(root, 'apps/desktop/node_modules/vite/client')] },
      include: [...tests, prefix + 'global.d.ts'].map(file => path.join(root, file)) })
    receipt.typechecks = []
    for (const [id, config] of [['owning', types], ['desktop', path.join(root, 'apps/desktop/tsconfig.json')]]) {
      const log = path.join(run, id + '.log'), exit = await execute(['node_modules/typescript/bin/tsc', '--project', config, '--noEmit'], log)
      receipt.typechecks.push({ id, exit, log, logSHA256: sha(await read(log)) }); assert.equal(exit, 0)
    }
    const mutations = [
      { id: 'omit-final-directory', target: owner, before: 'REMOTE_DIRECTORY_ENTRY_SCRIPT, ...ancestors]', after: 'REMOTE_DIRECTORY_ENTRY_SCRIPT, ancestors[0]!]',
        testcase: 'reads every ancestor and exact entries in one SSH delivery with no shell interpolation' },
      { id: 'disable-inflight-sharing', target: owner, before: 'if (pending) return await pending', after: 'if (pending) reads.delete(key)',
        testcase: 'shares in-flight reads only for the same original execution Host, root and directory' },
      { id: 'forget-original-root', target: owner, before: 'JSON.stringify([resource.id, resource.path, requestedPath])', after: 'JSON.stringify([resource.id, requestedPath])',
        testcase: 'shares in-flight reads only for the same original execution Host, root and directory' },
      { id: 'allow-ancestor-cycle', target: owner, before: 'if [ "$canonical" = "$ancestor" ]; then', after: 'if false; then',
        testcase: 'keeps explicit linked reads, rejects ancestor cycles and lexical escapes without writes' },
      { id: 'restore-short-read-deadline', target: owner, before: 'REMOTE_DIRECTORY_READ_TIMEOUT_MS = 30_000', after: 'REMOTE_DIRECTORY_READ_TIMEOUT_MS = 15_000',
        testcase: 'allows delayed connection and command delivery within their distinct bounded budgets' },
      { id: 'restore-short-connect-budget', target: factory, before: 'connectTimeoutSeconds: 20,', after: 'connectTimeoutSeconds: 10,',
        testcase: 'allows delayed connection and command delivery within their distinct bounded budgets' },
      { id: 'erase-known-launcher-files', target: launcher,
        before: 'entries: previous?.resourceKey === resourceKey ? previous.entries : null, issue: null, loading: true',
        after: 'entries: null, issue: null, loading: true',
        testcase: 'Launcher retains same-resource files throughout a pending refresh, timeout and successful Retry' },
      { id: 'accept-retired-launcher-read', target: launcher, before: 'return () => { current = false }', after: 'return () => { current = true }',
        testcase: 'Launcher excludes old files and late results when the same Workspace changes original Host or root' },
      { id: 'forget-explorer-execution-scope', target: hook,
        before: '[workspaceId, rootPath, resource?.hostId, resource?.path]', after: '[workspaceId, rootPath]',
        testcase: 'Explorer rejects an older observation after the same Workspace changes execution resources' }
    ]
    const phases = [{ id: 'baseline', target: owner, before: mutations[0].before, after: mutations[0].before }]
    for (const mutation of mutations) phases.push(mutation, { ...mutation, id: 'restored-' + mutation.id, after: mutation.before, testcase: undefined })
    let names
    for (const phase of phases) {
      assert.deepEqual(await hashes(inputs), receipt.inputsBefore); assert.deepEqual(await hashes(dependencies), receipt.dependenciesBefore)
      const original = (await read(phase.target)).toString(); assert.equal(original.split(phase.before).length - 1, 1)
      const consumed = original.replace(phase.before, phase.after), own = path.join(run, phase.id); await fs.mkdir(own)
      const report = path.join(own, 'tests.json'), capture = path.join(own, 'loaded.json'), taskReport = path.join(own, 'tasks.json')
      const reporter = path.join(own, 'reporter.mjs'), config = path.join(own, 'readonly.config.mts')
      await fs.writeFile(reporter, `import{writeFileSync}from'node:fs';export default class{rows=[];onTestCaseResult(t){let r=t.result();this.rows.push({name:t.name,state:r.state,errors:r.errors??[]});writeFileSync(${JSON.stringify(taskReport)},JSON.stringify(this.rows));}}`, { mode: 0o600 })
      const expected = Object.fromEntries(captured.map(file => [path.join(root, file), receipt.inputsBefore[file]]))
      await fs.writeFile(config, `import base from ${JSON.stringify(path.join(root, 'vitest.config.ts'))};import{defineConfig}from'vitest/config';import{readFileSync,writeFileSync}from'node:fs';import{createHash}from'node:crypto';
const expected=${JSON.stringify(expected)},target=${JSON.stringify(path.join(root, phase.target))},before=${JSON.stringify(phase.before)},after=${JSON.stringify(phase.after)},loaded:Record<string,unknown>={};const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
export default defineConfig({...base,root:${JSON.stringify(root)},plugins:[...(base.plugins??[]),{name:'readonly-directory-recovery',enforce:'pre',transform(code:string,id:string){let file=id.split('?')[0];if(!(file in expected))return;if(hash(readFileSync(file))!==expected[file]||hash(code)!==expected[file])throw Error('Actual Source is not frozen');let used=code;if(file===target){if(code.split(before).length-1!==1)throw Error('Product block changed');used=code.replace(before,after);}loaded[file]={sourceSHA256:expected[file],viteInputSHA256:hash(code),consumedCodeSHA256:hash(used),bytes:Buffer.byteLength(used),changed:used!==code};writeFileSync(${JSON.stringify(capture)},JSON.stringify(loaded));return{code:used,map:null};}}],test:{...base.test,include:${JSON.stringify(tests)},passWithNoTests:false,maxWorkers:1,fileParallelism:false}});`, { mode: 0o600 })
      const args = ['node_modules/vitest/vitest.mjs', 'run', ...tests, '--config', config, '--maxWorkers=1', '--reporter=json', '--reporter=' + reporter, '--outputFile=' + report]
      if (phase.testcase) args.push('--testNamePattern', phase.testcase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$')
      const exit = await execute(args, path.join(own, 'tests.log')), results = await json(report), tasks = await json(taskReport), loaded = await json(capture)
      assert.deepEqual(results.testResults.map(suite => path.relative(root, suite.name)).sort(), [...tests].sort())
      const cases = results.testResults.flatMap(suite => suite.assertionResults.map(test => ({ name: test.fullName, status: test.status, failureMessages: test.failureMessages }))).sort((a, b) => a.name.localeCompare(b.name))
      assert.equal(cases.length, 11); assert.equal(cases.length, results.numTotalTests); assert.equal(results.numTodoTests, 0)
      names ??= cases.map(test => test.name); assert.deepEqual(cases.map(test => test.name), names)
      const active = cases.filter(test => test.status === 'passed' || test.status === 'failed')
      assert.deepEqual(active.map(test => test.name), (phase.testcase ? cases.filter(test => test.name.endsWith(phase.testcase)) : cases).map(test => test.name))
      assert.equal(active.length, phase.testcase ? 1 : 11); const filtered = cases.length - active.length
      assert.equal(results.numPendingTests, filtered)
      assert.ok(cases.every(test => active.includes(test) || phase.testcase && ['pending', 'skipped'].includes(test.status)))
      for (const file of captured) {
        const item = loaded[path.join(root, file)]; assert.ok(item?.bytes > 0, 'Actual product/test must be consumed: ' + file)
        assert.equal(item.sourceSHA256, receipt.inputsBefore[file]); assert.equal(item.viteInputSHA256, receipt.inputsBefore[file])
        assert.equal(item.consumedCodeSHA256, sha(file === phase.target ? consumed : await read(file)))
        assert.equal(item.changed, file === phase.target && phase.before !== phase.after)
      }
      const check = { id: phase.id, target: phase.target, expectedFailingCase: phase.testcase, command: [process.execPath, ...args], exit,
        total: cases.length, active: active.length, filtered, passed: results.numPassedTests, failed: results.numFailedTests, cases, loaded,
        report, reportSHA256: sha(await read(report)), taskReport, taskReportSHA256: sha(await read(taskReport)),
        originalBlockSHA256: sha(phase.before), consumedBlockSHA256: sha(phase.after), qualifiedAssertionRed: false, qualifiedOriginalGreen: false }
      receipt.checks.push(check); await write(path.join(run, 'receipt.json'), receipt)
      if (phase.testcase) {
        assert.equal(exit, 1); assert.equal(results.success, false); assert.equal(results.numFailedTests, 1)
        const failed = active[0]; assert.equal(failed.status, 'failed')
        const task = tasks.find(value => failed.name.endsWith(value.name)); assert.equal(task?.state, 'failed')
        assert.ok(task.errors.length > 0 && task.errors.every(error => error.name === 'AssertionError' &&
          String(error.stack).includes('remote-workspace-read-resilience.test.')), 'A named original assertion, not setup/TypeError/no-tests, must fail')
        check.qualifiedAssertionRed = true
      } else {
        assert.equal(exit, 0); assert.equal(results.success, true); assert.equal(results.numPassedTests, 11); assert.equal(results.numFailedTests, 0)
        check.qualifiedOriginalGreen = true
      }
      console.log(phase.id + ': ' + check.passed + '/11 passed, ' + check.failed + ' actual named assertion failure(s)')
    }
    receipt.productionCallers = await productionCallers()
    receipt.inputsAfter = await hashes(inputs); receipt.dependenciesAfter = await hashes(dependencies)
    assert.deepEqual(receipt.inputsAfter, receipt.inputsBefore); assert.deepEqual(receipt.dependenciesAfter, receipt.dependenciesBefore)
    receipt.passed = true; await write(canonical, receipt)
  } catch (error) { receipt.errors.push({ name: error.name, message: error.message, stack: error.stack }); process.exitCode = 1 }
  await write(path.join(run, 'receipt.json'), receipt)
  console.log(JSON.stringify({ passed: receipt.passed, receipt: path.join(run, 'receipt.json'), sha256: sha(await read(path.join(run, 'receipt.json'))), errors: receipt.errors }))
}

async function consume() {
  const source = await json(canonical)
  assert.equal(source.schema, 'agentmux.remote-workspace-read-resilience.source.v1'); assert.equal(source.passed, true); assert.deepEqual(source.errors, [])
  assert.deepEqual(await hashes(inputs), source.inputsBefore); assert.deepEqual(source.inputsAfter, source.inputsBefore)
  assert.deepEqual(await hashes(dependencies), source.dependenciesBefore); assert.deepEqual(source.dependenciesAfter, source.dependenciesBefore)
  assert.equal(source.checks.length, 19); assert.equal(source.checks.filter(check => check.qualifiedAssertionRed).length, 9)
  assert.equal(source.checks.filter(check => check.qualifiedOriginalGreen).length, 10)
  for (const check of source.checks) {
    assert.equal(sha(await read(check.report)), check.reportSHA256); assert.equal(sha(await read(check.taskReport)), check.taskReportSHA256)
    assert.equal(check.total, 11); assert.equal(check.active, check.qualifiedAssertionRed ? 1 : 11)
    assert.equal(check.filtered, check.qualifiedAssertionRed ? 10 : 0)
    const report = await json(check.report), tasks = await json(check.taskReport)
    const cases = report.testResults.flatMap(suite => suite.assertionResults.map(test => ({ name: test.fullName, status: test.status,
      failureMessages: test.failureMessages }))).sort((a, b) => a.name.localeCompare(b.name))
    assert.deepEqual(cases, check.cases); assert.equal(report.numTotalTests, 11)
    assert.equal(report.numPassedTests, check.qualifiedAssertionRed ? 0 : 11)
    assert.equal(report.numFailedTests, check.qualifiedAssertionRed ? 1 : 0)
    assert.equal(report.numPendingTests, check.filtered); assert.equal(report.numTodoTests, 0)
    const loaded = await json(path.join(path.dirname(check.report), 'loaded.json')); assert.deepEqual(loaded, check.loaded)
    for (const file of captured) {
      const item = loaded[path.join(root, file)]
      assert.ok(item.bytes > 0); assert.equal(item.sourceSHA256, source.inputsBefore[file]); assert.equal(item.viteInputSHA256, source.inputsBefore[file])
      assert.equal(item.changed, check.qualifiedAssertionRed && file === check.target)
      if (!item.changed) assert.equal(item.consumedCodeSHA256, source.inputsBefore[file])
    }
    if (check.qualifiedAssertionRed) {
      const failed = cases.filter(test => test.status === 'failed'); assert.equal(failed.length, 1)
      assert.ok(failed[0].name.endsWith(check.expectedFailingCase)); assert.equal(check.exit, 1)
      const task = tasks.find(value => failed[0].name.endsWith(value.name)); assert.equal(task.state, 'failed')
      assert.ok(task.errors.length > 0 && task.errors.every(error => error.name === 'AssertionError' &&
        String(error.stack).includes('remote-workspace-read-resilience.test.')))
    } else assert.equal(check.exit, 0)
  }
  for (const check of source.typechecks) { assert.equal(check.exit, 0); assert.equal(sha(await read(check.log)), check.logSHA256) }
  assert.deepEqual(await productionCallers(), source.productionCallers); assert.ok(source.productionCallers.length > 0)
  const visualPath = path.join(folder, 'visual-receipt.json'), reviewPath = path.join(folder, 'independent-visual-review.json')
  const visual = await json(visualPath), review = await json(reviewPath)
  assert.equal(visual.passed, true); assert.equal(visual.originalAppOrRunTouched, false)
  assert.deepEqual(visual.cleanup.errors, []); assert.deepEqual(visual.cleanup.remaining, []); assert.equal(visual.cleanup.privateRootRemoved, true)
  assert.ok(visual.frames.length >= 2 && visual.frames.length <= 3)
  assert.ok(visual.productInputs && Object.keys(visual.productInputs).length > 0)
  for (const file of [launcher, hook, explorer]) assert.equal(visual.productInputs[file], sha(await read(file)))
  for (const [file, digest] of Object.entries(visual.productInputs)) assert.equal(sha(await read(file)), digest)
  assert.equal(review.status, 'accepted'); assert.ok(typeof review.reviewerAgent === 'string' && review.reviewerAgent.length > 0)
  assert.notEqual(review.reviewerAgent, '/root/core_finalreview')
  assert.equal(review.receiptSHA256, sha(await read(visualPath)))
  assert.equal(review.frames.length, visual.frames.length)
  for (const frame of visual.frames) {
    assert.ok(frame.bytes > 0 && frame.width > 0 && frame.height > 0)
    assert.equal(sha(await read(frame.absolutePath)), frame.sha256)
    assert.ok(review.frames.some(item => item.sha256 === frame.sha256 && item.opened === true))
  }
  const receipt = { schema: 'agentmux.remote-workspace-read-resilience.gate.v1', passed: true, source: { path: canonical, sha256: sha(await read(canonical)) },
    visual: { path: visualPath, sha256: sha(await read(visualPath)) }, independentReview: { path: reviewPath, sha256: sha(await read(reviewPath)) },
    boundary: 'Exact existing producer proof and bounded current product/input/actual-image checks. No new Runtime, lifecycle or installation proof.' }
  await write(path.join(folder, 'gate-receipt.json'), receipt); console.log(JSON.stringify(receipt))
}

assert.ok(process.argv.length === 2 || process.argv.length === 3 && process.argv[2] === '--source')
if (process.argv[2] === '--source') await produce()
else await consume()
