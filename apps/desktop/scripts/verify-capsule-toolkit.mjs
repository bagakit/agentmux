import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const args = process.argv.slice(2), outputIndex = args.indexOf('--output')
const output = resolve(root, outputIndex < 0 ? '.tmp/capsule-toolkit-proof' : args[outputIndex + 1])
await mkdir(output, { recursive: true })
const row = 'apps/desktop/src/renderer/src/components/toolkit/ToolkitCapsuleResults.tsx'
const document = 'packages/core/src/toolkit-result-document.ts'
const consumer = 'apps/desktop/src/renderer/src/components/toolkit/UserToolkitResult.tsx'
const sha = value => createHash('sha256').update(value).digest('hex')
const sources = Object.fromEntries(await Promise.all([row, document, consumer,
  'apps/desktop/src/renderer/src/styles/toolkit-custom.css', 'packages/core/guides/modules/toolkit.md',
  'apps/desktop/test/capsule-toolkit.test.tsx', 'apps/desktop/test/capsule-toolkit.config.mts']
  .map(async file => [file, await readFile(join(root, file), 'utf8')])))
const mutants = [
  { id: 'strict-object-id', file: document, before: 'if (!isObjectId(page.capsuleId) || seen.has(page.capsuleId)) invalid()', after: 'if (seen.has(page.capsuleId)) invalid()', test: 'accepts only explicit bounded Capsule object references in the original public document' },
  { id: 'exact-page-open', file: row, before: "api.capsules.call('capsule.open', { capsuleId: page.capsuleId, operationId: attempt.operationId })", after: "api.capsules.call('capsule.open', { capsuleId: '23456789ABCD', operationId: attempt.operationId })", test: 'copies and opens the exact Capsule without rerunning its tool or borrowing declared provenance' },
  { id: 'exact-page-copy', file: row, before: "formatAmuxObjectLink({ kind: 'capsule', capsuleId: page.capsuleId })", after: "formatAmuxObjectLink({ kind: 'capsule', capsuleId: '23456789ABCD' })", test: 'copies and opens the exact Capsule without rerunning its tool or borrowing declared provenance' },
  { id: 'retained-source', file: consumer, before: 'source={execution && snapshot ? { toolId: snapshot.toolId, execution } : null}', after: 'source={execution && snapshot ? { toolId: snapshot.toolId, execution: snapshot.latestConfirmed! } : null}', test: 'keeps a retained display Capsule attached to its own original execution and configuration' },
  { id: 'unknown-replay', file: row, before: "api.capsules.call('capsule.operation.inspect', { operationId: original.operationId })", after: "api.capsules.call('capsule.open', { capsuleId: original.capsuleId, operationId: original.operationId })", test: 'checks a lost original open receipt and preserves that page through a newer tool result' },
  { id: 'result-consumer', file: consumer, before: '        <ToolkitCapsuleResults references={document?.capsules ?? []} source={execution && snapshot ? { toolId: snapshot.toolId, execution } : null} />\n', after: '', test: 'copies and opens the exact Capsule without rerunning its tool or borrowing declared provenance' }
].map(mutant => {
  assert.equal(sources[mutant.file].split(mutant.before).length - 1, 1, 'Exactly one production source anchor: ' + mutant.id)
  return { ...mutant, source: sources[mutant.file].replace(mutant.before, mutant.after) }
})
await writeFile(join(output, 'plan.json'), JSON.stringify({ root, mutants }, null, 2))
const config = join(output, 'verify.config.mts')
await writeFile(config, `import base from ${JSON.stringify(join(root, 'apps/desktop/test/capsule-toolkit.config.mts'))}
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
const plan=JSON.parse(readFileSync(${JSON.stringify(join(output, 'plan.json'))},'utf8'))
const mutant=plan.mutants.find(item=>item.id===process.env.CAPSULE_TOOLKIT_MUTANT)
const capture={consumed:0,loaded:{},compiled:{}}
const sha=value=>createHash('sha256').update(value).digest('hex')
const publish=()=>writeFileSync(process.env.CAPSULE_TOOLKIT_CAPTURE!,JSON.stringify(capture))
export default {...base,cacheDir:${JSON.stringify(join(output, 'cache'))},plugins:[...base.plugins,
{name:'capsule-toolkit-owner-source',enforce:'pre',transform(input,id){
 const file=relative(plan.root,id.split('?')[0]);if(!plan.mutants.some(item=>item.file===file))return
 const original=readFileSync(id,'utf8'),text=mutant?.file===file?mutant.source:input
 capture.loaded[file]={original:sha(original),loaded:sha(text)};if(mutant?.file===file)capture.consumed++;publish()
 return{code:text,map:null}
}},{name:'capsule-toolkit-compiled-owner',enforce:'post',transform(code,id){
 const file=relative(plan.root,id.split('?')[0]);if(!plan.mutants.some(item=>item.file===file))return
 capture.compiled[file]=sha(code);publish()
}}]}
`)
const callers = []
for (const [symbol, definition] of [['ToolkitCapsuleResults', row], ['parseToolkitResultDocument', document]]) {
  const found = execFileSync('rg', ['-n', '-w', symbol, 'apps/desktop/src', 'packages/core/src', '-g', '*.ts', '-g', '*.tsx'], { cwd: root, encoding: 'utf8' })
    .trim().split('\n').filter(line => !line.startsWith(definition + ':'))
  assert.ok(found.length, 'Nonempty definition-excluded production consumers: ' + symbol)
  callers.push({ symbol, definition, consumers: found })
}
await writeFile(join(output, 'callers.json'), JSON.stringify(callers, null, 2))
const runs = []
let baselineCount
async function run(mutant) {
  const id = mutant?.id ?? 'control', report = join(output, id + '.tests.json'), captured = join(output, id + '.capture.json'), chunks = []
  const exitCode = await new Promise((yes, no) => {
    const child = spawn(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, '--maxWorkers=1', '--reporter=json', '--outputFile.json=' + report],
      { cwd: root, env: { ...process.env, CAPSULE_TOOLKIT_MUTANT: mutant?.id ?? '', CAPSULE_TOOLKIT_CAPTURE: captured }, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', chunk => chunks.push(chunk)); child.stderr.on('data', chunk => chunks.push(chunk)); child.on('error', no); child.on('close', yes)
  })
  const log = Buffer.concat(chunks).toString(); await writeFile(join(output, id + '.log'), log)
  const result = JSON.parse(await readFile(report, 'utf8')), capture = JSON.parse(await readFile(captured, 'utf8'))
  assert.equal(result.testResults.length, 1, 'Exactly the owning consumer suite must run')
  const assertions = result.testResults.flatMap(suite => suite.assertionResults)
  assert.ok(assertions.length > 0, 'Nonempty actual test collection'); assert.equal(assertions.length, result.numTotalTests)
  assert.doesNotMatch(log, /Unhandled Errors|Unhandled Rejection|Uncaught Exception/u)
  if (!mutant) {
    assert.equal(exitCode, 0, log); assert.equal(result.numFailedTests, 0); assert.equal(result.numPassedTests, result.numTotalTests); baselineCount = result.numTotalTests
  } else {
    assert.equal(result.numTotalTests, baselineCount, 'Mutants retain the complete test collection')
    assert.equal(exitCode, 1, 'Actual mutation must reach a business assertion')
    assert.ok(capture.consumed > 0 && capture.compiled[mutant.file], 'Actual owning source was loaded and compiled')
    assert.equal(capture.loaded[mutant.file].loaded, sha(mutant.source)); assert.notEqual(capture.loaded[mutant.file].loaded, capture.loaded[mutant.file].original)
    const failed = assertions.find(test => test.fullName === mutant.test)
    assert.equal(failed?.status, 'failed', 'Declared business assertion turns red: ' + mutant.id)
    assert.ok(failed.failureMessages.some(message => /AssertionError|expected .* to /su.test(message)), 'Setup/runtime failures cannot qualify')
  }
  const receipt = { id, exitCode, passed: result.numPassedTests, failed: result.numFailedTests, consumed: capture.consumed }
  runs.push(receipt); process.stdout.write(JSON.stringify(receipt) + '\n')
}
await run()
if (args.includes('--mutations')) for (const mutant of mutants) await run(mutant)
const sourceIdentity = Object.fromEntries(Object.entries(sources).map(([file, text]) => [file, sha(text)]))
for (const [file, hash] of Object.entries(sourceIdentity)) assert.equal(sha(await readFile(join(root, file))), hash, 'Owning source changed during verification: ' + file)
await writeFile(join(output, 'receipt.json'), JSON.stringify({ schema: 'agentmux.capsule-toolkit-proof.v1', sourceIdentity, runs, callers,
  scope: 'Provisional authenticated Node producer, public RPC, durable Toolkit receipt and original result UI; native Browser/visual joins remain required.' }, null, 2))
process.stdout.write(JSON.stringify({ completed: true, output, tests: baselineCount, mutations: runs.length - 1, native: 'not-run', visual: 'pending' }) + '\n')
