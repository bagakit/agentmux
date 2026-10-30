import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import { recoveryMutations } from '../test/mobile-recovery-mutations.mjs'
import { bundleIdentityRuntime } from '../../../packages/identity/scripts/runtime-bundle.mjs'

const root = resolve(import.meta.dirname, '../../..'), mobile = resolve(root, 'apps/mobile')
const directory = resolve(root, '.local/state/mobile-recovery-usability', 'attempt-' + randomUUID())
const sources = ['apps/mobile/src/connection/MobileConnectionRoot.tsx', 'apps/mobile/src/navigation/MobileAgentCreate.tsx',
  'apps/mobile/src/recovery/device-workface.ts', 'apps/mobile/src/mobile-web/update-safety.ts',
  'packages/core/src/hosted-client.ts', 'packages/core/src/hosted-value.ts', 'packages/core/src/public-rpc-service.ts',
  'packages/diagnostic-evidence/src/index.ts', 'packages/diagnostic-evidence/src/protocol.ts', 'packages/diagnostic-evidence/src/query.ts',
  'apps/desktop/src/renderer/src/lib/space-agent-control.ts', 'apps/mobile/test/mobile-agent-create.test.tsx',
  'apps/mobile/test/mobile-recovery-connection.test.tsx', 'apps/mobile/test/mobile-update-connection.test.tsx']
const harness = ['apps/mobile/scripts/verify-mobile-recovery-usability.mjs', 'apps/mobile/test/mobile-recovery-usability.config.mts',
  'apps/mobile/test/mobile-recovery-mutations.mjs', 'apps/mobile/test/mobile-web.config.mts', 'apps/mobile/test/device-locks.ts',
  'apps/mobile/test/conversation-fixture.tsx', 'apps/mobile/src/mobile.css', 'packages/core/package.json', 'apps/host/package.json', 'packages/diagnostic-evidence/package.json',
  'packages/identity/src/index.ts', 'packages/identity/src/runtime-entry.ts', 'packages/identity/scripts/runtime-bundle.mjs']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const identityModuleSHA256 = hash(`export const identityRuntimeSource = ${JSON.stringify((await bundleIdentityRuntime()).source)};\n`)
const inputs = Object.fromEntries(await Promise.all([...sources, ...harness].map(async file => [file, hash(await readFile(resolve(root, file)))])))
await mkdir(directory, { recursive: true })
const receipt = { schema: 'agentmux.mobile-recovery-usability.v1', passed: false,
  scope: 'Mounted original Mobile creation, update safety and ConnectionRoot. Original public codec/spatial creator and real Hosted consumer over controlled transport; Native launch and MobileApp shell are bounded fixtures. No live Relay, ctxmux, model, user App, physical phone or install claim. Independent current screenshots are reviewed separately.',
  environment: { node: process.versions.node, platform: process.platform, architecture: process.arch }, inputs, identityModuleSHA256, runs: [] }
try {
  for (const label of ['baseline', ...Object.keys(recoveryMutations), 'restored']) {
    const variant = recoveryMutations[label], loaded = resolve(directory, label + '-loaded.jsonl'), reportFile = resolve(directory, label + '-result.json')
    await writeFile(loaded, '')
    const run = await new Promise((accept, reject) => {
      const env = { ...process.env, MOBILE_RECOVERY_LOADED: loaded }
      delete env.MOBILE_RECOVERY_MUTANT; delete env.MOBILE_WEB_MUTANT; delete env.MOBILE_WEB_LOADED
      if (variant) env.MOBILE_RECOVERY_MUTANT = label
      const child = spawn('pnpm', ['exec', 'vitest', 'run', '--config', 'test/mobile-recovery-usability.config.mts', '--reporter=json', '--outputFile=' + reportFile],
        { cwd: mobile, env, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''; child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
      child.once('error', reject); child.once('close', (code, signal) => accept({ code, signal, output }))
    })
    await writeFile(resolve(directory, label + '.log'), run.output)
    assert.equal(run.signal, null, 'The actual consumer must exit normally')
    const report = JSON.parse(await readFile(reportFile, 'utf8'))
    const selected = report.testResults.flatMap(file => file.assertionResults).filter(test => test.status !== 'pending' && test.status !== 'skipped')
    assert.equal(selected.length, variant ? 1 : 18, 'The exact nonempty original consumer selection must execute')
    const evaluations = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(row => JSON.parse(row))
    for (const source of sources) assert.ok(evaluations.some(row => row.path === source), 'Actual owner/consumer must evaluate: ' + source)
    assert.ok(evaluations.filter(row => !row.generated).every(row => row.originalSHA256 === inputs[row.path]), 'Every round must consume the same original source')
    assert.ok(evaluations.some(row => row.generated && row.path === 'virtual:mobile-recovery-identity-source' && row.loadedSHA256 === identityModuleSHA256), 'The existing production Identity runtime recipe must actually evaluate without published dist')
    if (variant) {
      assert.notEqual(run.code, 0, 'The exact source mutation must fail its real consumer')
      assert.equal(report.numFailedTests, 1); assert.equal(report.numPassedTests, 0)
      assert.ok(selected[0].fullName.includes(variant.target), 'The intended consumer must fail')
      assert.equal(selected[0].status, 'failed')
      assert.ok(selected[0].failureMessages.some(message => /AssertionError|__VITEST_(?:REJECTS|RESOLVES)__/u.test(message)), 'Only an actual matcher failure proves the mutation; setup, imports and timeouts do not')
      assert.ok(evaluations.some(row => row.path === variant.file && row.mutation === label && row.loadedSHA256 !== row.originalSHA256), 'The changed original module must execute')
    } else {
      assert.equal(run.code, 0, run.output); assert.equal(report.numFailedTests, 0); assert.equal(report.numPassedTests, 18)
      assert.ok(evaluations.filter(row => !row.generated).every(row => row.loadedSHA256 === row.originalSHA256), 'The baseline and restoration consume unmodified source')
    }
    for (const [file, digest] of Object.entries(inputs)) assert.equal(hash(await readFile(resolve(root, file))), digest, 'Original input remains unchanged: ' + file)
    receipt.runs.push({ label, exitCode: run.code, selected: selected.length, passed: report.numPassedTests, failed: report.numFailedTests,
      evaluations: [...new Map(evaluations.map(row => [JSON.stringify(row), row])).values()], reportSHA256: hash(await readFile(reportFile)), logSHA256: hash(run.output) })
    process.stdout.write(JSON.stringify({ label, passed: report.numPassedTests, failed: report.numFailedTests }) + '\n')
  }
  receipt.passed = true
} catch (error) { receipt.error = { message: error.message, stack: error.stack }; process.exitCode = 1 }
await writeFile(resolve(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
process.stdout.write(JSON.stringify({ passed: receipt.passed, receipt: relative(root, resolve(directory, 'receipt.json')) }) + '\n')
