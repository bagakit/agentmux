import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const root = resolve(import.meta.dirname, '../../..'), execute = promisify(execFile)
const test = 'apps/desktop/test/service-notice-row.test.tsx'
const config = 'apps/desktop/scripts/fixtures/experience-verification/vitest.config.mts'
const component = 'apps/desktop/src/renderer/src/components/'
const required = [component + 'SessionMailbox.tsx', component + 'ServiceNoticeRow.tsx', 'packages/client-ui/src/components/MailboxRecordRow.tsx']
const productPaths = ['apps/desktop/src/renderer/src/App.tsx', component + 'MountedSpaceAgent.tsx', component + 'AgentSessionComposer.tsx', component + 'GlobalSystemNotices.tsx', ...required]
const cases = [
  { mutation: 'unconfirmed-copy', title: 'separates unread and unconfirmed state', file: component + 'ServiceNoticeRow.tsx' },
  { mutation: 'action-disconnected', title: 'separates unread and unconfirmed state', file: component + 'ServiceNoticeRow.tsx' }
]
const base = join(process.env.AGENTMUX_EXPERIENCE_EVIDENCE_HOME ?? join(root, '.bagakit/verification'), 'message-notice-experience')
await mkdir(base, { recursive: true })
const evidence = await mkdtemp(join(base, 'run-'))
const hash = value => createHash('sha256').update(value).digest('hex')
const sourceHashes = async () => Object.fromEntries(await Promise.all(productPaths.map(async path => [path, hash(await readFile(join(root, path)))])))
const original = await sourceHashes()
const receipt = { schema: 'agentmux.message-notice-experience-verification.v1', passed: false, test, original, callers: [], results: [] }

async function traceCallers() {
  const ts = createRequire(join(root, 'apps/desktop/package.json'))('typescript'), calls = []
  const collect = async (path, predicate) => {
    const ast = ts.createSourceFile(path, await readFile(join(root, path), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const found = []
    const visit = node => { if (predicate(node, ast)) found.push({ path, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1, source: node.getText(ast) }); ts.forEachChild(node, visit) }
    visit(ast); assert.ok(found.length > 0, 'Nonempty production consumer: ' + path); calls.push(...found)
  }
  const jsx = name => (node, ast) => (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(ast) === name
  await collect(productPaths[0], jsx('GlobalSystemNotices'))
  await collect(productPaths[1], jsx('AgentSessionComposer'))
  await collect(productPaths[2], jsx('SessionMailbox'))
  await collect(productPaths[2], (node, ast) => ts.isCallExpression(node) && node.expression.getText(ast) === 'useServiceNotices')
  await collect(productPaths[3], (node, ast) => ts.isCallExpression(node) && node.expression.getText(ast) === 'useServiceNotices')
  await collect(required[0], jsx('ServiceNoticeRow'))
  await collect(required[0], jsx('ServiceWindowNotice'))
  await collect(required[0], (node, ast) => ts.isPropertyAccessExpression(node) && node.getText(ast) === 'selectedNotice.action.run')
  await collect(required[1], jsx('MailboxRecordRow'))
  assert.ok(calls.length >= 9)
  return calls
}

let baselineConsumption
async function run(name, mutation, expectedTitle) {
  const directory = join(evidence, name); await mkdir(directory, { recursive: true })
  let exitCode = 0, stdout = '', stderr = ''
  try {
    const output = await execute(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--configLoader', 'native', '--config', config, test], { cwd: root, timeout: 120000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, AGENTMUX_EXPERIENCE_TEST: test, AGENTMUX_EXPERIENCE_MUTATION: mutation, AGENTMUX_EXPERIENCE_EVIDENCE: directory } })
    stdout = output.stdout; stderr = output.stderr
  } catch (error) { exitCode = typeof error.code === 'number' ? error.code : -1; stdout = error.stdout ?? ''; stderr = error.stderr ?? '' }
  await writeFile(join(directory, 'run.log'), stdout + stderr)
  const report = JSON.parse(await readFile(join(directory, 'vitest.json'), 'utf8'))
  const files = report.testResults.filter(file => file.name.endsWith(test)); assert.equal(files.length, 1, 'The actual owning suite is nonempty')
  const assertions = files[0].assertionResults; assert.equal(assertions.length, 2, 'All focused Notice cases execute')
  const consumption = JSON.parse(await readFile(join(directory, 'source-consumption.json'), 'utf8'))
  const byPath = Object.fromEntries(consumption.map(item => [item.path, item]))
  for (const path of required) {
    assert.ok(byPath[path], 'Actual production source loaded: ' + path)
    assert.equal(byPath[path].originalSHA256, original[path], 'Original source stays exact: ' + path)
  }
  if (!expectedTitle) {
    assert.equal(exitCode, 0, name + ': actual mounted candidate passes; see run.log')
    assert.equal(report.numFailedTests, 0)
    for (const path of required) assert.equal(byPath[path].consumedSHA256, byPath[path].inputSHA256, 'Unmutated source consumed: ' + path)
    if (!baselineConsumption) baselineConsumption = byPath
    else for (const path of required) assert.deepEqual(byPath[path], baselineConsumption[path], 'Exact restoration consumed identical bytes: ' + path)
  } else {
    assert.notEqual(exitCode, 0, 'The owning mutation must be RED')
    const failed = assertions.filter(value => value.status === 'failed' && value.fullName.includes(expectedTitle))
    assert.ok(failed.length > 0, 'The specific owning behavior fails: ' + expectedTitle)
    assert.ok(failed.some(value => value.failureMessages.some(text => text.includes('AssertionError'))), 'RED comes from a behavior assertion')
    const selected = cases.find(item => item.mutation === mutation); assert.ok(selected)
    assert.notEqual(byPath[selected.file].consumedSHA256, byPath[selected.file].inputSHA256, 'The actual mutation is consumed')
  }
  await rm(join(directory, 'cache'), { recursive: true, force: true })
  return { mutation, exitCode, assertions: assertions.map(value => ({ title: value.fullName, status: value.status })), consumption }
}

try {
  receipt.callers = await traceCallers()
  receipt.results.push(await run('baseline', 'baseline'))
  for (const item of cases) {
    receipt.results.push(await run(item.mutation, item.mutation, item.title))
    receipt.results.push(await run(item.mutation + '-restored', 'baseline'))
  }
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack }; console.error(error); process.exitCode = 1 }
finally {
  try { assert.deepEqual(await sourceHashes(), original, 'Private mutation proof never writes shared production sources'); receipt.sourceReadbackExact = true }
  catch (error) { receipt.passed = false; receipt.integrityFailure = String(error); process.exitCode = 1 }
  receipt.evidence = evidence
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
console.log(JSON.stringify({ passed: receipt.passed, evidence, results: receipt.results.map(result => ({ mutation: result.mutation, exitCode: result.exitCode })) }))
