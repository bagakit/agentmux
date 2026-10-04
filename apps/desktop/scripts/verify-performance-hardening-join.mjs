import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'

// Reuse the exact owner oracles; this join does not start a Runtime or run an installation matrix.
const root = resolve(import.meta.dirname, '../../..')
const directory = join(root, '.local/state/performance-hardening-join')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const read = path => JSON.parse(readFileSync(path, 'utf8'))
const inputs = read(join(directory, 'inputs.json'))
assert.equal(inputs.schema, 'agentmux.performance-hardening-join.v1')
assert.deepEqual(inputs.slices.map(value => value.task), ['T-009','T-010','T-011','T-012','T-013','T-014','T-015'])
const checked = {}, evidence = []
function bind(path, expected) {
  assert.equal(sha(readFileSync(join(root,path))), expected, 'candidate source drift: '+path)
  if (checked[path]) assert.equal(checked[path], expected, 'conflicting source evidence')
  checked[path] = expected
}
for (const slice of inputs.slices) {
  const bytes = readFileSync(slice.path), receipt = JSON.parse(bytes)
  assert.equal(sha(bytes), slice.sha256, 'receipt drift: '+slice.task)
  if (receipt.source) {
    assert.equal(receipt.baseline.exit, 0)
    assert.ok(receipt.baseline.tests > 0)
    assert.ok(receipt.mutants.length > 0 && receipt.mutants.every(value=>value.killed && value.exit !== 0))
    receipt.source.forEach(value=>bind(value.path,value.sha256))
  } else {
    assert.equal(receipt.passed, true)
    Object.entries(receipt.sourceSHA256).forEach(([path,hash])=>bind(path,hash))
    Object.entries(receipt.testSHA256).forEach(([path,hash])=>bind(path,hash))
    const runs = receipt.variants ?? receipt.runs
    assert.ok(runs.length > 1)
    assert.ok(runs[0].assertions > 0 || runs[0].tests > 0)
    assert.ok(runs.slice(1).every(value=>Array.isArray(value.failed) ? value.failed.length > 0 : value.failed > 0))
  }
  assert.ok(receipt.callers.length > 0, 'production call-chain receipt missing')
  evidence.push({task:slice.task,sha256:slice.sha256})
}
const benchmark = read(inputs.benchmark.path)
assert.equal(sha(readFileSync(inputs.benchmark.path)),inputs.benchmark.sha256)
assert.equal(benchmark.passed,true)
bind('packages/core/src/hosted-value.ts',benchmark.candidateSHA256)
for (const review of inputs.reviews) {
  const bytes=readFileSync(review.path),value=JSON.parse(bytes)
  assert.equal(sha(bytes),review.sha256)
  assert.equal(value.status,'approved')
  Object.entries(value.files).forEach(([path,hash])=>bind(path,hash))
}
assert.ok(inputs.reviews.length >= 3, 'independent owner and join reviews missing')
const inventory=read(inputs.inventory.path)
assert.equal(sha(readFileSync(inputs.inventory.path)),inputs.inventory.sha256)
assert.deepEqual(inventory.findings.map(value=>value.id),Array.from({length:16},(_,i)=>i+1))
assert.equal(inventory.unclosed.length,3)
assert.ok(inventory.findings.every(value=>value.task&&value.handling&&value.status))
assert.deepEqual(inputs.pendingOriginalTasks,['T-002','T-004','T-005'])
assert.equal(inputs.types.passed,true)
Object.entries(inputs.types.files).forEach(([path,hash])=>bind(path,hash))
// A source join may be preflighted before publication; only the integrated mode certifies Main bytes.
const at=process.argv.indexOf('--integrated-main'),commit=at<0 ? inputs.integratedMain ?? null : process.argv[at+1]
if (!process.argv.includes('--source-only')) assert.ok(commit, 'Main integration receipt is required for Task closeout')
if (commit) {
  execFileSync('git',['merge-base','--is-ancestor',commit,'main'],{cwd:root})
  for (const [path,hash] of Object.entries(checked)) {
    assert.equal(sha(execFileSync('git',['show',commit+':'+path],{cwd:root})),hash,'Main did not retain '+path)
  }
}
mkdirSync(directory,{recursive:true})
const receipt={passed:true,integratedMain:commit,sourceFiles:checked,evidence,publicConsumption:'Actual private Unix metrics get/watch and compiled CLI in T-014, not help or a copied DTO alone',
  limitations:inventory.unclosed,userRunTouched:false,inputsSHA256:sha(readFileSync(join(directory,'inputs.json')))}
const output=join(directory,commit ? 'integrated-receipt.json' : 'source-receipt.json')
writeFileSync(output,JSON.stringify(receipt,null,2)+'\n')
process.stdout.write(JSON.stringify({passed:true,integratedMain:commit,files:Object.keys(checked).length,receipt:output})+'\n')
