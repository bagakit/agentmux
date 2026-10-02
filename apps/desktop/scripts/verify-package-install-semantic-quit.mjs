import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../../..')
const test = 'apps/desktop/test/package-install-semantic-quit.test.ts'
const products = ['apps/desktop/scripts/package-macos.mjs', 'apps/desktop/scripts/package-semantic-host.mjs']
const classifier = 'apps/desktop/scripts/package-process-scope.mjs'
const caller = 'apps/desktop/scripts/update-local.mjs'
const inputs = [...products, classifier, caller, test, 'apps/desktop/scripts/package-runtime-upgrade.mjs',
  'apps/desktop/scripts/verify-package-install-semantic-quit.mjs', 'apps/desktop/test/package-install-restart.test.ts',
  'apps/desktop/test/package-process-scope.test.ts',
  'apps/desktop/scripts/update-identity.mjs', 'apps/desktop/scripts/package-identity.mjs', 'apps/desktop/package.json',
  'package.json', 'vitest.config.ts', 'vitest.setup.ts', 'vitest.dist-freshness.ts', 'pnpm-lock.yaml',
  'packages/core/dist/public-rpc-client.js', 'packages/core/dist/public-rpc.js']
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const hashes = async () => Object.fromEntries(await Promise.all(inputs.map(async name => [name, sha(await fs.readFile(path.join(root, name)))])))
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'))
const directory = path.join(root, '.tmp/package-install-semantic-quit', ("run-" + (globalThis.crypto.randomUUID()) + ""))
await fs.mkdir(directory, { recursive: true, mode: 0o700 })
const write = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
const receipt = { schema: 'agentmux.package-install-semantic-quit-causal.v1', passed: false, sourceRoot: root,
  runRoot: directory, sharedSourceModified: false, sharedDistModified: false, actualAppOrNativeLifecycleRequested: false,
  boundary: 'Actual default installer/quit/semantic fence with controlled private OS and filesystem, not installed App or Native qualification', checks: [], errors: [] }
const successCase = 'the default full installer completes GUI quit while only its fenced semantic owner survives'
const changedCases = ['birth', 'Store', 'PID', 'UID', 'argv', 'mode', 'Source'].map(name =>
  `the default full installer rejects changed ${name} facts before excluding or stopping an owner`)
let caseNames
try {
  receipt.headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  receipt.treeBefore = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root, encoding: 'utf8' }).trim()
  receipt.inputsBefore = await hashes()
  const source = Object.fromEntries(await Promise.all(products.map(async name => [name, await fs.readFile(path.join(root, name), 'utf8')])))
  const handoff = 'await quit(destination, previousScope.processes.filter(row => running.includes(row.pid)), semanticHost)'
  assert.equal(source[products[0]].split(handoff).length - 1, 1, 'The default installer must have exactly one prepared semantic plan handoff')
  const begin = source[products[1]].indexOf('export async function inspectSemanticHostForInstall(')
  const end = source[products[1]].indexOf('/** Called only after normal GUI quit.', begin)
  assert.ok(begin >= 0 && end > begin, 'The owning semantic recheck must have one actual Source block')
  const fence = source[products[1]].slice(begin, end)
  assert.equal(source[products[1]].split(fence).length - 1, 1)
  const weakFence = `export async function inspectSemanticHostForInstall(plan, ops = operations) {
  const processes = await ops.processes(scope(plan.currentApp))
  const row = await ops.processRow(plan.owner.pid)
  return { processes, row }
}

`
  const phases = [
    { name: 'baseline-original', product: products[0], before: handoff, after: handoff, failures: [] },
    { name: 'withdraw-prepared-plan-assertion-red', product: products[0], before: handoff, after: handoff.replace(', semanticHost)', ', null)'), failures: [successCase, ...changedCases] },
    { name: 'prepared-plan-original-restored-green', product: products[0], before: handoff, after: handoff, failures: [] },
    { name: 'relax-exact-semantic-fence-assertion-red', product: products[1], before: fence, after: weakFence, failures: changedCases },
    { name: 'exact-semantic-fence-original-restored-green', product: products[1], before: fence, after: fence, failures: [] }
  ]
  for (const phase of phases) {
    assert.deepEqual(await hashes(), receipt.inputsBefore, 'Actual Source/compiled/caller inputs changed before execution')
    const own = path.join(directory, phase.name); await fs.mkdir(own, { mode: 0o700 })
    const resultFile = path.join(own, 'vitest.json'), captureFile = path.join(own, 'consumed-products.json')
    const cleanupFile = path.join(own, 'private-scope-cleanup.jsonl'), configFile = path.join(own, 'readonly.config.mts')
    const capturedProducts = [...products, classifier]
    const expected = Object.fromEntries(capturedProducts.map(name => [path.join(root, name), receipt.inputsBefore[name]]))
    const config = `import base from ${JSON.stringify(path.join(root, 'vitest.config.ts'))};
import {defineConfig} from 'vitest/config';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
const expected=${JSON.stringify(expected)}, owning=${JSON.stringify(path.join(root, phase.product))};
const before=${JSON.stringify(phase.before)}, after=${JSON.stringify(phase.after)};
const loaded: Record<string,unknown>={};
const sha=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
export default defineConfig({...base,root:${JSON.stringify(root)},plugins:[...(base.plugins??[]),{
 name:'readonly-default-semantic-gui-quit',enforce:'pre',transform(code:string,id:string){
  const product=id.split('?')[0];if(!(product in expected))return;
  if(sha(readFileSync(product))!==expected[product]||sha(code)!==expected[product])throw Error('Actual product Source differs from frozen Vite input');
  let consumed=code;
  if(product===owning){if(code.split(before).length-1!==1)throw Error('Expected one exact product block');consumed=code.replace(before,after);}
  loaded[product]={product,id,sourceSHA256:expected[product],viteInputSHA256:sha(code),consumedSHA256:sha(consumed),consumedBytes:Buffer.byteLength(consumed),changed:consumed!==code,
    originalBlockSHA256:product===owning?sha(before):null,consumedBlockSHA256:product===owning?sha(after):null};
  writeFileSync(${JSON.stringify(captureFile)},JSON.stringify(loaded,null,2));return {code:consumed,map:null};
 }}],test:{...base.test,include:[${JSON.stringify(test)}],passWithNoTests:false,fileParallelism:false,maxWorkers:1}});
`
    await fs.writeFile(configFile, config, { mode: 0o600 })
    const args = ['node_modules/vitest/vitest.mjs', 'run', test, '--config', configFile, '--maxWorkers=1', '--reporter=json', '--outputFile=' + resultFile]
    const log = await fs.open(path.join(own, 'vitest.log'), 'w', 0o600)
    let exitCode
    try {
      exitCode = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, PACKAGE_INSTALL_QUIT_SCOPE_RECEIPT: cleanupFile }, stdio: ['ignore', log.fd, log.fd] })
        child.once('error', reject); child.once('exit', (code, signal) => signal ? reject(Error(`Private test process exited by ${signal}`)) : resolve(code))
      })
    } finally { await log.close() }
    const result = await json(resultFile), loaded = await json(captureFile)
    assert.deepEqual(result.testResults.map(suite => path.relative(root, suite.name)), [test], 'Only the original owning suite may run')
    const cases = result.testResults.flatMap(suite => suite.assertionResults.map(item => ({ name: item.fullName, status: item.status, failureMessages: item.failureMessages ?? [] }))).sort((a, b) => a.name.localeCompare(b.name))
    assert.ok(cases.length > 0); assert.equal(cases.length, result.numTotalTests); assert.equal(result.numPendingTests, 0); assert.equal(result.numTodoTests ?? 0, 0)
    caseNames ??= cases.map(item => item.name); assert.deepEqual(cases.map(item => item.name), caseNames, 'The same nonempty original cases must run for every withdrawal and restore')
    for (const name of capturedProducts) {
      const capture = loaded[path.join(root, name)]
      assert.ok(capture?.consumedBytes > 0, 'Both production modules and unchanged classifier must actually be consumed')
      assert.equal(capture.sourceSHA256, receipt.inputsBefore[name]); assert.equal(capture.viteInputSHA256, receipt.inputsBefore[name])
      const original = name === classifier ? await fs.readFile(path.join(root, name), 'utf8') : source[name]
      assert.equal(capture.consumedSHA256, sha(name === phase.product ? original.replace(phase.before, phase.after) : original))
      assert.equal(capture.changed, name === phase.product && phase.before !== phase.after)
    }
    const scopes = (await fs.readFile(cleanupFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(scopes.length, cases.length, 'Every actual case must close its own private filesystem scope')
    for (const scope of scopes) {
      assert.equal(scope.removed, true); assert.equal(scope.noLiveProcessCreated, true)
      assert.ok(path.basename(scope.root).startsWith('agentmux-semantic-gui-quit-'))
      assert.equal(await fs.access(scope.root).then(() => false, error => { if (error.code === 'ENOENT') return true; throw error }), true)
      assert.ok(scope.signals.every(([pid, signal]) => pid === 211 && signal === 'SIGTERM'), 'Only the controlled exact semantic owner may receive a recorded signal')
    }
    const check = { name: phase.name, command: [process.execPath, ...args], exitCode, total: cases.length,
      passed: result.numPassedTests, failed: result.numFailedTests, cases, loaded, resultFile,
      resultSHA256: sha(await fs.readFile(resultFile)), configSHA256: sha(config), cleanupFile,
      cleanup: { actualCaseCount: scopes.length, errors: [], remaining: [], privateFilesystemRemoved: true, liveProcessCreated: false } }
    receipt.checks.push(check); await write(path.join(directory, 'receipt.json'), receipt)
    const failed = cases.filter(item => item.status === 'failed')
    if (phase.failures.length) {
      assert.equal(exitCode, 1); assert.equal(result.success, false)
      assert.deepEqual(failed.map(item => item.name).sort(), [...phase.failures].sort(), 'Only the named actual product contracts may fail')
      assert.equal(result.numFailedTests, phase.failures.length); assert.equal(result.numPassedTests, cases.length - phase.failures.length)
      for (const item of failed) assert.ok(item.failureMessages.some(message => message.startsWith('AssertionError:') && message.includes(path.join(root, test) + ':')),
        'An actual named owning AssertionError is required; setup, module, type or timeout errors cannot qualify')
      check.qualifiedAssertionRed = true
    } else {
      assert.equal(exitCode, 0); assert.equal(result.success, true); assert.equal(result.numFailedTests, 0)
      assert.ok(cases.every(item => item.status === 'passed')); assert.equal(result.numPassedTests, cases.length)
      check.qualifiedOriginalGreen = true
    }
    assert.deepEqual(await hashes(), receipt.inputsBefore, 'Readonly proof modified an original Source/compiled/caller input')
  }
  const outside = await fs.readFile(path.join(root, caller), 'utf8')
  assert.match(outside, /await installApplication\(join\(import\.meta\.dirname, '\.\.\/release\/mac\/AgentMux\.app'\), \{ intent: uiOnly \? 'ui-only' : 'full' \}\)/)
  assert.match(source[products[0]], /const semanticOwner = semanticHost \? \(await inspectSemanticHostForInstall\(semanticHost\)\)\.row : null/)
  assert.match(source[products[1]], /await inspectSemanticHostForInstall\(plan, ops\)/)
  receipt.productionCallers = [
    { path: caller, sha256: receipt.inputsBefore[caller], relationship: 'Actual update-local calls the full installer with its default quit; no quit override is supplied' },
    { path: products[0], sha256: receipt.inputsBefore[products[0]], relationship: 'Actual installApplication passes its prepared semantic plan to default quit, which consumes the external owning semantic fence' }
  ]
  assert.ok(receipt.productionCallers.length > 0)
  receipt.inputsAfter = await hashes(); assert.deepEqual(receipt.inputsAfter, receipt.inputsBefore)
  receipt.headAfter = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  assert.equal(receipt.headAfter, receipt.headBefore, 'Git identity changed during qualification')
  receipt.passed = true
} catch (error) { receipt.errors.push({ name: error.name, message: error.message, stack: error.stack }) }
finally { await write(path.join(directory, 'receipt.json'), receipt) }
console.log(JSON.stringify({ passed: receipt.passed, receipt: path.join(directory, 'receipt.json'), sha256: sha(await fs.readFile(path.join(directory, 'receipt.json'))),
  checks: receipt.checks.map(check => ({ name: check.name, total: check.total, passed: check.passed, failed: check.failed, qualifiedAssertionRed: check.qualifiedAssertionRed ?? false, qualifiedOriginalGreen: check.qualifiedOriginalGreen ?? false })), errors: receipt.errors }))
if (!receipt.passed) process.exitCode = 1
