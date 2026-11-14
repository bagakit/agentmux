import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { spawn } from 'node:child_process'
const root = resolve(import.meta.dirname, '../../..'), mobile = resolve(root, 'apps/mobile')
const require = createRequire(resolve(mobile, 'package.json')), vitest = resolve(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
const directory = resolve(root, '.tmp/mobile-wide-agent-workface/run-' + randomUUID()); await mkdir(directory, { recursive: true })
const captureFiles = ['capture-ui.mjs', 'product-entry.tsx', 'product-main.cjs', 'wide-agent-workface.cjs'].map(name => 'apps/mobile/scripts/fixtures/mobile-product-redesign/' + name)
const files = [...captureFiles,'apps/mobile/src/MobileApp.tsx', 'apps/mobile/src/navigation/defer-mobile-surface.tsx', 'apps/mobile/test/wide-agent-directory-load.test.tsx', 'apps/mobile/vitest.config.ts', 'apps/mobile/src/mobile.css', 'apps/mobile/src/navigation/MobileSpatialNavigation.tsx', 'apps/mobile/src/navigation/MobileAgentRow.tsx', 'apps/mobile/src/navigation/use-wide-agent-workface.ts', 'apps/mobile/src/conversation/MobileConversationSurface.tsx', 'apps/mobile/test/wide-agent-workface.test.tsx', 'apps/mobile/test/mobile-hidden-directory-cost.test.tsx', 'apps/mobile/test/wide-agent-workface.config.mts', 'apps/mobile/scripts/verify-wide-agent-workface.mjs']
const sha = value => createHash('sha256').update(value).digest('hex')
const inputs = Object.fromEntries(await Promise.all(files.map(async file => [file, sha(await readFile(resolve(root, file)))])))
const bearing = { 'hide-wide-focus': 'wide Focus must be visible beside the Agent', 'remount-width-editor': 'width must retain the original editor node', 'duplicate-catalog-reader': 'wide directory must pause the duplicate attention catalog reader' }
const receipt = { passed: false, inputs, runs: [], boundary: 'Actual MobileApp, original directory, Reader and Composer with controlled public SDK leaves in isolated DOM Storage. This is not a physical phone or a live user Session. Private Chromium restart and independent screenshot review have separate receipts.' }
try {
  for (const label of ['baseline', ...Object.keys(bearing), 'restored']) {
    const mutated = label in bearing, report = resolve(directory, label + '.json'), loaded = resolve(directory, label + '-loaded.jsonl')
    await writeFile(loaded, '')
    const env = { ...process.env, WIDE_WORKFACE_LOADED: loaded }; delete env.WIDE_WORKFACE_MUTATION
    if (mutated) env.WIDE_WORKFACE_MUTATION = label
    const args = [vitest, 'run', '--config', 'test/wide-agent-workface.config.mts', '--reporter=json', '--outputFile=' + report]
    const run = await new Promise((accept, reject) => { const child = spawn(process.execPath, args, { cwd: mobile, env, stdio: ['ignore', 'pipe', 'pipe'] }); let log = ''; child.stdout.on('data', value => log += value); child.stderr.on('data', value => log += value); child.once('error', reject); child.once('close', (code, signal) => accept({ code, signal, log })) })
    await writeFile(resolve(directory, label + '.log'), run.log)
    const result = JSON.parse(await readFile(report, 'utf8')), tests = result.testResults.flatMap(file => file.assertionResults).filter(test => !['pending', 'skipped'].includes(test.status))
    const evaluated = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.phase === 'evaluated')
    assert.equal(run.signal, null); assert.ok(tests.length > 0)
    for (const file of files.filter(file => !captureFiles.includes(file) && !file.endsWith('.cjs') && !file.endsWith('.css') && !file.endsWith('.mjs') && !file.endsWith('.config.mts') && !file.endsWith('vitest.config.ts') && !(mutated && /mobile-hidden-directory-cost.test.tsx|wide-agent-directory-load.test.tsx/.test(file)) && !(mutated && label !== 'duplicate-catalog-reader' && /MobileSpatialNavigation|MobileAgentRow/.test(file)))) assert.ok(evaluated.some(row => row.file === file && row.originalSHA256 === inputs[file]), 'Actual owner/consumer evaluated: ' + file)
    if (mutated) {
      assert.equal(run.code, 1); assert.equal(result.numFailedTests, 1); assert.equal(tests.length, 1)
      assert.ok(tests[0].failureMessages.some(message => message.includes('AssertionError') && message.includes(bearing[label])), 'Exact bearing assertion: ' + label)
      assert.ok(evaluated.some(row => row.mutation === label && row.originalSHA256 !== row.loadedSHA256))
    } else { assert.equal(run.code, 0, run.log); assert.equal(tests.length, 9); assert.equal(result.numFailedTests, 0); assert.equal(result.numPendingTests, 0) }
    receipt.runs.push({ label, exitCode: run.code, tests: tests.length, failed: result.numFailedTests, report, loaded })
  }
  receipt.productChecks = []
  for (const [label, binary, args] of [
    ['mobile-typecheck', 'pnpm', ['--filter', '@agentmux/mobile', 'typecheck']],
    ['private-chromium', process.execPath, [resolve(root, 'apps/mobile/scripts/fixtures/mobile-product-redesign/capture-ui.mjs'), '--wide-agent-workface']]
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
