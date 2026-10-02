import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../../..')
const renderer = 'apps/desktop/src/renderer/src'
const product = {
  helper: `${renderer}/lib/region-execution-host.ts`, badge: `${renderer}/components/HostBadge.tsx`,
  header: `${renderer}/components/AgentRegionHeader.tsx`, pane: `${renderer}/components/SessionPane.tsx`,
  activity: `${renderer}/components/SessionActivityPresentation.tsx`, css: `${renderer}/styles/agent-region-header.css`
}
const test = 'apps/desktop/test/region-execution-host.test.tsx'
const testHelper = 'apps/desktop/test/helpers/client-ui-render.tsx'
const script = 'apps/desktop/scripts/verify-region-execution-host.mjs'
const callers = [
  { symbol: 'regionExecutionHost', definition: product.helper, caller: product.pane, kind: 'call' },
  { symbol: 'executionHostProjection', definition: product.helper, caller: product.pane, kind: 'call' },
  { symbol: 'HostBadge', definition: product.badge, caller: product.header, kind: 'jsx' },
  { symbol: 'AgentRegionHeader', definition: product.header, caller: product.pane, kind: 'jsx' },
  { symbol: 'AgentRegionHeader', definition: product.header, caller: product.activity, kind: 'jsx' },
  { symbol: 'SessionPane', definition: product.pane, caller: `${renderer}/components/WorkspaceWorkbench.tsx`, kind: 'jsx' }
]
const inputs = [...new Set([...Object.values(product), test, testHelper, script, ...callers.map(item => item.caller),
  'apps/desktop/test/agent-region-identity-menu.test.tsx', 'apps/desktop/test/agent-region-actions.test.tsx',
  'vitest.config.ts', 'vitest.setup.ts', 'vitest.dist-freshness.ts', 'pnpm-lock.yaml'])]
const captured = [product.helper, product.badge, product.header, product.pane, product.activity, test, testHelper]
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const read = file => fs.readFile(path.isAbsolute(file) ? file : path.join(root, file))
const json = async file => JSON.parse(await read(file))
const write = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
const hashes = async () => Object.fromEntries(await Promise.all(inputs.map(async name => [name, hash(await read(name))])))
const evidence = path.join(root, '.tmp/region-execution-host')
await fs.mkdir(evidence, { recursive: true, mode: 0o700 })
const run = path.join(evidence, ("run-" + (globalThis.crypto.randomUUID()) + ""))
await fs.mkdir(run, { mode: 0o700 })
const receipt = { schema: 'agentmux.region-execution-host.qualification.v1', passed: false, sourceRoot: root,
  runRoot: run, mode: process.argv.includes('--receipt') ? 'consume-qualified-artifacts' : 'readonly-product-causal',
  sharedSourceModified: false, sharedDistModified: false, userAppOrRunTouched: false,
  boundary: 'Mounted production SessionPane/Header tests; private readonly transforms. Native paint and restart require the separate ordinary Electron proof and independent full-picture review.',
  checks: [], errors: [] }

async function productionCallers() {
  const ts = createRequire(import.meta.url)('typescript'), found = []
  for (const item of callers) {
    assert.notEqual(item.definition, item.caller)
    const source = (await read(item.caller)).toString(), ast = ts.createSourceFile(item.caller, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX), hits = []
    const visit = node => {
      if (item.kind === 'call' && ts.isCallExpression(node) && node.expression.getText(ast) === item.symbol) hits.push(node.getText(ast))
      if (item.kind === 'jsx' && (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(ast) === item.symbol) hits.push(node.getText(ast))
      ts.forEachChild(node, visit)
    }
    visit(ast)
    assert.ok(hits.length > 0, `A non-import production consumer is required: ${item.symbol} in ${item.caller}`)
    found.push({ ...item, sourceSHA256: hash(source), hits })
  }
  assert.ok(found.length > 0)
  return found
}

async function causal() {
  const selector = "const hostId = session.kind === 'agent' ? session.control.hostId : session.hostId"
  const badge = '<HostBadge host={executionHost} />'
  const submittedHost = 'pendingLaunch ? executionHostProjection(pendingLaunch.request?.hostId, pendingLaunch.request?.workspacePath, configuredExecutionHost)'
  const preSnapshotHeader = `<AgentRegionHeader name={name} executorLabel={surfaceKind === 'terminal' ? 'Shell' : executorLabel}
      sessionId={sessionId} sessionKind={surfaceKind} executionHost={preSnapshotHost}
      regionId={linkOrigin.regionId} readOnly={readOnly} portalTargetId={headerPortalTargetId} onHistory={undefined} />`
  const controlCase = 'the actual Agent Region uses its original control Host even in a local display and with a different snapshot label'
  const phases = [
    { name: 'original-baseline-green', target: product.helper, before: selector, after: selector },
    { name: 'wrong-execution-host-assertion-red', target: product.helper, before: selector, after: 'const hostId = session.hostId', required: [controlCase] },
    { name: 'original-execution-host-restored-green', target: product.helper, before: selector, after: selector },
    { name: 'remove-visible-host-assertion-red', target: product.header, before: badge, after: '{/* private readonly withdrawal of the original Host projection */}', required: [controlCase], withdrawnModule: product.badge },
    { name: 'original-visible-host-restored-green', target: product.header, before: badge, after: badge },
    { name: 'borrow-core-local-identity-assertion-red', target: product.pane, before: submittedHost,
      after: 'pendingLaunch ? executionHostProjection(pendingLaunch.created?.hostId ?? pendingLaunch.request?.hostId, pendingLaunch.request?.workspacePath, configuredExecutionHost)',
      required: ['an accepted remote creation uses the frozen submitted endpoint rather than Core server-local identity',
        'an accepted Core receipt without the original endpoint stays unknown instead of becoming This Mac'] },
    { name: 'original-submitted-host-restored-green', target: product.pane, before: submittedHost, after: submittedHost },
    { name: 'withdraw-pre-snapshot-header-assertion-red', target: product.pane, before: preSnapshotHeader, after: 'null',
      required: ['a missing Agent or Terminal snapshot exposes unknown Host while preserving its original connecting surface',
        'the no-snapshot recovery surface shows only its original Core recovery-candidate Host and cwd',
        'the original retired History keeps its Core Host through the existing reader and More return without a new Run'] },
    { name: 'original-pre-snapshot-header-restored-green', target: product.pane, before: preSnapshotHeader, after: preSnapshotHeader }
  ]
  let names
  for (const phase of phases) {
    assert.deepEqual(await hashes(), receipt.inputsBefore, 'Owning Source/test/caller inputs changed before the phase')
    const own = path.join(run, phase.name); await fs.mkdir(own, { mode: 0o700 })
    const config = path.join(own, 'readonly.config.mts'), output = path.join(own, 'vitest.json'), capture = path.join(own, 'consumed-source.json')
    const expected = Object.fromEntries(captured.map(name => [path.join(root, name), receipt.inputsBefore[name]]))
    const source = (await read(phase.target)).toString()
    assert.equal(source.split(phase.before).length - 1, 1, 'There must be exactly one actual owning product block')
    const transformed = source.replace(phase.before, phase.after)
    await fs.writeFile(path.join(own, 'original-product.txt'), source, { mode: 0o600 })
    await fs.writeFile(path.join(own, 'consumed-product.txt'), transformed, { mode: 0o600 })
    const configSource = `import base from ${JSON.stringify(path.join(root, 'vitest.config.ts'))};
import {defineConfig} from 'vitest/config';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
const expected=${JSON.stringify(expected)},target=${JSON.stringify(path.join(root, phase.target))};
const before=${JSON.stringify(phase.before)},after=${JSON.stringify(phase.after)},loaded:Record<string,unknown>={};
const sha=(source:string|Buffer)=>createHash('sha256').update(source).digest('hex');
export default defineConfig({...base,root:${JSON.stringify(root)},plugins:[...(base.plugins??[]),{
 name:'readonly-region-execution-host',enforce:'pre',transform(code:string,id:string){
 const file=id.split('?')[0];if(!(file in expected))return;
 if(sha(readFileSync(file))!==expected[file]||sha(code)!==expected[file])throw Error('Actual Source differs from frozen Vite input');
 let consumed=code;if(file===target){if(code.split(before).length-1!==1)throw Error('Expected exactly one owning product block');consumed=code.replace(before,after);}
 loaded[file]={sourceSHA256:expected[file],viteInputSHA256:sha(code),consumedCodeSHA256:sha(consumed),bytes:Buffer.byteLength(consumed),changed:consumed!==code};
 writeFileSync(${JSON.stringify(capture)},JSON.stringify(loaded,null,2));return{code:consumed,map:null};
 }}],test:{...base.test,include:[${JSON.stringify(test)}],passWithNoTests:false,fileParallelism:false,maxWorkers:1}});
`
    await fs.writeFile(config, configSource, { mode: 0o600 })
    const args = ['node_modules/vitest/vitest.mjs', 'run', test, '--config', config, '--maxWorkers=1', '--reporter=json', '--outputFile=' + output]
    const log = await fs.open(path.join(own, 'vitest.log'), 'w', 0o600)
    let exitCode
    try {
      exitCode = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env }, stdio: ['ignore', log.fd, log.fd] })
        child.once('error', reject); child.once('exit', (code, signal) => signal ? reject(Error(`Private test process terminated by ${signal}`)) : resolve(code))
      })
    } finally { await log.close() }
    const result = await json(output), loaded = await json(capture)
    assert.deepEqual(result.testResults.map(suite => path.relative(root, suite.name)), [test])
    const cases = result.testResults.flatMap(suite => suite.assertionResults.map(item => ({ name: item.fullName, status: item.status, failureMessages: item.failureMessages ?? [] }))).sort((a, b) => a.name.localeCompare(b.name))
    assert.ok(cases.length > 0); assert.equal(cases.length, result.numTotalTests)
    assert.equal(result.numPendingTests, 0); assert.equal(result.numTodoTests ?? 0, 0)
    names ??= cases.map(item => item.name); assert.deepEqual(cases.map(item => item.name), names)
    for (const name of captured) {
      const observed = loaded[path.join(root, name)]
      // Removing the only JSX call also removes its unused TS import during compilation.
      // This precise withdrawal is proved by the original/restored captures, not treated
      // as a second consumer. Every other original module remains mandatory.
      if (name === phase.withdrawnModule) { assert.equal(observed, undefined); continue }
      assert.ok(observed?.bytes > 0, `The real owning module must be consumed: ${name}`)
      assert.equal(observed.sourceSHA256, receipt.inputsBefore[name]); assert.equal(observed.viteInputSHA256, receipt.inputsBefore[name])
      assert.equal(observed.consumedCodeSHA256, hash(name === phase.target ? transformed : await read(name)))
      assert.equal(observed.changed, name === phase.target && phase.before !== phase.after)
    }
    const failed = cases.filter(item => item.status === 'failed')
    const check = { name: phase.name, command: [process.execPath, ...args], exitCode, total: cases.length,
      passed: result.numPassedTests, failed: result.numFailedTests, cases, loaded, resultFile: output,
      resultSHA256: hash(await read(output)), configSHA256: hash(configSource), target: phase.target,
      originalBlockSHA256: hash(phase.before), consumedBlockSHA256: hash(phase.after), qualifiedAssertionRed: false, qualifiedOriginalGreen: false }
    if (phase.withdrawnModule) check.withdrawnModule = phase.withdrawnModule
    receipt.checks.push(check); await write(path.join(run, 'receipt.json'), receipt)
    if (phase.required) {
      assert.equal(exitCode, 1); assert.equal(result.success, false); assert.ok(failed.length > 0)
      for (const name of phase.required) assert.ok(failed.some(item => item.name === name), `The named owning assertion must fail: ${name}`)
      for (const item of failed) assert.ok(item.failureMessages.some(message => message.startsWith('AssertionError:') && message.includes(path.join(root, test) + ':')),
        'Only actual owning assertions qualify; setup, module, type and timeout failures do not')
      assert.equal(result.numFailedTests, failed.length); assert.equal(result.numPassedTests, cases.length - failed.length)
      check.qualifiedAssertionRed = true
    } else {
      assert.equal(exitCode, 0); assert.equal(result.success, true); assert.equal(result.numFailedTests, 0)
      assert.equal(result.numPassedTests, cases.length); assert.ok(cases.every(item => item.status === 'passed'))
      check.qualifiedOriginalGreen = true
    }
    assert.deepEqual(await hashes(), receipt.inputsBefore, 'Readonly transform altered an original product or test input')
    process.stdout.write(`${phase.name}: ${check.passed}/${check.total} passed, ${check.failed} actual assertion failures\n`)
  }
  receipt.productionCallers = await productionCallers()
}

async function artifacts() {
  const causalPath = path.join(evidence, 'latest-causal.json'), old = await json(causalPath)
  assert.equal(old.schema, receipt.schema); assert.equal(old.mode, 'readonly-product-causal'); assert.equal(old.passed, true)
  assert.deepEqual(old.inputsBefore, receipt.inputsBefore); assert.deepEqual(old.inputsAfter, receipt.inputsBefore)
  assert.equal(old.checks.filter(item => item.qualifiedAssertionRed).length, 4)
  assert.equal(old.checks.filter(item => item.qualifiedOriginalGreen).length, 5)
  assert.ok(old.productionCallers.length > 0)
  for (const check of old.checks) {
    assert.ok(check.total > 0); assert.equal(hash(await read(check.resultFile)), check.resultSHA256)
  }
  receipt.causal = { file: causalPath, sha256: hash(await read(causalPath)), checks: old.checks }
  receipt.productionCallers = await productionCallers()
  const proofPath = process.env.AGENTMUX_HOST_UI_PROOF ?? path.join(root, '.tmp/host-ui-execution/proof.json')
  const reviewPath = process.env.AGENTMUX_HOST_UI_VISUAL_REVIEW ?? path.join(root, '.tmp/host-ui-execution/independent-visual-review.json')
  const proof = await json(proofPath), review = await json(reviewPath), proofHash = hash(await read(proofPath))
  assert.equal(proof.schema, 'agentmux.host-ui-execution.proof.v1'); assert.equal(proof.passed, true)
  assert.equal(proof.userAppTouched, false); assert.equal(proof.originalBusinessSessionMutation, false); assert.equal(proof.remoteOwnerLifecycleAction, false)
  assert.deepEqual(proof.sourceAfter, proof.sourceBefore); assert.deepEqual(proof.compiledAfter, proof.compiledBefore)
  assert.ok(Object.keys(proof.compiledBefore).length > 0)
  for (const name of Object.values(product)) {
    const observed = proof.consumedModules[path.join(root, name)] ?? proof.consumedModules[name]
    assert.ok(observed && observed.consumedCodeSHA256, `The ordinary renderer must actually consume ${name}`)
    assert.equal(observed.sourceSHA256, receipt.inputsBefore[name])
  }
  assert.deepEqual(proof.phases.map(one => one.phase), ['seed', 'restore'])
  assert.equal(new Set(proof.phases.map(one => one.native.electronPid)).size, 2)
  for (const phase of proof.phases) {
    assert.equal(phase.exit.exitCode, 0); assert.equal(phase.exit.timedOut, false); assert.equal(phase.native.passed, true)
    assert.ok(phase.originalLocalRun.pid > 0); assert.equal(phase.originalLocalRun.state, 'running')
    assert.ok(phase.native.calls.length > 0)
  }
  assert.deepEqual(proof.phases[0].originalLocalRun, proof.phases[1].originalLocalRun)
  assert.deepEqual(proof.phases[0].localHostOwner, proof.phases[1].localHostOwner)
  const restored = proof.phases[1].native
  assert.ok(restored.headerObservations.length > 0, 'Actual remote Agent and ordinary Terminal headers must be observed')
  for (const item of restored.headerObservations) for (const control of [item.host, item.more, item.close])
    assert.ok(control.width > 0 && control.height > 0 && control.hitBelongs)
  assert.ok(proof.cleanup.owned.length > 0)
  assert.deepEqual(proof.cleanup.stopped.map(({ beforeState, action, ...identity }) => {
    assert.ok(typeof beforeState === 'string' && beforeState.length > 0)
    assert.equal(action, 'public-stop')
    return identity
  }), proof.cleanup.owned, 'Every owned Session/Host/Run is stopped through its actual public owner')
  assert.deepEqual(proof.cleanup.errors, []); assert.deepEqual(proof.cleanup.remaining, []); assert.equal(proof.cleanup.privateRootRemoved, true)
  assert.equal(proof.cleanup.originalBusinessSessionStopped, false); assert.equal(proof.cleanup.sharedRemoteHostStopped, false)
  assert.equal(review.conclusion, 'accepted'); assert.ok(typeof review.reviewer === 'string' && review.reviewer.trim())
  assert.notEqual(review.reviewer, '/root/core_finalreview', 'Implementation cannot approve its own images')
  assert.equal(review.proofSHA256, proofHash)
  assert.ok(proof.screenshots.length > 0)
  assert.deepEqual(review.screenshots.map(one => one.sha256).sort(), proof.screenshots.map(one => one.sha256).sort(), 'Every current full picture requires independent review')
  for (const picture of proof.screenshots) {
    const bytes = await read(picture.absolutePath)
    assert.equal(hash(bytes), picture.sha256); assert.equal(bytes.length, picture.bytes)
    assert.equal(bytes.readUInt32BE(16), picture.width); assert.equal(bytes.readUInt32BE(20), picture.height)
    assert.ok(picture.width > 0 && picture.height > 0)
    assert.ok(review.screenshots.some(one => one.sha256 === picture.sha256 && one.viewed === true))
  }
  receipt.native = { file: proofPath, sha256: proofHash, sourceBefore: proof.sourceBefore, screenshots: proof.screenshots }
  receipt.independentVisualReview = { file: reviewPath, sha256: hash(await read(reviewPath)), reviewer: review.reviewer }
}

try {
  receipt.head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  receipt.inputsBefore = await hashes()
  if (process.argv.includes('--receipt')) await artifacts()
  else await causal()
  receipt.inputsAfter = await hashes(); assert.deepEqual(receipt.inputsAfter, receipt.inputsBefore)
  receipt.passed = true
} catch (error) { receipt.errors.push({ name: error.name, message: error.message, stack: error.stack }) }
finally {
  await write(path.join(run, 'receipt.json'), receipt)
  if (receipt.passed && receipt.mode === 'readonly-product-causal') await write(path.join(evidence, 'latest-causal.json'), receipt)
}
console.log(JSON.stringify({ passed: receipt.passed, mode: receipt.mode, receipt: path.join(run, 'receipt.json'),
  sha256: hash(await read(path.join(run, 'receipt.json'))), checks: receipt.checks.map(({ name, total, passed, failed }) => ({ name, total, passed, failed })), errors: receipt.errors }))
if (!receipt.passed) process.exitCode = 1
