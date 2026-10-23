import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const args = process.argv.slice(2), outputIndex = args.indexOf('--output')
const output = resolve(root, outputIndex < 0 ? '.tmp/capsule-main-proof' : args[outputIndex + 1])
await mkdir(output, { recursive: true })
const reply = 'apps/desktop/src/main/capsule-reply-authority.ts', document = 'apps/desktop/src/main/capsule-document-ipc.ts'
const host = 'apps/host/src/capsules.ts', ipc = 'apps/desktop/src/main/ipc.ts'
const sha = value => createHash('sha256').update(value).digest('hex')
const sources = Object.fromEntries(await Promise.all([reply, document, host, ipc, 'apps/desktop/src/main/capsule-presentation.ts',
  'packages/core/src/capsule-input.ts', 'packages/core/src/public-rpc-service.ts', 'packages/capsule/src/node.ts',
  'packages/capsule/src/types.ts', 'packages/capsule/src/parsers.ts', 'packages/capsule/src/storage.ts', 'packages/capsule/src/runtime.ts',
  'packages/capsule/src/runtime-client.ts', 'packages/capsule/src/runtime-server.ts', 'packages/capsule/src/runtime-wire.ts',
  'apps/desktop/src/main/runtime-controller.ts', 'apps/desktop/test/capsule-main.test.ts',
  'apps/desktop/test/capsule-main.config.mts', 'apps/desktop/test/capsule-settings.config.mts',
  'apps/desktop/scripts/verify-capsule-main.mjs', 'packages/core/dist/control-endpoint-listener-worker.js']
  .map(async file => [file, await readFile(join(root, file), 'utf8')])))
const reservation = `if (this.confirmations.get(request.operationId) !== confirmation || confirmation.dispatched || !operation ||
        operation.operationId !== request.operationId || operation.capsuleId !== request.interaction.capsuleId ||
        operation.method !== 'capsule.interaction.reply' || operation.status !== 'pending' || operation.inputOperationId !== request.inputOperationId)`
const dispatch = `if (this.confirmations.get(prepared.operationId) !== confirmation || interaction.status !== 'answered' ||
      interaction.answer !== confirmation.params.answer || interaction.question !== confirmation.original.question ||
      !isDeepStrictEqual(interaction.target, prepared.target) || interaction.reply?.operationId !== prepared.operationId ||
      interaction.reply.phase !== 'dispatch-started' || interaction.reply.delivery.inputOperationId !== prepared.inputOperationId ||
      !isDeepStrictEqual(interaction.reply.delivery.expectedRun, prepared.expectedRun))`
const mutants = [
  { id: 'app-main-frame', file: ipc, before: "if (event.senderFrame !== contents.mainFrame) throw new Error('The original App main frame must confirm this answer.')", after: "if (false) throw new Error('The original App main frame must confirm this answer.')", test: 'does not turn a page sender, App subframe, local RPC user or forged envelope into Human confirmation' },
  { id: 'owner-input-reservation', file: reply, before: reservation, after: 'if (false)', test: 'rejects an unprepared input and mismatched original question during a live exact confirmation' },
  { id: 'durable-dispatch-boundary', file: reply, before: dispatch, after: 'if (false)', test: 'rejects the real prepared input before the Domain answer and dispatch boundary are durably saved' },
  { id: 'retained-run', file: reply, before: 'if (retainedInput && current.run.runId !== retainedInput.expectedRun.runId)', after: 'if (false)', test: 'does not retarget a retained prepared answer when the real Session registry has advanced to another Run' },
  { id: 'preflight-not-applied', file: reply, before: "{ disposition: 'not_applied', confirmedInputBytes: 0 }", after: "{ disposition: 'unknown', confirmedInputBytes: 0 }", test: 'reports failed confirmation prerequisites as not applied and keeps the original request writable' },
  { id: 'loaded-service-instance', file: document, before: '      endpoint.instanceId !== current.instanceId || binding.instanceId !== current.instanceId ||\n', after: '', test: 'revokes an old native document after the original Capsule service restarts on the same origin' },
  { id: 'graph-is-not-visibility', file: host, before: '        if (!capsuleCurrentlyVisible(observation, matches[0]!, current.endpoint.url)) return null\n', after: '', test: 'keeps a recorded Browser association unknown until the same native document is authoritatively visible, without focus replay' },
  { id: 'callback-original-credentials', file: host, before: 'try { client = await desktop.connect(originalContext) }', after: 'try { client = await desktop.connect() }', test: 'keeps each original Agent credential on its own Desktop callback across another Capsule call' },
  { id: 'unknown-inspection', file: host, before: "client.call('capsule.input', { phase, prepared },", after: "client.call('capsule.input', { phase: 'submit', prepared },", test: 'does not resubmit an unknown original reply after actual Core firstsave or on repeated confirmation' }
].map(mutant => {
  assert.equal(sources[mutant.file].split(mutant.before).length - 1, 1, 'Exactly one production source anchor: ' + mutant.id)
  return { ...mutant, source: sources[mutant.file].replace(mutant.before, mutant.after) }
})
await writeFile(join(output, 'plan.json'), JSON.stringify({ root, mutants, inputs: Object.keys(sources) }, null, 2))
const config = join(output, 'verify.config.mts')
await writeFile(config, `import base from ${JSON.stringify(join(root, 'apps/desktop/test/capsule-main.config.mts'))}
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
const plan=JSON.parse(readFileSync(${JSON.stringify(join(output, 'plan.json'))},'utf8'))
const mutant=plan.mutants.find(item=>item.id===process.env.CAPSULE_MAIN_MUTANT)
const capture={consumed:0,loaded:{},compiled:{}}
const sha=value=>createHash('sha256').update(value).digest('hex')
const publish=()=>writeFileSync(process.env.CAPSULE_MAIN_CAPTURE!,JSON.stringify(capture))
export default {...base,cacheDir:${JSON.stringify(join(output, 'cache'))},plugins:[...base.plugins,
{name:'capsule-main-owner-source',enforce:'pre',transform(input,id){
 const file=relative(plan.root,id.split('?')[0]);if(!plan.inputs.includes(file))return
 const original=readFileSync(id,'utf8'),text=mutant?.file===file?mutant.source:input
 capture.loaded[file]={original:sha(original),loaded:sha(text)};if(mutant?.file===file)capture.consumed++;publish()
 return{code:text,map:null}
}},{name:'capsule-main-compiled-owner',enforce:'post',transform(code,id){
 const file=relative(plan.root,id.split('?')[0]);if(!plan.inputs.includes(file))return
 capture.compiled[file]=sha(code);publish()
}}]}
`)
const callers = []
for (const [symbol, definition] of [['CapsuleReplyAuthority', reply], ['capsuleDocumentIpc', document], ['createCapsuleDesktopAdapters', host],
  ['capsulePresentation', 'apps/desktop/src/main/capsule-presentation.ts']]) {
  const found = execFileSync('rg', ['-n', '-w', symbol, 'apps/desktop/src', 'apps/host/src', '-g', '*.ts'], { cwd: root, encoding: 'utf8' })
    .trim().split('\n').filter(line => !line.startsWith(definition + ':'))
  assert.ok(found.length, 'Nonempty definition-excluded production consumers: ' + symbol); callers.push({ symbol, definition, consumers: found })
}
await writeFile(join(output, 'callers.json'), JSON.stringify(callers, null, 2))
const runs = []
let baselineCount
async function run(mutant) {
  const id = mutant?.id ?? 'control', report = join(output, id + '.tests.json'), captured = join(output, id + '.capture.json'), chunks = []
  const exitCode = await new Promise((yes, no) => {
    const child = spawn(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, '--maxWorkers=1', '--reporter=json', '--outputFile.json=' + report],
      { cwd: root, env: { ...process.env, CAPSULE_MAIN_MUTANT: mutant?.id ?? '', CAPSULE_MAIN_CAPTURE: captured }, stdio: ['ignore', 'pipe', 'pipe'] })
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
    assert.ok(failed.failureMessages.some(message => /AssertionError|expected .* to |promise resolved .* instead of rejecting|promise rejected .* instead of resolving/su.test(message)), 'Setup/runtime failures cannot qualify')
  }
  const receipt = { id, exitCode, passed: result.numPassedTests, failed: result.numFailedTests, consumed: capture.consumed }
  runs.push(receipt); process.stdout.write(JSON.stringify(receipt) + '\n')
}
await run()
const atMutation = args.indexOf('--mutation'), selected = mutants.filter(item => atMutation < 0 || item.id === args[atMutation + 1])
if (atMutation >= 0) assert.equal(selected.length, 1, 'Exactly one named mutation must exist')
if (args.includes('--mutations') || atMutation >= 0) for (const mutant of selected) await run(mutant)
const sourceIdentity = Object.fromEntries(Object.entries(sources).map(([file, text]) => [file, sha(text)]))
for (const [file, hash] of Object.entries(sourceIdentity)) assert.equal(sha(await readFile(join(root, file))), hash, 'Owning source changed during verification: ' + file)
await writeFile(join(output, 'receipt.json'), JSON.stringify({ schema: 'agentmux.capsule-main-proof.v1', sourceIdentity, runs, callers,
  scope: 'Actual Main registration, per-call Host adapters, independent Capsule runtime server/client over a private Unix socket, and real Core journal/ordered byte receipts. Native Browser and Run substrate are controlled; the runtime server shares this test process, so no actual service Run, Core-exit survival, Provider adoption or native pixel claim is made.' }, null, 2))
process.stdout.write(JSON.stringify({ completed: true, output, tests: baselineCount, mutations: runs.length - 1, native: 'not-run' }) + '\n')
