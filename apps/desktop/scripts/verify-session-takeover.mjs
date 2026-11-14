import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const evidence = resolve(root, process.argv.find(value => value.startsWith('--evidence='))?.slice(11) ?? ".tmp/session-takeover-fixture")
await mkdir(evidence, { recursive: true })
if (process.argv.includes('--native')) {
  const liveAdoption = process.argv.includes('--live-adoption'), agentOperations = process.argv.includes('--agent-operations')
  assert.ok(!(liveAdoption && agentOperations), 'Live adoption and Stop/Fork have distinct native qualifications')
  // Consume an existing exact-candidate capture. A Tracker-wide receipt refresh
  // must not rerun real Electron operations or invalidate reviewed images.
  try {
    assert.ok(!process.argv.some(value => value.startsWith('--native-mutant=')), 'Mutation cannot consume a normal candidate receipt')
    assert.ok(!process.argv.includes('--preflight'), 'Preflight cannot consume a final candidate receipt')
    const captured = JSON.parse(await readFile(join(evidence, 'receipt.json'), 'utf8'))
    const hash = value => createHash('sha256').update(value).digest('hex')
    assert.equal(captured.passed, true)
    assert.equal(captured.processes.length, 2)
    assert.ok(captured.frames.length > 0)
    if (!liveAdoption && !agentOperations) {
      assert.equal(captured.schema, 'agentmux.takeover-flow-native.v1')
      assert.equal(captured.qualification, 'public-takeover-renderer-recovery-v1')
      assert.deepEqual(captured.drift, [])
      assert.equal(captured.cleanup.removed, true)
      assert.deepEqual(captured.cleanup.remaining, [])
      const [first, second] = captured.processes
      assert.equal(first.mode, 'first'); assert.equal(second.mode, 'second')
      assert.notEqual(first.actual.processId, second.actual.processId)
      for (const process of captured.processes) {
        assert.equal(process.actual.passed, true)
        assert.equal(process.outcome.exitCode, 0)
        assert.equal(process.outcome.timedOut, false)
        assert.equal(process.outcome.interruption, null)
      }
      assert.equal(second.actual.restart.noWorkfaceReseed, true)
      assert.equal(second.actual.restart.noReplay, true)
      assert.ok(second.actual.restart.originalRequest)
      for (const map of [captured.inputs, captured.coreSpatialInputs]) {
        assert.ok(map && Object.keys(map).length > 0)
        for (const [file, digest] of Object.entries(map)) assert.equal(hash(await readFile(resolve(root, file))), digest)
      }
      assert.ok(captured.generatedIdentitySource?.file)
      assert.equal(hash(await readFile(resolve(root, captured.generatedIdentitySource.file))), captured.generatedIdentitySource.sha256)
    } else {
      assert.equal(captured.processes[0].mode, 'first'); assert.equal(captured.processes[1].mode, 'second')
      assert.notEqual(captured.processes[0].rendered.processId, captured.processes[1].rendered.processId)
      for (const process of captured.processes) {
        assert.equal(process.rendered.passed, true)
        assert.equal(process.outcome.exitCode, 0)
        assert.equal(process.outcome.timedOut, false)
        assert.equal(process.outcome.interruption, null)
      }
      if (liveAdoption) {
        assert.equal(captured.schema, 'agentmux.session-takeover-native.v1')
        assert.equal(captured.qualification, 'live-adoption-v1')
        assert.equal(captured.processes[0].rendered.liveReattached.noLaunch, true)
        assert.equal(captured.processes[1].rendered.restart.noReplay, true)
      }
      if (agentOperations) {
        const { assertStopForkScenarios } = createRequire(import.meta.url)('./fixtures/session-takeover/agent-operations-main.cjs')
        assert.equal(captured.qualification, 'stop-fork-feedback-v1', 'Only the current exact Stop/Fork qualification can certify its feedback')
        assert.equal(captured.schema, 'agentmux.stop-fork-feedback-native.v1')
        for (const process of captured.processes) {
          assert.equal(process.rendered.agentOperations?.qualification, 'stop-fork-feedback-v1')
          assertStopForkScenarios(process.rendered.agentOperations.scenarios, process.mode)
        }
        assert.ok(captured.processes?.[0]?.rendered?.agentOperations?.costSamples.length >= 6)
        assert.ok(captured.processes?.[0]?.rendered?.agentOperations?.motion.length >= 5)
        assert.ok(captured.processes?.[1]?.rendered?.agentOperations?.restart?.operationReferencesPreserved)
        assert.ok(captured.processes?.[1]?.rendered?.agentOperations?.restart?.noReplay)
      }
      assert.ok(captured.cleanup.privateRootRemoved)
      assert.deepEqual(captured.cleanup.remaining, [])
      assert.deepEqual(captured.cleanup.errors, [])
      for (const map of [captured.sourceBefore, captured.stylesBefore, captured.coreSpatialInputs]) {
        assert.ok(map && Object.keys(map).length > 0)
        for (const [file, digest] of Object.entries(map)) assert.equal(hash(await readFile(resolve(root, file))), digest)
      }
      assert.deepEqual(captured.sourceBefore, captured.sourceAfter)
      assert.deepEqual(captured.stylesBefore, captured.stylesAfter)
      assert.deepEqual(captured.fixtureBefore, captured.fixtureAfter)
      for (const [file, digest] of Object.entries(captured.fixtureBefore)) assert.equal(hash(await readFile(join(import.meta.dirname, 'fixtures/session-takeover', file))), digest)
    }
    for (const frame of captured.frames) assert.equal(hash(await readFile(join(evidence, frame.file))), frame.sha256)
    process.stdout.write('Consumed current production Electron capture and restart proof.\n')
    process.exit(0)
  } catch { /* Missing, failed or changed input requires fresh actual capture. */ }
  const { runNative } = await import('./fixtures/session-takeover/native.mjs')
  await runNative(evidence, { liveAdoption: process.argv.includes('--live-adoption'), agentOperations: process.argv.includes('--agent-operations'), preflight: process.argv.includes('--preflight'), nativeMutant: process.argv.find(value => value.startsWith('--native-mutant='))?.slice('--native-mutant='.length) })
  process.exit(0)
}
const sha = value => createHash('sha256').update(value).digest('hex')
const prefix = 'apps/desktop/src/renderer/src/'
const modules = ['components/AgentExecutorPicker.tsx', 'components/SessionTakeoverSurface.tsx', 'components/SessionPane.tsx',
  'components/AgentRegionHeader.tsx', 'components/NewTabSurface.tsx', 'lib/session-takeover.ts', 'lib/space-agent-control.ts',
  'lib/desktop-spatial-state.ts', 'lib/desktop-agent-presentation.ts', 'store.ts', 'styles/session-takeover.css', 'styles/index.css']
const test = 'apps/desktop/test/session-takeover.test.tsx'
const inputs = async () => Object.fromEntries(await Promise.all([...modules.map(file => prefix + file), test].map(async file => [file, sha(await readFile(join(root, file)))])))
const ts = createRequire(import.meta.url)('typescript')
const callers = []
for (const [symbol, definition, caller, kind] of [
  ['AgentExecutorPicker', 'components/AgentExecutorPicker.tsx', 'components/NewTabSurface.tsx', 'jsx'],
  ['AgentExecutorPicker', 'components/AgentExecutorPicker.tsx', 'components/SessionTakeoverSurface.tsx', 'jsx'],
  ['SessionTakeoverSurface', 'components/SessionTakeoverSurface.tsx', 'components/SessionPane.tsx', 'jsx'],
  ['takeOverSession', 'lib/session-takeover.ts', 'components/SessionTakeoverSurface.tsx', 'call'],
  ['executeControl', 'store.ts', 'lib/session-takeover.ts', 'call'],
  ['openAgent', 'lib/api.ts', 'lib/session-takeover.ts', 'call']
]) {
  assert.notEqual(definition, caller)
  const path = join(root, prefix, caller), bytes = await readFile(path, 'utf8'), file = ts.createSourceFile(path, bytes, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX), hits = []
  const visit = node => {
    if (kind === 'jsx' && (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(file) === symbol ||
      kind === 'call' && ts.isCallExpression(node) && (node.expression.getText(file) === symbol || node.expression.getText(file).endsWith('.' + symbol))) hits.push(node.getText(file))
    ts.forEachChild(node, visit)
  }
  visit(file); assert.ok(hits.length > 0, 'Actual non-definition caller: ' + caller)
  callers.push({ symbol, definition: prefix + definition, caller: prefix + caller, hits })
}
const before = await inputs(), checks = []
const phases = [
  { name: 'original-green' },
  { name: 'drop-custom-instruction-red', target: 'lib/session-takeover.ts', before: 'agentDerivedActionPrompt(source.derived, source, initial ?? undefined)', after: "agentDerivedActionPrompt({ ...source.derived, instruction: '' }, source, initial ?? undefined)", test: 'a custom new-agent action creates its own Agent from the same source with its own identity, instruction and name' },
  { name: 'clip-custom-instruction-red', target: 'lib/session-takeover.ts', before: 'agentDerivedActionPrompt(source.derived, source, initial ?? undefined)', after: 'agentDerivedActionPrompt({ ...source.derived, instruction: source.derived.instruction.slice(0, 700) }, source, initial ?? undefined)', test: 'custom derived instructions and original diagnostic remain complete at the prompt boundary' },
  { name: 'withdraw-region-entry-red', target: 'components/SessionPane.tsx', before: "onTakeOver={retainedHistory?.state === 'deleted' ? undefined : takeOverAt(origin, displayId)}", after: 'onTakeOver={undefined}', test: 'the real Agent Region exposes Take over and opening/cancelling keeps its draft without launching' },
  { name: 'restored-green' }
]
for (const phase of phases) {
  const directory = join(evidence, 'source', phase.name); await mkdir(directory, { recursive: true })
  const config = join(directory, 'config.mts'), output = join(directory, 'tests.json'), consumed = join(directory, 'consumed.json')
  if (phase.target) assert.equal((await readFile(join(root, prefix, phase.target), 'utf8')).split(phase.before).length - 1, 1)
  // The existing source config resolves the current public packages without
  // borrowing stale distribution output or building another Renderer.
  const code = `import base from ${JSON.stringify(join(root, 'apps/desktop/test/agent-promotion-ui.config.mts'))};
import {defineConfig} from 'vitest/config';import{writeFileSync}from'node:fs';import{createHash}from'node:crypto';
const loaded={},target=${JSON.stringify(phase.target ? join(root, prefix, phase.target) : null)};
export default defineConfig({...base,root:${JSON.stringify(root)},plugins:[...base.plugins??[],{name:'readonly-takeover-source',enforce:'pre',transform(code,id){const file=id.split('?')[0];if(!file.startsWith(${JSON.stringify(join(root, prefix))}))return;let transformed=code;if(file===target){if(code.split(${JSON.stringify(phase.before ?? '')}).length-1!==1)throw Error('Owning mutation block changed');transformed=code.replace(${JSON.stringify(phase.before ?? '')},${JSON.stringify(phase.after ?? '')});}loaded[file]={before:createHash('sha256').update(code).digest('hex'),after:createHash('sha256').update(transformed).digest('hex')};writeFileSync(${JSON.stringify(consumed)},JSON.stringify(loaded));return{code:transformed,map:null}}}],test:{...base.test,include:[${JSON.stringify(test)}],passWithNoTests:false,fileParallelism:false,maxWorkers:1}});`
  await writeFile(config, code)
  const args = ['node_modules/vitest/vitest.mjs', 'run', test, '--config', config, '--reporter=json', '--outputFile=' + output]
  const log = []
  const exit = await new Promise((done, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', data => log.push(data.toString())); child.stderr.on('data', data => log.push(data.toString()))
    child.once('error', reject); child.once('exit', code => done(code))
  })
  await writeFile(join(directory, 'tests.log'), log.join(''))
  const result = JSON.parse(await readFile(output, 'utf8')), loaded = JSON.parse(await readFile(consumed, 'utf8'))
  const tests = result.testResults.flatMap(suite => suite.assertionResults)
  assert.ok(tests.length > 0, 'The entire nonempty scoped suite must execute')
  const baseline = checks.find(check => check.name === 'original-green')
  if (baseline) assert.deepEqual(tests.map(item => item.fullName).sort(), baseline.testNames, 'Every phase must run the same complete scoped suite')
  assert.equal(result.numPendingTests, 0)
  if (!phase.test) { assert.equal(exit, 0, log.join('')); assert.equal(result.numFailedTests, 0) }
  else {
    assert.equal(exit, 1); const failed = tests.filter(item => item.status === 'failed')
    assert.ok(failed.some(item => item.fullName.includes(phase.test)), 'The actual owning assertion must turn red')
    assert.ok(failed.every(item => item.failureMessages.some(message => message.startsWith('AssertionError:'))), 'Setup/compile/timeout failures do not qualify')
    const input = loaded[join(root, prefix, phase.target)]
    assert.equal(input.before, before[prefix + phase.target]); assert.notEqual(input.after, input.before)
  }
  for (const file of modules.filter(file => !file.endsWith('.css'))) assert.equal(loaded[join(root, prefix, file)]?.before, before[prefix + file], 'Actual product consumption: ' + file)
  assert.deepEqual(await inputs(), before, 'Private transform cannot mutate shared source')
  checks.push({ name: phase.name, exit, total: tests.length, failed: result.numFailedTests, testNames: tests.map(item => item.fullName).sort(), testFile: output, consumed, qualifiedAssertionRed: Boolean(phase.test) })
  process.stdout.write(phase.name + ': ' + result.numPassedTests + '/' + tests.length + ' passed\n')
}
const receipt = { schema: 'agentmux.session-takeover-source.v1', passed: true, sources: before, callers, checks,
  sharedSourceModified: false, userRunTouched: false, boundary: 'Original mounted menu/SessionPane/Stage cancellation, experience review and user-authored derived actions. Custom derived creation consumes its original Desktop Control owner with controlled Native launch facts. Built-in Takeover creation is verified separately by takeover-flow and takeover-flow-main through the public Core/Host/Main owners; this receipt does not certify native CLI or Renderer restart.' }
await writeFile(join(evidence, 'ui-source-receipt.json'), JSON.stringify(receipt, null, 2))
