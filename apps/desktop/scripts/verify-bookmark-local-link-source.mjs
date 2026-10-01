import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import ts from 'typescript'
import { sourceAliases } from './fixtures/bookmark-local-link/vitest.owning.config.mts'

// Qualification performs real mounted production mutations. The approved task gate uses --receipt
// to consume those exact reports and current inputs without modifying the shared product again.
const root = resolve(import.meta.dirname, '../../..')
let consume = false, output = 'docs/reviews/evidence/bookmark-local-link-2026-10-05/source'
for (let index = 2; index < process.argv.length; index++) {
  const [flag, inline] = process.argv[index].split('=')
  if (flag === '--receipt') { assert.equal(inline, undefined); consume = true; continue }
  assert.equal(flag, '--output', `Unknown verifier argument: ${flag}`)
  output = inline ?? process.argv[++index]
  assert(output && !output.startsWith('--'), 'Missing evidence output path')
}
const evidence = resolve(root, output), receiptPath = resolve(evidence, 'source-receipt.json')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const bind = path => ({ path, sha256: sha(readFileSync(resolve(root, path))) })
const relative = path => path.replace(`${root}/`, '')
const base = 'apps/desktop/src/'
const shared = base + 'shared/bookmark-file.ts', files = base + 'main/workspace-files.ts', persistence = base + 'renderer/src/lib/workbench-persistence.ts', store = base + 'renderer/src/store.ts'
const sourcePaths = [shared, files, persistence, store, base+'main/bookmark-file.ts', base+'main/ipc.ts', base+'preload/index.ts', base+'renderer/src/components/BrowserPane.tsx', base+'renderer/src/components/FileExplorer.tsx', base+'renderer/src/components/WorkspaceWorkbench.tsx']
const testPaths = ['bookmark-file.test.ts', 'bookmark-read-bytes.test.ts', 'bookmark-read-composite.test.ts', 'bookmark-open-store.test.ts', 'bookmark-save-store.test.ts', 'bookmark-owner-ipc.test.ts', 'workbench-persistence.test.ts', 'browser-toolbar.test.tsx'].map(name => 'apps/desktop/test/' + name)
const compilerConfig = 'apps/desktop/.tmp/bookmark-maintenance/tsconfig.owning.json'
const owningTypecheckConfig = () => ({ extends: '../../tsconfig.json', compilerOptions: { baseUrl: '../../../..',
  paths: Object.fromEntries(sourceAliases.map(item => [item.find, [relative(item.replacement)]])) } })
const helpers = ['apps/desktop/scripts/fixtures/bookmark-local-link/vitest.owning.config.mts', 'vitest.setup.ts',
  'apps/desktop/tsconfig.json', 'tsconfig.base.json', 'packages/core/package.json', 'packages/demand/package.json', 'packages/layout/package.json', compilerConfig]
const producer = 'apps/desktop/scripts/verify-bookmark-local-link-source.mjs'
const schema = 'agentmux.bookmark-local-link-source.v1'

function checkInputs(receipt) {
  assert.equal(receipt.schema, schema)
  assert.equal(receipt.status, 'passed')
  assert.deepEqual(receipt.sourceBindings.map(item => item.path), sourcePaths)
  assert.deepEqual(receipt.testBindings.map(item => item.path), [...testPaths, ...helpers])
  for (const input of [...receipt.sourceBindings, ...receipt.testBindings, receipt.verificationBinding]) {
    assert.equal(bind(input.path).sha256, input.sha256, `Qualified input changed: ${input.path}`)
  }
  assert.equal(receipt.verificationBinding.path, producer)
  assert.equal(receipt.sourceDigest, sha(JSON.stringify(receipt.sourceBindings)))
  assert.deepEqual(JSON.parse(readFileSync(resolve(root, compilerConfig), 'utf8')), owningTypecheckConfig())
}
function checkReport(run, expectedGreen) {
  const bytes = readFileSync(resolve(root, run.report))
  assert.equal(sha(bytes), run.reportSha256, `Actual test report changed: ${run.report}`)
  assert.equal(bind(run.log).sha256, run.logSha256, `Actual test log changed: ${run.log}`)
  const actual = JSON.parse(bytes)
  assert(actual.numTotalTests > 0 && actual.testResults.length > 0, 'The original test collection must be nonempty')
  const failed = actual.testResults.flatMap(file => file.assertionResults.filter(test => test.status === 'failed'))
  assert.equal(run.tests, actual.numTotalTests)
  assert.equal(run.passed, actual.numPassedTests)
  if (expectedGreen) {
    assert.equal(run.exitCode, 0)
    assert.equal(actual.numFailedTests, 0)
    assert.equal(failed.length, 0)
    assert(actual.numPassedTests > 0)
  } else {
    assert.notEqual(run.exitCode, 0)
    assert(failed.length > 0, 'A collection/tool failure cannot replace Assertion RED')
    assert(failed.some(test => test.failureMessages.some(message => /AssertionError|expected .*to /s.test(message))), 'Actual assertions must fail')
  }
}
function productCallers() {
  const owners = [['bookmarkFileNameFromTitle', shared], ['parseWeblocUrl', shared], ['readBookmarkBytes', files], ['readBookmark', base+'main/bookmark-file.ts'], ['projectPersistedWorkbench', persistence], ['restorePersistedWorkbench', persistence], ['openFile', store], ['saveBrowserBookmark', store]]
  return owners.map(([symbol, definition]) => {
    const uses = []
    for (const path of sourcePaths.filter(path => path !== definition)) {
      const parsed = ts.createSourceFile(path, readFileSync(resolve(root,path),'utf8'), ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
      function visit(node) {
        if (ts.isCallExpression(node) && (ts.isIdentifier(node.expression) ? node.expression.text : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : null) === symbol)
          uses.push({path,line:parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line+1,use:node.getText(parsed).slice(0,220)})
        ts.forEachChild(node,visit)
      }
      visit(parsed)
    }
    assert(uses.length>0, `${symbol}: no actual caller outside definition/import/tests`)
    return {symbol,definition,uses}
  })
}
const mutants = [
  {id:'drop-persisted-bookmark-origin',path:persistence,owner:'reduceBrowserSurfaceForPersistence',from:'    ...(surface.bookmarkOrigin ? { bookmarkOrigin: surface.bookmarkOrigin } : {})',to:'',testFile:'workbench-persistence.test.ts',test:'round-trips bookmark'},
  {id:'drop-restored-bookmark-origin',path:persistence,owner:'hydratePersistedBrowserSurface',from:'    ...(surface.bookmarkOrigin ? { bookmarkOrigin: surface.bookmarkOrigin } : {}),',to:'',testFile:'workbench-persistence.test.ts',test:'round-trips bookmark'},
  {id:'leave-numeric-entities-undecoded',path:shared,owner:'unescapeXml',from:'|#\\d+|#x[\\da-fA-F]+',to:'',testFile:'bookmark-file.test.ts',test:'decimal and hexadecimal'},
  {id:'decode-entities-twice',path:shared,owner:'unescapeXml',from:'  })',to:"  }).replace(/&#38;/g, '&').replace(/&lt;/g, '<')",testFile:'bookmark-file.test.ts',test:'decimal and hexadecimal'},
  {id:'remove-local-byte-budget',path:files,owner:'readBookmarkBytes',from:"        const payload = await runLocalWorker(dirname(resolved.target), resolved.root, {\n          action: 'read-bytes',\n          name: basename(resolved.target),\n          offset: 0,\n          maxBytes: BOOKMARK_FILE_MAX_BYTES,\n          maxFileBytes: BOOKMARK_FILE_MAX_BYTES\n        })\n        return Buffer.from((JSON.parse(payload.toString('utf8')) as { data: string }).data, 'base64')",to:"        return await runLocalWorker(dirname(resolved.target), resolved.root, { action: 'read', name: basename(resolved.target) })",testFile:'bookmark-read-bytes.test.ts',test:'4 MiB boundary'},
  {id:'decode-base64-as-text',path:files,owner:'readBookmarkBytes',from:"}).data, 'base64')",to:"}).data, 'utf8')",testFile:'bookmark-read-bytes.test.ts',test:'binary .webloc'},
  {id:'swallow-budget-rejection',path:files,owner:'readBookmarkBytes',from:"      if ((error as { code?: string } | null)?.code === 'WORKSPACE_FILE_BYTE_LIMIT') {\n        throw Object.assign(new Error('This bookmark exceeds the 4 MiB preview limit.'), { code: 'WORKSPACE_FILE_BYTE_LIMIT' })\n      }",to:'',testFile:'bookmark-owner-ipc.test.ts',test:'registered bookmark IPC'},
  {id:'hide-bookmark-open-failure',path:store,owner:'openFile',from:"      } catch (error) {\n        releaseNavigation()\n        result.data = { kind: 'failed', reason: presentError(error) }\n        get().reportError(error)\n        return false\n      }",to:"      } catch (error) { releaseNavigation(); return false }",testFile:'bookmark-open-store.test.ts',test:'known bookmark budget'},
  {id:'ignore-filename-byte-limit',path:shared,owner:'bookmarkFileNameFromTitle',from:'points >= 120 || bytes + length > 240',to:'points >= 120',testFile:'bookmark-file.test.ts',test:'both budgets'},
  {id:'ignore-filename-codepoint-limit',path:shared,owner:'bookmarkFileNameFromTitle',from:'points >= 120 || bytes + length > 240',to:'bytes + length > 240',testFile:'bookmark-file.test.ts',test:'both budgets'},
  {id:'increase-contract-budget',path:shared,owner:null,from:'export const BOOKMARK_FILE_MAX_BYTES = 4 * 1024 * 1024',to:'export const BOOKMARK_FILE_MAX_BYTES = 8 * 1024 * 1024',testFile:'bookmark-read-bytes.test.ts',test:'4 MiB boundary'},
  {id:'read-directory-through-worker',path:files,owner:'readBookmarkBytes',from:'        if ((await stat(resolved.target)).isDirectory()) return null',to:'',testFile:'bookmark-read-bytes.test.ts',test:'directory resolves'}
]
function productionBlock(mutant, original) {
  if (!mutant.owner) return { text: mutant.from, start: original.indexOf(mutant.from) }
  const parsed=ts.createSourceFile(mutant.path,original,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),found=[]
  function visit(node){if((ts.isFunctionDeclaration(node)||ts.isMethodDeclaration(node))&&node.name?.getText(parsed)===mutant.owner)found.push(node);ts.forEachChild(node,visit)}visit(parsed)
  assert.equal(found.length,1,'Unique actual production owner: '+mutant.owner)
  return {text:found[0].getText(parsed),start:found[0].getStart(parsed)}
}

if (consume) {
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
  checkInputs(receipt)
  checkReport(receipt.baseline, true)
  checkReport(receipt.restored, true)
  assert.deepEqual(receipt.mutations.map(item => item.id), mutants.map(item => item.id))
  for (const mutation of receipt.mutations) {
    assert.equal(mutation.status, 'assertion-red-exact-restore-green')
    assert.equal(mutation.originalSha256, receipt.sourceBindings.find(item => item.path === mutation.path)?.sha256)
    assert.notEqual(mutation.originalSha256, mutation.mutatedSha256)
    checkReport(mutation.red, false)
    checkReport(mutation.restored, true)
  }
  assert.deepEqual(receipt.callers, productCallers())
  assert.equal(receipt.typecheck.exitCode, 0)
  assert.equal(receipt.typecheck.command, `node_modules/.bin/tsc --noEmit -p ${compilerConfig}`)
  assert.equal(bind(receipt.typecheck.log).sha256, receipt.typecheck.logSha256)
  process.stdout.write(`${JSON.stringify({ status: 'passed', receipt: relative(receiptPath), sourceDigest: receipt.sourceDigest,
    tests: receipt.restored.tests, mutations: receipt.mutations.length, callers: receipt.callers.length, mode: 'read-only-current-proof' })}\n`)
  process.exit(0)
}

mkdirSync(evidence, { recursive: true })
mkdirSync(resolve(root, compilerConfig, '..'), { recursive: true })
writeFileSync(resolve(root, compilerConfig), `${JSON.stringify(owningTypecheckConfig(), null, 2)}\n`)
const sourceBindings = sourcePaths.map(bind), testBindings = [...testPaths, ...helpers].map(bind)
const verificationBinding = bind(producer)
function runTests(label, paths = testPaths, name) {
  const report = resolve(evidence, `${label}.vitest.json`), log = resolve(evidence, `${label}.log`)
  const args = ['run', '--config', helpers[0], ...paths, '--maxWorkers=1', '--reporter=json', `--outputFile=${report}`]
  if (name) args.push('-t', name)
  const result = spawnSync(process.execPath, [resolve(root, 'node_modules/vitest/vitest.mjs'), ...args], { cwd: root, encoding: 'utf8', timeout: 120_000 })
  writeFileSync(log, `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? `\n${result.error}` : ''}`)
  assert(!result.error, `${label}: test command did not complete`)
  const bytes = readFileSync(report), actual = JSON.parse(bytes)
  assert(actual.numTotalTests > 0 && actual.testResults.length > 0, `${label}: tests must be collected`)
  const failed = actual.testResults.flatMap(file => file.assertionResults.filter(test => test.status === 'failed')
    .map(test => ({ file: relative(file.name), name: test.fullName, messages: test.failureMessages })))
  return { label, command: `node_modules/.bin/vitest ${args.join(' ')}`, exitCode: result.status,
    tests: actual.numTotalTests, passed: actual.numPassedTests, failed,
    report: relative(report), reportSha256: sha(bytes), log: relative(log), logSha256: bind(relative(log)).sha256 }
}
const baseline = runTests('source-baseline')
checkReport(baseline, true)
const mutations = []
for (const mutant of mutants) {
  const path = resolve(root, mutant.path), original = readFileSync(path)
  assert.equal(sha(original), sourceBindings.find(input => input.path === mutant.path)?.sha256, 'Candidate changed; preserve concurrent work before retrying')
  const block=productionBlock(mutant,original.toString());assert(block.start>=0&&block.text.length>0)
  assert.equal(block.text.split(mutant.from).length,2,'Nonempty unique anchor in actual production block: '+mutant.id)
  const mutated = original.toString().slice(0,block.start)+block.text.replace(mutant.from,mutant.to)+original.toString().slice(block.start+block.text.length)
  writeFileSync(path, mutated)
  let red
  try {
    red = runTests(`mutation-${mutant.id}`, ['apps/desktop/test/'+mutant.testFile], mutant.test)
    checkReport(red, false)
  } finally {
    assert.equal(sha(readFileSync(path)), sha(mutated), `${mutant.id}: concurrent edit detected; do not overwrite it`)
    writeFileSync(path, original)
    assert.equal(sha(readFileSync(path)), sha(original), `${mutant.id}: restore original bytes exactly`)
  }
  const restored = runTests(`restore-${mutant.id}`, ['apps/desktop/test/'+mutant.testFile], mutant.test)
  checkReport(restored, true)
  mutations.push({ id: mutant.id, path: mutant.path, originalSha256: sha(original), mutatedSha256: sha(mutated),
    status: 'assertion-red-exact-restore-green', productionBlock:{text:block.text,sha256:sha(block.text)}, red, restored })
  process.stdout.write(`${mutant.id}: Assertion RED / exact restore GREEN\n`)
}
const restored = runTests('source-final-restored')
checkReport(restored, true)
const callers = productCallers()
const typecheck = spawnSync(resolve(root, 'node_modules/.bin/tsc'), ['--noEmit', '-p', compilerConfig], { cwd: root, encoding: 'utf8', timeout: 120_000 })
const typecheckLog = relative(resolve(evidence, 'source-typecheck.log'))
writeFileSync(resolve(root, typecheckLog), `${typecheck.stdout ?? ''}${typecheck.stderr ?? ''}${typecheck.error ? `\n${typecheck.error}` : ''}`)
assert(!typecheck.error && typecheck.status === 0, 'The actual current product typecheck must pass')
const receipt = { schema, status: 'passed', feature: 'f-26e8f6h4z', task: 'T-005', recordedAt: new Date().toISOString(),
  sourceBindings, testBindings, verificationBinding, sourceDigest: sha(JSON.stringify(sourceBindings)), baseline, mutations, restored, callers,
  typecheck: { command: `node_modules/.bin/tsc --noEmit -p ${compilerConfig}`, exitCode: typecheck.status,
    log: typecheckLog, logSha256: bind(typecheckLog).sha256 },
  packaging: 'not-requested-not-run', installation: 'not-requested-not-run',
  boundary: 'Real production parsers, WorkspaceFiles worker, registered Main IPC, preload, Store and persistence are loaded. Actual plutil and local filesystem bytes are exercised; Electron invoke transport is controlled in the IPC test. Native Browser pixels and two-process recovery are independently qualified by verify-bookmark-local-link-native.mjs. No installed App or healthy native Run claim.' }
checkInputs(receipt)
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
process.stdout.write(`${JSON.stringify({ status: 'passed', receipt: relative(receiptPath), tests: restored.tests, mutations: mutations.length, callers: callers.length })}\n`)
