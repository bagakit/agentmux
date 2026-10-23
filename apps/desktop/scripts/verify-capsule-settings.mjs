import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const args = process.argv.slice(2), outputIndex = args.indexOf('--output')
const output = resolve(root, outputIndex < 0 ? '.tmp/capsule-settings-proof' : args[outputIndex + 1])
await mkdir(output, { recursive: true })
const pane = 'apps/desktop/src/renderer/src/components/settings/CapsuleSettingsPane.tsx'
const draft = 'apps/desktop/src/renderer/src/components/settings/capsule-settings-draft.ts'
const modules = 'apps/desktop/src/renderer/src/components/settings/settings-modules.ts'
const module = 'apps/desktop/src/renderer/src/components/settings/modules/capsule.tsx'
const runtime = 'apps/desktop/src/renderer/src/components/settings/CapsuleRuntimeSettings.tsx'
const ipc = 'apps/desktop/src/main/capsule-ipc.ts'
const suites = { domain: 'apps/desktop/test/capsule-settings.test.tsx', runtime: 'apps/desktop/test/capsule-settings-runtime.test.tsx' }
const tracked = [pane, draft, modules, module, runtime, ipc]
const sha = value => createHash('sha256').update(value).digest('hex')
const sources = Object.fromEntries(await Promise.all([...tracked,
  'apps/desktop/src/renderer/src/styles/settings-capsule.css', ...Object.values(suites),
  'apps/desktop/src/shared/contracts.ts', 'apps/desktop/src/preload/index.ts', 'apps/desktop/src/renderer/src/lib/api.ts',
  'packages/core/src/headless-runtime.ts', 'packages/core/src/capsule-run-manager.ts', 'packages/core/src/capsule-runtime.ts',
  'apps/desktop/test/capsule-settings.config.mts'].map(async file => [file, await readFile(join(root, file), 'utf8')])))
const mutants = [
  { id: 'cas-revision', file: pane, before: 'expectedRevision: draft.revision, changes })', after: 'expectedRevision: 1, changes })', test: 'preserves edits made while a defaults save is pending and uses its confirmed revision next' },
  { id: 'later-draft', file: draft, before: 'current.value[key] === submitted[key] ? value[key] : current.value[key]', after: 'value[key]', test: 'preserves edits made while a defaults save is pending and uses its confirmed revision next' },
  { id: 'unknown-replay', file: draft, before: "api.capsules.call('capsule.operation.inspect', { operationId: original.params.operationId })", after: 'api.capsules.call(method, original.params)', test: 'queries a lost original defaults operation without replaying it' },
  { id: 'exact-page', file: pane, before: 'capsuleId: record.capsuleId, operationId: mintObjectId(), expectedRevision: draft.revision', after: "capsuleId: '23456789ABCD', operationId: mintObjectId(), expectedRevision: draft.revision", test: 'updates only the exact selected page and keeps its draft across page selection' },
  { id: 'module-consumer', file: modules, before: '  capsuleSettingsModule,\n', after: '', test: 'registers one real resource module with static summary and discoverable fields' },
  { id: 'runtime-original-operation', suite: 'runtime', file: runtime,
    before: 'operation?.operationId === original.params.operationId && operation.kind === original.kind',
    after: 'operation && operation.kind === original.kind', test: 'starts and stops the exact independent service through App management while retaining drafts and an unknown original command', failure: 'Unrelated operation cannot confirm the original service command' },
  { id: 'runtime-stop-run', suite: 'runtime', file: runtime,
    before: 'expectedRun: value.run ? { runId: value.run.runId } : null', after: 'expectedRun: null',
    test: 'starts and stops the exact independent service through App management while retaining drafts and an unknown original command', failure: 'Stop must bind the exact observed service Run' },
  { id: 'runtime-retained-draft', suite: 'runtime', file: pane,
    before: '{config ? <CapsuleDefaults config={config}', after: "{config && runtime?.phase === 'running' ? <CapsuleDefaults config={config}",
    test: 'starts and stops the exact independent service through App management while retaining drafts and an unknown original command', failure: 'Stopped service must retain mounted dirty defaults' },
  { id: 'runtime-observation-only-entry', suite: 'runtime', file: pane,
    before: "if (active && runtime?.phase === 'running') { void loadConfig(); void loadPages() }", after: 'if (active) { void loadConfig(); void loadPages() }',
    test: 'starts and stops the exact independent service through App management while retaining drafts and an unknown original command', failure: 'Settings entry must remain an observation' }
].map(mutant => {
  assert.equal(sources[mutant.file].split(mutant.before).length - 1, 1, 'Exactly one actual owning source anchor: ' + mutant.id)
  return { ...mutant, suite: mutant.suite ?? 'domain', source: sources[mutant.file].replace(mutant.before, mutant.after) }
})
await writeFile(join(output, 'plan.json'), JSON.stringify({ root, mutants, tracked, suites }, null, 2))
const config = join(output, 'verify.config.mts')
await writeFile(config, `import base from ${JSON.stringify(join(root, 'apps/desktop/test/capsule-settings.config.mts'))}
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
const plan=JSON.parse(readFileSync(${JSON.stringify(join(output, 'plan.json'))},'utf8'))
const mutant=plan.mutants.find(item=>item.id===process.env.CAPSULE_SETTINGS_MUTANT)
const suite=process.env.CAPSULE_SETTINGS_SUITE
const capture={consumed:0,loaded:{},compiled:{}}
const sha=value=>createHash('sha256').update(value).digest('hex')
const publish=()=>writeFileSync(process.env.CAPSULE_SETTINGS_CAPTURE!,JSON.stringify(capture))
export default {...base,test:{...base.test,include:[plan.suites[suite]]},cacheDir:${JSON.stringify(join(output, 'cache'))},plugins:[...base.plugins,
{name:'capsule-settings-owner-source',enforce:'pre',transform(input,id){
 const file=relative(plan.root,id.split('?')[0]);if(!plan.tracked.includes(file))return
 const original=readFileSync(id,'utf8'),text=mutant?.file===file?mutant.source:input
 capture.loaded[file]={original:sha(original),loaded:sha(text)};if(mutant?.file===file)capture.consumed++;publish()
 return{code:text,map:null}
}},{name:'capsule-settings-compiled-owner',enforce:'post',transform(code,id){
 const file=relative(plan.root,id.split('?')[0]);if(!plan.tracked.includes(file))return
 capture.compiled[file]=sha(code);publish()
}}]}
`)
const callers = []
for (const [symbol, definition] of [['CapsuleSettingsPane', pane], ['capsuleSettingsModule', module], ['useCapsuleMutation', draft], ['CapsuleRuntimeSettings', runtime], ['callCapsuleFromApp', ipc]]) {
  const found = execFileSync('rg', ['-n', '-w', symbol, 'apps/desktop/src', '-g', '*.ts', '-g', '*.tsx'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(line => !line.startsWith(definition + ':'))
  assert.ok(found.length, 'Nonempty definition-excluded production consumers: ' + symbol)
  callers.push({ symbol, definition, consumers: found })
}
await writeFile(join(output, 'callers.json'), JSON.stringify(callers, null, 2))
const runs = []
const baselineCounts = {}
async function run(suite, mutant) {
  const id = mutant?.id ?? 'control-' + suite, report = join(output, id + '.tests.json'), captured = join(output, id + '.capture.json'), chunks = []
  const exitCode = await new Promise((yes, no) => {
    const child = spawn(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, '--maxWorkers=1', '--reporter=json', '--outputFile.json=' + report],
      { cwd: root, env: { ...process.env, CAPSULE_SETTINGS_SUITE: suite, CAPSULE_SETTINGS_MUTANT: mutant?.id ?? '', CAPSULE_SETTINGS_CAPTURE: captured }, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', chunk => chunks.push(chunk)); child.stderr.on('data', chunk => chunks.push(chunk)); child.on('error', no); child.on('close', yes)
  })
  const log = Buffer.concat(chunks).toString(); await writeFile(join(output, id + '.log'), log)
  const result = JSON.parse(await readFile(report, 'utf8'))
  assert.equal(result.testResults.length, 1, 'Exactly the owning consumer suite must run')
  assert.equal(resolve(result.testResults[0].name), resolve(root, suites[suite]), 'The intended consumer file must run')
  const assertions = result.testResults.flatMap(suite => suite.assertionResults)
  assert.ok(assertions.length > 0, 'Nonempty actual test collection: ' + result.testResults.map(value => value.message ?? '').join('\n'))
  assert.equal(assertions.length, result.numTotalTests)
  const capture = JSON.parse(await readFile(captured, 'utf8'))
  assert.doesNotMatch(log, /Unhandled Errors|Unhandled Rejection|Uncaught Exception/u)
  if (!mutant) {
    assert.equal(exitCode, 0, log); assert.equal(result.numFailedTests, 0); assert.equal(result.numPassedTests, result.numTotalTests)
    baselineCounts[suite] = result.numTotalTests
    for (const file of suite === 'runtime' ? [pane, runtime, ipc] : [pane, draft, modules, module]) {
      assert.ok(capture.loaded[file] && capture.compiled[file], 'The actual owning source was loaded and compiled: ' + file)
      assert.equal(capture.loaded[file].loaded, sha(sources[file]))
    }
  } else {
    assert.equal(result.numTotalTests, baselineCounts[suite], 'Mutants retain the complete owning collection')
    assert.equal(exitCode, 1, 'Actual source mutation must reach a business assertion')
    assert.ok(capture.consumed > 0 && capture.compiled[mutant.file], 'Actual owning source was loaded and compiled')
    assert.equal(capture.loaded[mutant.file].loaded, sha(mutant.source))
    assert.notEqual(capture.loaded[mutant.file].loaded, capture.loaded[mutant.file].original)
    const failed = assertions.find(test => test.fullName === mutant.test)
    assert.equal(failed?.status, 'failed', 'Declared owning business assertion turns red: ' + mutant.id)
    assert.ok(failed.failureMessages.some(message => /AssertionError|expected .* to /su.test(message)), 'Setup/runtime failures cannot qualify')
    if (mutant.failure) assert.ok(failed.failureMessages.some(message => message.includes(mutant.failure)), 'The designated consumer assertion must fail; freshness or cleanup assertions cannot qualify')
  }
  const receipt = { id, suite, exitCode, passed: result.numPassedTests, failed: result.numFailedTests, consumed: capture.consumed }
  runs.push(receipt); process.stdout.write(JSON.stringify(receipt) + '\n')
}
for (const suite of Object.keys(suites)) {
  await run(suite)
  if (args.includes('--mutations')) for (const mutant of mutants.filter(value => value.suite === suite)) await run(suite, mutant)
}
const sourceIdentity = Object.fromEntries(Object.entries(sources).map(([file, text]) => [file, sha(text)]))
for (const [file, hash] of Object.entries(sourceIdentity)) assert.equal(sha(await readFile(join(root, file))), hash, 'Owning source changed during verification: ' + file)
await writeFile(join(output, 'receipt.json'), JSON.stringify({ schema: 'agentmux.capsule-settings-proof.v1', sourceIdentity, runs, callers,
  scope: 'Settings domain editor through real Node Capsule/public RPC; App-only runtime adapter through default headless Core and actual private ctxmux service lifecycle. Native App and independent visual joins remain required.' }, null, 2))
process.stdout.write(JSON.stringify({ completed: true, output, tests: Object.values(baselineCounts).reduce((sum, count) => sum + count, 0), mutations: runs.filter(value => !value.id.startsWith('control-')).length,
  nativeService: 'actual-ctxmux', nativeApp: 'not-run', visual: 'pending' }) + '\n')
