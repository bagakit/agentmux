import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'

const root = resolve(import.meta.dirname, '../../..'), out = join(root, '.local/window-return/receipts')
mkdirSync(out, { recursive: true })
const file = 'apps/desktop/src/main/workbench-windows.ts', source = readFileSync(join(root, file), 'utf8')
const sha = text => createHash('sha256').update(text).digest('hex')
const changes = {
  duplicateReturn: ["    if (outstanding) {", "    if (false && outstanding) {"],
  loseLateRejection: ["      if (response.outcome !== 'applied') {\n        record.phase", "      if (response.outcome !== 'applied') return\n      if (response.outcome !== 'applied') {\n        record.phase"],
  noReceiptDelivery: ['this.changed(operation)', 'this.changed()'],
  wrongDocument: ['this.windows.get(record.windowId) === record && record.generation === generation && record.native === originalNative', 'true']
}
const runs = []
function run(name, mutation) {
  let bytes = source
  if (mutation) {
    const [before, after] = changes[mutation]
    assert.equal(source.split(before).length, 2, mutation + ' must hit one real source site')
    bytes = source.replace(before, after)
  }
  const config = join(out, name + '.config.mjs'), report = join(out, name + '.json'), hits = join(out, name + '-loaded.jsonl')
  writeFileSync(hits, '')
  writeFileSync(config, `import base from ${JSON.stringify(join(root, 'vitest.config.ts'))};
import { appendFileSync } from 'node:fs';
export default {...base,plugins:[{name:'window-receipt-proof', enforce:'pre', transform(source,id){
if(id.split('?')[0]!==${JSON.stringify(join(root, file))})return;
appendFileSync(${JSON.stringify(hits)}, JSON.stringify({file:${JSON.stringify(file)},sha256:${JSON.stringify(sha(bytes))},mutated:${Boolean(mutation)}})+'\\n');
return {code:${JSON.stringify(bytes)},map:null};
}}], test:{...base.test,include:['apps/desktop/test/workbench-windows.test.ts'],passWithNoTests:false}};
`)
  const result = spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, '--maxWorkers=1', '-t', 'window-return-receipt', '--reporter=json', '--outputFile=' + report], { cwd: root, encoding: 'utf8' })
  writeFileSync(join(out, name + '.log'), result.stdout + result.stderr)
  const tested = JSON.parse(readFileSync(report, 'utf8'))
  assert.ok(readFileSync(hits, 'utf8').trim(), 'Actual Main owner must be loaded')
  assert.equal(tested.numTotalTests > 0, true)
  if (mutation) {
    assert.equal(result.status, 1)
    assert.ok(tested.testResults.flatMap(file => file.assertionResults).some(test => test.status === 'failed' && test.failureMessages.some(text => text.includes('AssertionError'))), 'Mutant must fail behavior, not import or configuration')
  } else { assert.equal(result.status, 0, result.stdout + result.stderr); assert.equal(tested.numPassedTests, 4) }
  runs.push({name,mutation:mutation ?? null,status:result.status,passed:tested.numPassedTests,failed:tested.numFailedTests,loaded: hits})
}
run('baseline')
for (const mutation of Object.keys(changes)) run(mutation, mutation)
run('restored')
assert.equal(readFileSync(join(root, file), 'utf8'), source, 'Shared source was never mutated')
writeFileSync(join(out,'receipt.json'),JSON.stringify({head:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),file,sourceSha256:sha(source),runs},null,2)+'\n')
console.log('Window receipts: baseline + 4 actual-source mutations + restored passed; ' + join(out,'receipt.json'))
