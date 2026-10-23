import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
const root = path.resolve(import.meta.dirname, '../../..'), args = process.argv.slice(2)
const at = args.indexOf('--output'), output = path.resolve(root, at < 0 ? `.tmp/session-continuity-supervision/${randomUUID()}` : args[at + 1])
await fs.mkdir(output, { recursive: true })
await fs.rm(path.join(output, 'receipt.json'), { force: true })
const sha = value => createHash('sha256').update(value).digest('hex')
const names = {
  main: 'apps/desktop/src/main/runtime-controller.ts', store: 'apps/desktop/src/renderer/src/store.ts',
  projection: 'apps/desktop/src/renderer/src/lib/continuity-supervision.ts', intent: 'apps/desktop/src/renderer/src/lib/continuity-control-intent.ts',
  notice: 'apps/desktop/src/renderer/src/components/ContinuitySupervisionNotice.tsx',
  mainCases: 'apps/desktop/test/session-continuity-control-main.test.ts', uiCases: 'apps/desktop/test/session-continuity-supervision.test.tsx'
}
const sourceFiles = [...Object.values(names), 'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/preload/index.ts',
  'apps/desktop/src/shared/contracts.ts', 'apps/desktop/src/renderer/src/lib/api.ts', 'apps/desktop/src/renderer/src/lib/session-service-notices.ts',
  'apps/desktop/src/renderer/src/components/SessionPane.tsx', 'apps/desktop/src/renderer/src/lib/persisted-ui-writer.ts',
  'apps/desktop/src/shared/session-observation-result.ts', 'apps/desktop/src/renderer/src/styles/session-recovery-actions.css',
  'apps/desktop/scripts/fixtures/session-continuity-supervision/vitest.config.mts', 'apps/desktop/scripts/verify-session-continuity-supervision.mjs',
  'packages/core/src/agent-session-recovery/control-contract.ts', 'packages/core/src/agent-session-recovery/continuity-contract.ts', 'packages/core/src/agent-session-recovery/continuity-policy.ts', 'packages/core/src/client.ts',
  'packages/core/src/hosted-runtime-service.ts', 'packages/core/src/hosted-client.ts', 'packages/core/src/public-rpc-server.ts', 'packages/core/package.json']
const pins = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, sha(await fs.readFile(path.join(root, file)))])))
const before = await pins(), text = Object.fromEntries(await Promise.all(Object.entries(names).map(async ([key, file]) => [key, await fs.readFile(path.join(root, file), 'utf8')])))
const mainTest = 'the actual Main and Hosted Core cancel metadata while Native readiness is unavailable and preserve remote route scope'
const packetTest = 'commits the original packet before dispatch and reuses it after an unknown reply and rehydration'
const cancelTest = 'keeps independent cancellation reachable while the original continuation reader never returns'
const projectionTest = 'joins the current child to its original input and keeps running separate from confirmed context'
const variants = [
  { id: 'main-native-gate', owner: 'main', before: 'const client = this.configuredClient(hostId)\n    return { hostId, result: await client.controlAgentContinuity(input) }', after: 'const client = await this.connectedClient(hostId)\n    return { hostId, result: await client.controlAgentContinuity(input) }', test: mainTest },
  { id: 'main-remote-scope', owner: 'main', before: 'return { hostId, result: await client.controlAgentContinuity(input) }', after: "return { hostId: 'local', result: await client.controlAgentContinuity(input) }", test: mainTest },
  { id: 'main-packet-identity', owner: 'main', before: 'result: await client.controlAgentContinuity(input)', after: "result: await client.controlAgentContinuity({ ...input, operationId: input.operationId + '-replaced' })", test: mainTest },
  { id: 'store-authoring', owner: 'store', before: 'await flushMessageWorkbench(false)\n      let reply:', after: 'void 0\n      let reply:', test: packetTest },
  { id: 'store-sibling-packet', owner: 'store', before: '[key]: { ...state.continuityControlIntents[key], [request.operationId]: { hostId: session.hostId, request } }', after: '[key]: { [request.operationId]: { hostId: session.hostId, request } }', test: cancelTest },
  { id: 'store-cancel-lock', owner: 'store', before: "if (action === 'continue' && scope.some(", after: 'if (scope.some(', test: cancelTest },
  { id: 'intent-terminal-refusal', owner: 'intent', before: '.includes(value.code)', after: ".includes('unrecognized-code')", test: 'settles a normative original refusal without blocking new current-Run authorization and keeps both original packets' },
  { id: 'projection-root', owner: 'projection', before: 'const rootId = pointer.intentOperationId ?? pointer.operationId', after: 'const rootId = pointer.operationId', test: projectionTest },
  { id: 'projection-locator', owner: 'projection', before: '(original.transcriptPath === undefined || original.transcriptPath === observed.transcriptPath)', after: 'true', test: 'joins native locators without allowing an old target or evidence to confirm the current conversation' },
  { id: 'projection-context', owner: 'projection', before: "const contextConfirmed = !targetChanged && context?.source === 'native-hook'", after: "const contextConfirmed = session.processState === 'running' || !targetChanged && context?.source === 'native-hook'", test: projectionTest },
  { id: 'projection-original-input', owner: 'projection', before: 'originalInput: root.previousInput ?', after: 'originalInput: false ?', test: projectionTest },
  { id: 'store-local-parser-refusal', owner: 'store', before: '...(ownerRejection ? { rejection: ownerRejection } : {})', after: '...(terminalContinuityControlRejection(error) ? { rejection: terminalContinuityControlRejection(error)! } : {})', test: 'keeps a locally invalid result unknown instead of promoting parser failure to a terminal owner refusal' }
]
const runs = []
for (const variant of [{ id: 'baseline' }, ...variants]) {
  const file = variant.owner ? names[variant.owner] : null, original = file ? text[variant.owner] : null
  if (file) assert.equal(original.split(variant.before).length, 2, 'Unique owning mutation anchor')
  const changed = file ? original.replace(variant.before, variant.after) : null
  const report = path.join(output, variant.id + '.json'), loaded = path.join(output, variant.id + '.loaded.json'), config = path.join(output, variant.id + '.config.mts')
  await fs.rm(report, { force: true }); await fs.rm(loaded, { force: true })
  const plugin = file ? `plugins:[{name:'actual-supervision-mutation',enforce:'pre',load(id){if(id.split('?')[0]!==${JSON.stringify(path.join(root, file))})return;const current=readFileSync(id.split('?')[0],'utf8');if(current!==${JSON.stringify(original)})throw Error('Candidate drift');const code=${JSON.stringify(changed)};writeFileSync(${JSON.stringify(loaded)},JSON.stringify({original:${JSON.stringify(sha(original))},loaded:${JSON.stringify(sha(changed))}}));return code}}],` : ''
  await fs.writeFile(config, `import {readFileSync,writeFileSync} from 'node:fs';import base from ${JSON.stringify(path.join(root, 'apps/desktop/scripts/fixtures/session-continuity-supervision/vitest.config.mts'))};export default {...base,${plugin}test:{...base.test,include:${JSON.stringify([names.mainCases, names.uiCases])}}}\n`)
  let log = ''
  const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', config, '--reporter=json', '--outputFile=' + report], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', chunk => { log += chunk }); child.stderr.on('data', chunk => { log += chunk })
  const exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve) })
  await fs.writeFile(path.join(output, variant.id + '.log'), log)
  const result = JSON.parse(await fs.readFile(report, 'utf8')), assertions = result.testResults.flatMap(suite => suite.assertionResults)
  assert.equal(result.testResults.length, 2)
  for (const suite of result.testResults) { assert.ok(suite.assertionResults.length); assert.equal(suite.message, '') }
  assert.equal(assertions.length, 14); assert.equal(result.numTotalTests, assertions.length)
  assert.equal(result.numPassedTests, assertions.filter(test => test.status === 'passed').length)
  assert.equal(result.numFailedTests, assertions.filter(test => test.status === 'failed').length)
  assert.equal(result.numPendingTests, 0); assert.doesNotMatch(log, /Unhandled Errors|Unhandled Rejection|Uncaught Exception|Test timed out/)
  let witness
  if (file) {
    assert.equal(exitCode, 1); witness = JSON.parse(await fs.readFile(loaded, 'utf8'))
    assert.equal(witness.original, before[file]); assert.equal(witness.loaded, sha(changed)); assert.notEqual(witness.original, witness.loaded)
    const target = assertions.find(test => test.fullName === variant.test)
    assert.equal(target?.status, 'failed', 'The owning business assertion must fail')
    assert.ok(target.failureMessages.some(message => /AssertionError|__VITEST_(?:REJECTS|RESOLVES)__|expected .* to /su.test(message)), 'No arbitrary runtime failure may qualify')
    assert.ok(target.failureMessages.every(message => !/TypeError|ReferenceError|SyntaxError/u.test(message)), 'Setup and runtime exceptions cannot qualify')
    if (variant.id === 'store-authoring') assert.ok(target.failureMessages.some(message => message.includes('original packet durable before dispatch')), 'The missing authored packet must fail its explicit business assertion')
    if (variant.id === 'main-native-gate') assert.ok(target.failureMessages.some(message => message.includes('Reader Native readiness unavailable')), 'The original controlled Native rejection must be observed')
  } else { assert.equal(exitCode, 0, log); assert.equal(result.numFailedTests, 0); assert.equal(result.success, true) }
  runs.push({ id: variant.id, exitCode, passed: result.numPassedTests, failed: result.numFailedTests, rawReport: path.relative(root, report), rawSha256: sha(await fs.readFile(report)), ...(witness ? { witness, target: variant.test } : {}) })
  assert.deepEqual(await pins(), before); console.log(JSON.stringify(runs.at(-1)))
}
await fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify({ schema: 'agentmux.continuity-supervision-consumer-proof.v1', passed: true, scope: 'Original Store, authored request persistence, shared supervision projection, mounted controls and actual Main/Hosted owner', sourceBefore: before, sourceAfter: await pins(), sourceStable: true, runs, limitations: ['Native GUI frames and process restart belong to the separate original product runner; this receipt does not sign capture or final joined acceptance.'] }, null, 2) + '\n')
