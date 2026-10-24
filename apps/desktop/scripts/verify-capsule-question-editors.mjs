import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runProbeProcess, listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'
import { desktopRequire } from './fixtures/settings-resource-library/environment.mjs'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const args = process.argv.slice(2), outputAt = args.indexOf('--output')
if (outputAt >= 0) assert.ok(args[outputAt + 1], '--output needs a directory')
await mkdir(join(root, '.tmp'), { recursive: true })
const output = outputAt < 0 ? await mkdtemp(join(root, '.tmp/capsule-question-editors-')) : resolve(root, args[outputAt + 1])
await mkdir(output, { recursive: true })
process.stdout.write(JSON.stringify({ evidence: output }) + '\n')
const editor = 'apps/desktop/src/renderer/src/lib/capsule-question-editors.tsx'
const reply = 'apps/desktop/src/renderer/src/components/CapsuleQuestionReply.tsx'
const store = 'apps/desktop/src/renderer/src/store.ts'
const owner = 'packages/capsule/src/node.ts'
const suite = 'apps/desktop/test/capsule-question-editors.test.tsx'
const base = 'apps/desktop/test/capsule-question-editors.config.mts'
const tracked = [editor, reply, store, owner, 'apps/desktop/src/renderer/src/components/DesktopClientUiProvider.tsx',
  'apps/desktop/src/renderer/src/components/CapsuleInteractionChrome.tsx']
const inputs = [...tracked, suite, base, 'apps/desktop/scripts/verify-capsule-question-editors.mjs']
const sources = Object.fromEntries(await Promise.all(inputs.map(async file => [file, await readFile(join(root, file), 'utf8')])))
const sha = value => createHash('sha256').update(value).digest('hex')
const mutants = [
  { id: 'editor-workbench-projection-disconnected', file: store, from: 'capsuleQuestionEditors: state.capsuleQuestionEditors,', to: 'capsuleQuestionEditors: {},',
    test: 'persists even an empty dirty answer through the real Workbench writer and restore without autosaving on remount',
    failure: 'Original Workbench writer must include the empty dirty answer' },
  { id: 'stale-outcome-overwrites-current', file: reply, from: 'return left?.method === right.method && JSON.stringify(left.params) === JSON.stringify(right.params)', to: 'return true',
    test: 'rejects a stale original result after a newer exact editor attempt replaced its handle',
    failure: 'Late outcomes must compare the exact original attempt before updating the current editor' },
  { id: 'restored-promise-guessed-running', file: editor, from: 'attempt: { ...editor.attempt, pending: false }', to: 'attempt: { ...editor.attempt, pending: true }',
    test: 'restores a persisted pending handle as inspectable unknown without inventing a new operation',
    failure: 'A restored handle cannot claim that its old JavaScript promise is still running' },
  { id: 'dispatch-after-stale-durability', file: reply, from: 'return original === held && original.pending', to: 'return true',
    test: 'rechecks the exact original attempt after delayed durability before Save draft dispatch',
    failure: 'A stale original attempt cannot dispatch after the durability await' },
  { id: 'writer-stale-cas-admitted', file: store, from: 'if (state.capsuleQuestionEditors[key] !== expected) return state', to: 'if (false) return state',
    test: 'the original writer refuses a stale compare-and-swap without clearing newer retained bytes',
    failure: 'The existing editor owner must reject stale replacement' }
].map(mutant => {
  assert.equal(sources[mutant.file].split(mutant.from).length - 1, 1, 'Exactly one actual owning source anchor: ' + mutant.id)
  return { ...mutant, source: sources[mutant.file].replace(mutant.from, mutant.to) }
})
const plan = join(output, 'plan.json'), config = join(output, 'verify.config.mts')
await writeFile(plan, JSON.stringify({ editor, tracked, suite, mutants }, null, 2) + '\n')
let baseImport = relative(output, join(root, base))
if (!baseImport.startsWith('.')) baseImport = './' + baseImport
await writeFile(config, `import base from ${JSON.stringify(baseImport)}
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
const plan=JSON.parse(readFileSync(process.env.CAPSULE_EDITORS_PLAN!,'utf8'))
const mutant=plan.mutants.find(item=>item.id===process.env.CAPSULE_EDITORS_MUTANT)
const capture={consumed:0,loaded:{},compiled:{}}
const sha=value=>createHash('sha256').update(value).digest('hex')
const publish=()=>writeFileSync(process.env.CAPSULE_EDITORS_CAPTURE!,JSON.stringify(capture))
export default {...base,cacheDir:process.env.CAPSULE_EDITORS_CACHE,plugins:[...base.plugins,
{name:'capsule-editor-owner-source',enforce:'pre',transform(input,id){
 const file=relative(base.root,id.split('?')[0]);if(!plan.tracked.includes(file))return
 const original=readFileSync(id.split('?')[0],'utf8'),text=mutant&&file===mutant.file?mutant.source:input
 capture.loaded[file]={originalSha256:sha(original),loadedSha256:sha(text)}
 if(mutant&&file===mutant.file)capture.consumed++;publish();return{code:text,map:null}
}},{name:'capsule-editor-compiled-source',enforce:'post',transform(code,id){
 const file=relative(base.root,id.split('?')[0]);if(!plan.tracked.includes(file))return
 capture.compiled[file]=sha(code);publish()
}}],test:{...base.test,include:[plan.suite],maxWorkers:1,passWithNoTests:false}}
`)
const runs = []
let baselineCount
async function run(mutant) {
  const id = mutant?.id ?? (baselineCount === undefined ? 'baseline' : 'restored'), report = join(output, id + '.tests.json'), capturePath = join(output, id + '.capture.json')
  await Promise.all([rm(report, { force: true }), rm(capturePath, { force: true })])
  const lines = []
  let originalPid, execution
  try {
    execution = await runProbeProcess(process.execPath, [desktopRequire.resolve('vitest/vitest.mjs'), 'run', '--config', config, '--configLoader', 'runner',
      '--reporter=json', '--outputFile', report], { cwd: root, timeoutMs: 60000,
      onSpawn: value => { originalPid = value.originalPid }, onLine: line => lines.push(line), env: { ...process.env,
      CAPSULE_EDITORS_PLAN: plan, CAPSULE_EDITORS_CAPTURE: capturePath, CAPSULE_EDITORS_MUTANT: mutant?.id ?? '',
      CAPSULE_EDITORS_CACHE: join(output, 'cache') } })
  } finally {
    if (originalPid) await stopProbeProcesses(originalPid, output)
    const remainingProcesses = await listProbeProcesses(originalPid ?? -1, output)
    await writeFile(join(output, id + '.process.json'), JSON.stringify({ execution, remainingProcesses }, null, 2))
    assert.equal(remainingProcesses.length, 0, 'Only the exact private validation child/group must finish')
  }
  assert.ok(execution.exitConfirmed && !execution.timedOut && !execution.exitSignal, 'The exact validation child must exit normally')
  const exitCode = execution.exitCode, log = lines.join('\n')
  await writeFile(join(output, id + '.log'), log)
  const result = JSON.parse(await readFile(report, 'utf8')), capture = JSON.parse(await readFile(capturePath, 'utf8'))
  assert.equal(result.testResults.length, 1, 'Exactly the owning ReactDOM suite must run')
  assert.equal(resolve(result.testResults[0].name), join(root, suite), 'The intended consumer file must run')
  const assertions = result.testResults.flatMap(item => item.assertionResults)
  assert.ok(assertions.length > 0, 'An empty assertion collection cannot qualify')
  assert.equal(assertions.length, result.numTotalTests)
  assert.equal(result.numRuntimeErrorTestSuites ?? 0, 0, log)
  assert.doesNotMatch(log, /Unhandled Errors|Unhandled Rejection|Uncaught Exception/u)
  assert.ok(assertions.every(item => item.status === 'passed' || item.status === 'failed'), 'Skipped consumer checks cannot qualify')
  for (const file of tracked) {
    assert.ok(capture.loaded[file] && capture.compiled[file], 'The actual owner and consumer must load and compile: ' + file)
    assert.equal(capture.loaded[file].originalSha256, sha(sources[file]))
    assert.equal(capture.loaded[file].loadedSha256, sha(mutant && file === mutant.file ? mutant.source : sources[file]))
  }
  if (mutant) {
    assert.equal(result.numTotalTests, baselineCount, 'The complete owning collection must survive mutation')
    assert.equal(exitCode, 1, 'An actual source mutation must reach its declared business assertion')
    assert.ok(capture.consumed > 0, 'The mutated source must actually load')
    assert.notEqual(capture.loaded[mutant?.file ?? editor].loadedSha256, capture.loaded[mutant?.file ?? editor].originalSha256)
    const failed = assertions.find(item => item.fullName === mutant.test)
    assert.equal(failed?.status, 'failed', 'The designated consumer check must turn red: ' + mutant.id)
    assert.ok(failed.failureMessages.some(message => message.includes('AssertionError') && message.includes(mutant.failure)),
      'Only the designated business AssertionError qualifies; setup or cleanup failures do not: ' + mutant.id)
  } else {
    assert.equal(exitCode, 0, log); assert.equal(result.numFailedTests, 0); assert.equal(result.numPassedTests, assertions.length)
    baselineCount = assertions.length
    assert.equal(capture.consumed, 0)
  }
  const receipt = { id, exitCode, assertions: assertions.length, passed: result.numPassedTests, failed: result.numFailedTests,
    consumed: capture.consumed, originalSha256: capture.loaded[mutant?.file ?? editor].originalSha256, loadedSha256: capture.loaded[mutant?.file ?? editor].loadedSha256,
    ...(mutant ? { designatedAssertion: mutant.test, designatedFailure: mutant.failure } : {}) }
  runs.push(receipt); process.stdout.write(JSON.stringify(receipt) + '\n')
}
try {
  await run()
  for (const mutant of mutants) await run(mutant)
  await run()
  const sourceIdentity = Object.fromEntries(Object.entries(sources).map(([file, text]) => [file, sha(text)]))
  for (const [file, hash] of Object.entries(sourceIdentity)) assert.equal(sha(await readFile(join(root, file))), hash, 'Input changed during verification: ' + file)
  await writeFile(join(output, 'receipt.json'), JSON.stringify({ schema: 'agentmux.capsule-question-editors-proof.v1', passed: true, sourceIdentity, runs,
    boundary: 'Actual NodeCapsuleOwner/public RPC feed production Chrome and Reply via DesktopClientUiProvider, original AppStore and Workbench writer/rehydration. Source mutants reach designated business assertions without editing repository files. Native input, Electron visuals and business delivery remain T001/original Core owner evidence.' }, null, 2) + '\n')
} catch (error) {
  await writeFile(join(output, 'receipt.json'), JSON.stringify({ schema: 'agentmux.capsule-question-editors-proof.v1', passed: false, runs, failure: { name: error.name, message: error.message, stack: error.stack } }, null, 2) + '\n')
  throw error
} finally { await rm(join(output, 'cache'), { recursive: true, force: true }) }
