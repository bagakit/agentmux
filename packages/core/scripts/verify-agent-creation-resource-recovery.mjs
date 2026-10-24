import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const output = resolve(root, process.argv[2] ?? '.tmp/disk-start-recovery/core-mutations')
await mkdir(output, { recursive: true })
const helper = 'packages/core/src/agent-creation-resource-retry.ts'
const client = 'packages/core/src/client.ts'
const helperConfig = 'packages/core/test/agent-creation-resource-retry.config.mts'
const nativeConfig = 'packages/core/test/durable-local-creation.config.mts'
const mutations = [
  { id: 'foreign-operation', source: helper, config: helperConfig,
    from: 'error.creationFailure?.operationId !== input.operationId ||', to: '!error.creationFailure ||', test: 'never retries foreign operation' },
  { id: 'unknown-effect', source: helper, config: helperConfig,
    from: "error.creationFailure.disposition !== 'not_applied'", to: 'false', test: 'never retries unknown effect' },
  { id: 'display-authorizes-retry', source: helper, config: helperConfig,
    from: '!capacityFailure(error)) throw error', to: 'false) throw error', test: 'never retries display text only' },
  { id: 'drop-single-flight', source: client, config: nativeConfig,
    from: 'return await active.pending', to: 'return await this.createAgentWithDeliveryAttempt(frozen, authority)',
    test: 'automatically continues the frozen original creation after preparation storage recovers' },
  { id: 'drop-frozen-input', source: client, config: nativeConfig,
    from: 'const frozen = structuredClone(input)\n    frozen.createOperationId', to: 'const frozen = input\n    frozen.createOperationId',
    test: 'freezes caller input through storage waiting' },
  { id: 'drop-prestart-receipt', source: client, config: nativeConfig,
    from: '!startAttempted ? agentCreationNotAppliedError(error, lifecycleOperationId) : error', to: 'error',
    test: 'preserves exact pre-Start failure facts at managed-hooks' },
  { id: 'drop-start-cancellation', source: client, config: nativeConfig,
    from: 'signal?.throwIfAborted()\n      preservePreparedCreation = true', to: 'void signal\n      preservePreparedCreation = true',
    test: 'fences Start when disconnect cancels an already preparing retry even after reconnect' }
]
const sha = text => createHash('sha256').update(text).digest('hex')
const receipts = []
for (const mutation of mutations) {
  const source = await readFile(resolve(root, mutation.source), 'utf8')
  assert.equal(source.split(mutation.from).length, 2, mutation.id + ': unique production anchor')
  const configPath = resolve(output, mutation.id + '.config.mts')
  const reportPath = resolve(output, mutation.id + '.json')
  const witnessPath = resolve(output, mutation.id + '.loaded.json')
  await writeFile(configPath, `import base from ${JSON.stringify(resolve(root, mutation.config))};
import {writeFileSync} from 'node:fs';
export default {...base,root:${JSON.stringify(root)},plugins:[{name:'creation-resource-mutation',enforce:'pre',transform(code,id){
if(id.split('?')[0]!==${JSON.stringify(resolve(root, mutation.source))})return;
if(code.split(${JSON.stringify(mutation.from)}).length!==2)throw new Error('Missing mutation anchor');
writeFileSync(${JSON.stringify(witnessPath)},JSON.stringify({loaded:true}));
return {code:code.replace(${JSON.stringify(mutation.from)},${JSON.stringify(mutation.to)}),map:null};
}}],test:{...base.test,testNamePattern:${JSON.stringify(mutation.test)},passWithNoTests:false,maxWorkers:1}};
`)
  const result = await new Promise((done, fail) => {
    const child = spawn(process.execPath, [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', configPath,
      '--reporter=json', '--outputFile', reportPath], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    let text = ''
    child.stdout.on('data', bytes => { text += bytes }); child.stderr.on('data', bytes => { text += bytes })
    child.once('error', fail); child.once('close', (code, signal) => done({ code, signal, text }))
  })
  await writeFile(resolve(output, mutation.id + '.log'), result.text)
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  const assertions = report.testResults.flatMap(item => item.assertionResults)
  assert.equal(JSON.parse(await readFile(witnessPath, 'utf8')).loaded, true)
  assert.equal(result.code, 1, mutation.id + ': mutation survived')
  assert.equal(result.signal, null)
  assert.equal(report.numRuntimeErrorTestSuites ?? 0, 0, mutation.id + ': infrastructure is not semantic RED')
  const failed = assertions.filter(item => item.status === 'failed' && item.fullName.includes(mutation.test))
  assert.ok(failed.some(item => item.failureMessages.some(message => /AssertionError|promise resolved|promise rejected/.test(message))),
    mutation.id + ': designated business assertion must fail')
  assert.equal(sha(await readFile(resolve(root, mutation.source))), sha(source), 'Candidate changed during proof')
  receipts.push({ id: mutation.id, source: mutation.source, sourceSha256: sha(source), mutatedSha256: sha(source.replace(mutation.from, mutation.to)),
    test: mutation.test, failed: failed.map(item => item.fullName), report: reportPath })
  process.stdout.write(mutation.id + ': semantic RED\n')
}
await writeFile(resolve(output, 'receipt.json'), JSON.stringify({ passed: true, mutations: receipts }, null, 2) + '\n')
