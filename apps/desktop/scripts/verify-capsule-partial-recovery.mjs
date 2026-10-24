import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const args = process.argv.slice(2), outputAt = args.indexOf('--output')
if (outputAt >= 0) assert.ok(args[outputAt + 1], '--output needs a directory')
const output = resolve(root, outputAt < 0 ? '.tmp/capsule-partial-recovery-proof' : args[outputAt + 1])
await mkdir(output, { recursive: true })
const chrome = 'apps/desktop/src/renderer/src/components/CapsuleInteractionChrome.tsx'
const reply = 'apps/desktop/src/renderer/src/components/CapsuleQuestionReply.tsx'
const owner = 'packages/capsule/src/node.ts'
const suite = 'apps/desktop/test/capsule-partial-recovery.test.tsx'
const base = 'apps/desktop/test/capsule-partial-recovery.config.mts'
const tracked = [chrome, reply, owner]
const inputs = [...tracked, suite, base, 'apps/desktop/scripts/verify-capsule-partial-recovery.mjs']
const sources = Object.fromEntries(await Promise.all(inputs.map(async file => [file, await readFile(join(root, file), 'utf8')])))
const sha = value => createHash('sha256').update(value).digest('hex')
const merge = `setQuestions(current => {
        const known = new Map(current?.filter(question => question.capsuleId === capsuleId).map(question => [question.interactionId, question]))
        for (const question of result.interactions) {
          const previous = known.get(question.interactionId)
          if (!previous || question.revision >= previous.revision) known.set(question.interactionId, question)
        }
        return [...known.values()]
      })`
const mutants = [
  { id: 'destructive-list-replacement', from: merge, to: 'setQuestions(result.interactions)',
    test: 'keeps the original mounted form and unsaved answer through a real partial owner read while healthy questions update',
    failure: 'Partial interaction reads must preserve the original mounted reply form' },
  { id: 'lower-revision-replaces-confirmed', from: '!previous || question.revision >= previous.revision', to: 'true',
    test: 'keeps a higher confirmed revision when a later complete list contains an older snapshot',
    failure: 'A lower list revision must not replace the confirmed projection' },
  { id: 'unrelated-capsule-forms-retained', from: '.filter(question => question.capsuleId === capsuleId)', to: '',
    test: 'limits retained interaction identities to the exact Capsule after a prop change',
    failure: 'A different Capsule must not inherit the original Capsule form or recipient' }
].map(mutant => {
  assert.equal(sources[chrome].split(mutant.from).length - 1, 1, 'Exactly one actual owning source anchor: ' + mutant.id)
  return { ...mutant, source: sources[chrome].replace(mutant.from, mutant.to) }
})
const plan = join(output, 'plan.json'), config = join(output, 'verify.config.mts')
await writeFile(plan, JSON.stringify({ chrome, tracked, suite, mutants }, null, 2) + '\n')
let baseImport = relative(output, join(root, base))
if (!baseImport.startsWith('.')) baseImport = './' + baseImport
await writeFile(config, `import base from ${JSON.stringify(baseImport)}
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
const plan=JSON.parse(readFileSync(process.env.CAPSULE_PARTIAL_PLAN!,'utf8'))
const mutant=plan.mutants.find(item=>item.id===process.env.CAPSULE_PARTIAL_MUTANT)
const capture={consumed:0,loaded:{},compiled:{}}
const sha=value=>createHash('sha256').update(value).digest('hex')
const publish=()=>writeFileSync(process.env.CAPSULE_PARTIAL_CAPTURE!,JSON.stringify(capture))
export default {...base,cacheDir:process.env.CAPSULE_PARTIAL_CACHE,plugins:[...base.plugins,
{name:'capsule-partial-owner-source',enforce:'pre',transform(input,id){
 const file=relative(base.root,id.split('?')[0]);if(!plan.tracked.includes(file))return
 const original=readFileSync(id.split('?')[0],'utf8'),text=mutant&&file===plan.chrome?mutant.source:input
 capture.loaded[file]={originalSha256:sha(original),loadedSha256:sha(text)}
 if(mutant&&file===plan.chrome)capture.consumed++;publish();return{code:text,map:null}
}},{name:'capsule-partial-compiled-source',enforce:'post',transform(code,id){
 const file=relative(base.root,id.split('?')[0]);if(!plan.tracked.includes(file))return
 capture.compiled[file]=sha(code);publish()
}}],test:{...base.test,include:[plan.suite],maxWorkers:1,passWithNoTests:false}}
`)
const runs = []
let baselineCount
async function run(mutant) {
  const id = mutant?.id ?? 'baseline', report = join(output, id + '.tests.json'), capturePath = join(output, id + '.capture.json')
  await Promise.all([rm(report, { force: true }), rm(capturePath, { force: true })])
  const chunks = []
  const exitCode = await new Promise((yes, no) => {
    const child = spawn(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config,
      '--reporter=json', '--outputFile', report], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
      CAPSULE_PARTIAL_PLAN: plan, CAPSULE_PARTIAL_CAPTURE: capturePath, CAPSULE_PARTIAL_MUTANT: mutant?.id ?? '',
      CAPSULE_PARTIAL_CACHE: join(output, 'cache') } })
    child.stdout.on('data', chunk => chunks.push(chunk)); child.stderr.on('data', chunk => chunks.push(chunk))
    child.once('error', no); child.once('close', yes)
  })
  const log = Buffer.concat(chunks).toString(); await writeFile(join(output, id + '.log'), log)
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
    assert.equal(capture.loaded[file].loadedSha256, sha(mutant && file === chrome ? mutant.source : sources[file]))
  }
  if (mutant) {
    assert.equal(result.numTotalTests, baselineCount, 'The complete owning collection must survive mutation')
    assert.equal(exitCode, 1, 'An actual source mutation must reach its declared business assertion')
    assert.ok(capture.consumed > 0, 'The mutated source must actually load')
    assert.notEqual(capture.loaded[chrome].loadedSha256, capture.loaded[chrome].originalSha256)
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
    consumed: capture.consumed, originalSha256: capture.loaded[chrome].originalSha256, loadedSha256: capture.loaded[chrome].loadedSha256,
    ...(mutant ? { designatedAssertion: mutant.test, designatedFailure: mutant.failure } : {}) }
  runs.push(receipt); process.stdout.write(JSON.stringify(receipt) + '\n')
}
try {
  await run()
  if (args.includes('--mutations')) for (const mutant of mutants) await run(mutant)
  const sourceIdentity = Object.fromEntries(Object.entries(sources).map(([file, text]) => [file, sha(text)]))
  for (const [file, hash] of Object.entries(sourceIdentity)) assert.equal(sha(await readFile(join(root, file))), hash, 'Input changed during verification: ' + file)
  await writeFile(join(output, 'receipt.json'), JSON.stringify({ schema: 'agentmux.capsule-partial-recovery-proof.v1', passed: true, sourceIdentity, runs,
    boundary: 'Actual Node owner partial results and public RPC feed the mounted production ReactDOM Chrome and reply forms. Controlled confirmation failure; no Native input, Electron, visual approval, service restart or incident recovery is claimed.' }, null, 2) + '\n')
} finally { await rm(join(output, 'cache'), { recursive: true, force: true }) }
