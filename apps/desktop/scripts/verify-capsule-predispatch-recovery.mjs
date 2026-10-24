import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const settings = 'apps/desktop/src/renderer/src/components/settings/capsule-settings-draft.ts'
const toolkit = 'apps/desktop/src/renderer/src/components/toolkit/ToolkitCapsuleResults.tsx'
const manager = 'packages/core/src/capsule-run-manager.ts'
const envelope = 'apps/desktop/src/shared/session-input-result.ts'
const tracked = [settings, toolkit, manager, envelope]
const suite = 'apps/desktop/test/capsule-predispatch-recovery.test.tsx'
const configSource = 'apps/desktop/test/capsule-predispatch-recovery.config.mts'
const inputs = [...tracked, suite, configSource, 'apps/desktop/scripts/verify-capsule-predispatch-recovery.mjs',
  'apps/desktop/src/main/capsule-ipc.ts', 'apps/desktop/src/renderer/src/components/settings/CapsuleSettingsPane.tsx',
  'apps/desktop/src/renderer/src/components/toolkit/UserToolkitResult.tsx', 'packages/capsule/src/node.ts',
  'packages/core/src/delivery-attempt.ts', 'packages/core/src/errors.ts', 'packages/core/src/public-rpc-frame.ts',
  'packages/core/src/public-rpc-service.ts', 'packages/core/src/public-rpc-client.ts']
const sources = Object.fromEntries(await Promise.all(inputs.map(async path => [path, await readFile(join(root, path), 'utf8')])))
const sha = value => createHash('sha256').update(value).digest('hex')
const mutants = [
  ...[['settings', settings], ['toolkit', toolkit]].flatMap(([consumer, file]) => [
    { id: consumer + '-known-refusal-locked', file, from: "phase: notApplied ? 'failed' : 'unknown'", to: "phase: 'unknown'",
      test: consumer + ' permits a fresh explicit action after real manager refusal through public RPC and the App envelope',
      failure: 'Exact pre-dispatch nonapplication must release only the failed attempt' },
    { id: consumer + '-nonzero-or-null-bytes-unlocked', file, from: 'failure.confirmedInputBytes === 0', to: 'true',
      test: consumer + ' never interprets absent, unknown, null-byte or prefix receipts as permission for a new action',
      failure: 'Only exact not_applied with zero confirmed bytes permits a fresh action' },
    { id: consumer + '-unknown-posteffect-unlocked', file, from: "phase: notApplied ? 'failed' : 'unknown'", to: "phase: 'failed'",
      test: consumer + ' keeps a post-effect lost receipt inspect-only and consumes the same committed original operation',
      failure: 'An unknown postdispatch attempt must remain inspect-only' },
  ])
]
for (const mutant of mutants) assert.equal(sources[mutant.file].split(mutant.from).length - 1, 1, 'One owning source anchor: ' + mutant.id)
await mkdir(join(root, '.tmp'), { recursive: true })
const directory = await mkdtemp(join(root, '.tmp', 'capsule-predispatch-recovery-'))
const config = join(directory, 'verify.config.mts'), capturePath = join(directory, 'capture.json')
const receipt = { schema: 'agentmux.capsule-predispatch-recovery-proof.v1', passed: false,
  inputs: Object.fromEntries(Object.entries(sources).map(([path, source]) => [path, sha(source)])), runs: [],
  boundary: 'Actual Core manager pre-dispatch refusal through Unix public RPC and the App error envelope into mounted Settings and UserToolkitResult. Actual Node domain journal, controlled transport recovery and post-effect receipt loss. No Native input, process restart, Electron or production incident recovery is claimed.' }
async function run(mutant) {
  const name = mutant?.id ?? 'baseline', report = join(directory, name + '.tests.json')
  const replacement = mutant ? { file: mutant.file, source: sources[mutant.file].replace(mutant.from, mutant.to) } : null
  await rm(capturePath, { force: true }); await rm(report, { force: true })
  await writeFile(config, `import base from ${JSON.stringify(join(root, configSource))};
import {writeFileSync} from 'node:fs';import{relative}from'node:path';import{createHash}from'node:crypto';
const tracked=${JSON.stringify(tracked)},mutation=${JSON.stringify(replacement)},capture={loaded:{},compiled:{},consumed:0};
const sha=v=>createHash('sha256').update(v).digest('hex');const save=()=>writeFileSync(${JSON.stringify(capturePath)},JSON.stringify(capture));
export default {...base,cacheDir:${JSON.stringify(join(directory, 'cache'))},plugins:[...base.plugins,
{name:'capsule-predispatch-source',enforce:'pre',transform(code,id){const file=relative(base.root,id.split('?')[0]);if(!tracked.includes(file))return;
const text=mutation?.file===file?mutation.source:code;capture.loaded[file]=sha(text);if(mutation?.file===file)capture.consumed++;save();return{code:text,map:null}}},
{name:'capsule-predispatch-compiled',enforce:'post',transform(code,id){const file=relative(base.root,id.split('?')[0]);if(tracked.includes(file)){capture.compiled[file]=sha(code);save()}}}],
test:{...base.test,passWithNoTests:false,maxWorkers:1}};`)
  const args = [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, '--reporter=json', '--outputFile', report]
  if (mutant) args.push('-t', mutant.test)
  const chunks = []
  const exitCode = await new Promise((yes, no) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', value => chunks.push(value)); child.stderr.on('data', value => chunks.push(value))
    child.once('error', no); child.once('close', yes)
  })
  const log = Buffer.concat(chunks).toString(); await writeFile(join(directory, name + '.log'), log)
  const result = JSON.parse(await readFile(report, 'utf8')), capture = JSON.parse(await readFile(capturePath, 'utf8'))
  assert.equal(result.testResults.length, 1, 'The actual consumer suite must run')
  assert.equal(resolve(result.testResults[0].name), join(root, suite))
  const assertions = result.testResults[0].assertionResults.filter(item => item.status === 'passed' || item.status === 'failed')
  assert.ok(assertions.length > 0, 'An empty or skipped collection cannot qualify')
  assert.equal(result.numRuntimeErrorTestSuites ?? 0, 0, log)
  assert.doesNotMatch(log, /Unhandled Errors|Unhandled Rejection|Uncaught Exception/u)
  for (const file of tracked) {
    assert.ok(capture.compiled[file], 'Actual owner, envelope and consumer must compile: ' + file)
    assert.equal(capture.loaded[file], sha(replacement?.file === file ? replacement.source : sources[file]))
  }
  if (mutant) {
    assert.equal(exitCode, 1, 'Source mutation must fail at its business assertion')
    assert.ok(capture.consumed > 0); assert.notEqual(capture.loaded[mutant.file], sha(sources[mutant.file]))
    const failure = assertions.find(item => item.fullName === mutant.test)
    assert.equal(failure?.status, 'failed', 'The designated business test must fail')
    assert.ok(failure.failureMessages.some(message => message.includes('AssertionError') && message.includes(mutant.failure)),
      'Infrastructure, setup or unrelated assertions cannot qualify a mutant: ' + mutant.id)
  } else {
    assert.equal(exitCode, 0, log); assert.equal(result.numFailedTests, 0); assert.equal(result.numPassedTests, 6)
    assert.equal(assertions.length, 6); assert.equal(capture.consumed, 0)
  }
  receipt.runs.push({ name, exitCode, passed: result.numPassedTests, failed: result.numFailedTests, capture,
    ...(mutant ? { designatedTest: mutant.test, designatedFailure: mutant.failure } : {}) })
  process.stdout.write(JSON.stringify({ name, exitCode, passed: result.numPassedTests, failed: result.numFailedTests }) + '\n')
}
try {
  await run()
  if (process.argv.includes('--mutations')) for (const mutant of mutants) await run(mutant)
  for (const [path, source] of Object.entries(sources)) assert.equal(sha(await readFile(join(root, path))), sha(source), 'Input changed during verification: ' + path)
  receipt.passed = true
} finally {
  await rm(join(directory, 'cache'), { recursive: true, force: true })
  await writeFile(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
process.stdout.write(JSON.stringify({ passed: true, directory: relative(root, directory), mutations: receipt.runs.length - 1 }) + '\n')
