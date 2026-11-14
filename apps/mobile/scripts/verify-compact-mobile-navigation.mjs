import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { spawn } from 'node:child_process'
const root = resolve(import.meta.dirname, '../../..'), mobile = resolve(root, 'apps/mobile')
const require = createRequire(resolve(mobile, 'package.json')), vitest = resolve(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
const directory = resolve(root, '.tmp/compact-mobile-navigation/run-' + randomUUID()); await mkdir(directory, { recursive: true })
const captureFiles = ['capture-ui.mjs', 'product-entry.tsx', 'product-main.cjs', 'wide-agent-workface.cjs', 'compact-navigation.cjs'].map(name => 'apps/mobile/scripts/fixtures/mobile-product-redesign/' + name)
const production = ['apps/mobile/src/MobileApp.tsx', 'apps/mobile/src/navigation/MobileAgentRow.tsx', 'apps/mobile/src/navigation/MobileAgentLocations.tsx', 'apps/mobile/src/navigation/MobileSpatialNavigation.tsx', 'apps/mobile/src/navigation/MobileZoneWorkface.tsx', 'apps/mobile/src/navigation/mobile-agent-locations.ts']
const consumers = ['apps/mobile/test/compact-mobile-navigation.test.tsx', 'apps/mobile/test/mobile-agent-locations.test.tsx', 'apps/mobile/test/wide-agent-workface.test.tsx', 'apps/mobile/test/mobile-hidden-directory-cost.test.tsx']
const files = [...captureFiles, ...production, ...consumers, 'apps/mobile/src/mobile.css', 'apps/mobile/src/navigation/agent-row.css', 'apps/mobile/src/navigation/focus-home.css', 'apps/mobile/src/navigation/agent-locations.css', 'apps/mobile/test/mobile-agent-locations-mutations.mjs', 'apps/mobile/vitest.config.ts', 'apps/mobile/test/compact-mobile-navigation.config.mts', 'apps/mobile/scripts/verify-compact-mobile-navigation.mjs']
const sha = value => createHash('sha256').update(value).digest('hex')
const inputs = Object.fromEntries(await Promise.all(files.map(async file => [file, sha(await readFile(resolve(root, file)))])))
const bearing = { 'back-narrow-shell': 'Back must retain the wide shell independently of the selected work panel', 'avatar-color-dot': 'avatar state must use the original semantic icon instead of a color dot', 'missing-position-menu': 'original positions stay reachable through More' }
const receipt = { passed: false, inputs, runs: [], boundary: 'Actual MobileApp, original directory, Reader and Composer with controlled public SDK leaves in isolated DOM Storage. This is not a physical phone or a live user Session. Private Chromium restart and independent screenshot review have separate receipts.' }
try {
  for (const label of ['baseline', ...Object.keys(bearing), 'restored']) {
    const mutated = label in bearing, report = resolve(directory, label + '.json'), loaded = resolve(directory, label + '-loaded.jsonl')
    await writeFile(loaded, '')
    const env = { ...process.env, COMPACT_NAV_LOADED: loaded }; delete env.COMPACT_NAV_MUTATION
    if (mutated) env.COMPACT_NAV_MUTATION = label
    const args = [vitest, 'run', '--config', 'test/compact-mobile-navigation.config.mts', '--reporter=json', '--outputFile=' + report]
    const run = await new Promise((accept, reject) => { const child = spawn(process.execPath, args, { cwd: mobile, env, stdio: ['ignore', 'pipe', 'pipe'] }); let log = ''; child.stdout.on('data', value => log += value); child.stderr.on('data', value => log += value); child.once('error', reject); child.once('close', (code, signal) => accept({ code, signal, log })) })
    await writeFile(resolve(directory, label + '.log'), run.log)
    const result = JSON.parse(await readFile(report, 'utf8')), tests = result.testResults.flatMap(file => file.assertionResults).filter(test => !['pending', 'skipped'].includes(test.status))
    const evaluated = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.phase === 'evaluated')
    assert.equal(run.signal, null); assert.ok(tests.length > 0)
    const evaluatedFiles = mutated ? production.filter(file => file !== 'apps/mobile/src/navigation/MobileZoneWorkface.tsx').concat(consumers[0]) : production.concat(consumers)
    for (const file of evaluatedFiles) assert.ok(evaluated.some(row => row.file === file && row.originalSHA256 === inputs[file]), 'Actual owner/consumer evaluated: ' + file)
    if (mutated) {
      assert.equal(run.code, 1); assert.equal(result.numFailedTests, 1); assert.equal(tests.length, 1)
      assert.ok(tests[0].failureMessages.some(message => message.includes('AssertionError') && message.includes(bearing[label])), 'Exact bearing assertion: ' + label)
      assert.ok(evaluated.some(row => row.mutation === label && row.originalSHA256 !== row.loadedSHA256))
    } else { assert.equal(run.code, 0, run.log); assert.equal(tests.length, 19); assert.equal(result.numFailedTests, 0); assert.equal(result.numPendingTests, 0) }
    receipt.runs.push({ label, exitCode: run.code, tests: tests.length, failed: result.numFailedTests, report, loaded })
  }
  receipt.productChecks = []
  for (const [label, binary, args] of [
    ['mobile-typecheck', 'pnpm', ['--filter', '@agentmux/mobile', 'typecheck']],
    ['private-chromium', process.execPath, [resolve(root, 'apps/mobile/scripts/fixtures/mobile-product-redesign/capture-ui.mjs'), '--compact-navigation']]
  ]) {
    const run = await new Promise((accept, reject) => { const child = spawn(binary, args, { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }); let log = ''; child.stdout.on('data', value => log += value); child.stderr.on('data', value => log += value); child.once('error', reject); child.once('close', (code, signal) => accept({ code, signal, log })) })
    await writeFile(resolve(directory, label + '.log'), run.log)
    assert.equal(run.signal, null); assert.equal(run.code, 0, run.log)
    receipt.productChecks.push({ label, command: [binary, ...args], exitCode: run.code, log: resolve(directory, label + '.log') })
    if (label === 'private-chromium') {
      const ref = run.log.split('\n').find(line => /^\.tmp\/mobile-product-redesign\/renderer-[^/]+\/receipt\.json$/.test(line.trim()))
      assert.ok(ref, 'Private Chromium returns its exact receipt')
      const product = JSON.parse(await readFile(resolve(root, ref.trim()), 'utf8'))
      assert.equal(product.passed, true); assert.equal(product.restoredRenderer.passed, true)
      assert.notEqual(product.renderer.environment.pid, product.restoredRenderer.environment.pid)
      assert.ok(Object.keys(product.images).length >= 6)
      receipt.privateChromium = { receipt: ref.trim(), initialPid: product.renderer.environment.pid, restoredPid: product.restoredRenderer.environment.pid, images: product.images, source: product.source }
    }
  }
  for (const [file, digest] of Object.entries(inputs)) assert.equal(sha(await readFile(resolve(root, file))), digest, 'Source retained: ' + file)
  receipt.passed = true
} catch (error) { receipt.error = { message: error.message, stack: error.stack }; process.exitCode = 1 }
await writeFile(resolve(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); console.log(resolve(directory, 'receipt.json'))
