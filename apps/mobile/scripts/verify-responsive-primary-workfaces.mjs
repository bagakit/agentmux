import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const root = resolve(import.meta.dirname, '../../..'), mobile = resolve(root, 'apps/mobile')
const require = createRequire(resolve(mobile, 'package.json'))
const vitest = resolve(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
const directory = resolve(root, '.tmp/mobile-all-surfaces/gate-' + randomUUID())
await mkdir(directory, { recursive: true })
const sha = value => createHash('sha256').update(value).digest('hex')
const files = [
  'src/MobileApp.tsx', 'src/mobile.css', 'src/goals/MobileGoalsSurface.tsx', 'src/goals/goals.css',
  'src/topics/MobileTopicsSurface.tsx', 'src/topics/MobileTopicKnowledge.tsx', 'src/topics/MobileTopicSource.tsx', 'src/topics/topics.css',
  'src/navigation/MobileSpatialNavigation.tsx', 'src/navigation/navigation.css', 'src/navigation/focus-home.css',
  'test/mobile-goal-owner.test.tsx', 'test/mobile-goals.test.tsx', 'test/responsive-goals.config.mts', 'test/responsive-topics.test.tsx',
  'test/responsive-topics.config.mts', 'test/responsive-spatial-workfaces.test.tsx', 'test/responsive-spatial-workfaces.config.mts', 'test/responsive-source-loading.test.tsx',
  'scripts/verify-responsive-primary-workfaces.mjs', ...['capture-ui.mjs', 'product-main.cjs', 'product-entry.tsx', 'responsive-primary-workfaces.cjs'].map(file => 'scripts/fixtures/mobile-product-redesign/' + file),
].map(file => 'apps/mobile/' + file)
const inputs = Object.fromEntries(await Promise.all(files.map(async file => [file, sha(await readFile(resolve(root, file)))])))
const receipt = { passed: false, inputs, runs: [], boundary: 'Actual original MobileApp/Goals/Topics/Spatial consumers with public RPC owners in isolated tests, plus private Chromium geometry and two OS processes. No live user Session, input, App restart or physical-device claim.' }
const run = async (label, executable, args, cwd = root, env = process.env) => {
  const result = await new Promise((accept, reject) => {
    const child = spawn(executable, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = ''
    child.stdout.on('data', bytes => log += bytes); child.stderr.on('data', bytes => log += bytes)
    child.once('error', reject); child.once('close', (code, signal) => accept({ code, signal, log }))
  })
  await writeFile(resolve(directory, label + '.log'), result.log)
  assert.equal(result.signal, null, label + ' exits normally')
  return result
}
try {
  // A concurrent, unrelated worktree change can invalidate Tracker's whole-tree envelope
  // after these exact consumers passed. Rejoin that evidence only with an explicit,
  // independently reviewed byte-level qualification; never replay the expensive matrix.
  if (process.env.MOBILE_RESPONSIVE_GATE_RECEIPT) {
    const priorRef = process.env.MOBILE_RESPONSIVE_GATE_RECEIPT
    const priorBytes = await readFile(resolve(root, priorRef)), prior = JSON.parse(priorBytes)
    const review = JSON.parse(await readFile(resolve(root, process.env.MOBILE_RESPONSIVE_REUSE_REVIEW)))
    assert.equal(prior.passed, true); assert.equal(review.status, 'approved')
    assert.equal(review.receiptSHA256, sha(priorBytes)); assert.equal(review.receipt, priorRef)
    const verifier = 'apps/mobile/scripts/verify-responsive-primary-workfaces.mjs'
    assert.equal(review.originalVerifierSHA256, prior.inputs[verifier]); assert.equal(review.reviewedVerifierSHA256, inputs[verifier])
    assert.deepEqual(Object.keys(prior.inputs).sort(), Object.keys(inputs).sort())
    for (const [file, digest] of Object.entries(inputs)) if (file !== verifier) assert.equal(digest, prior.inputs[file], 'Same proved input: ' + file)
    const productBytes = await readFile(resolve(root, prior.privateChromium.receipt)), product = JSON.parse(productBytes)
    assert.equal(sha(productBytes), review.productReceiptSHA256)
    assert.equal(product.passed, true); assert.equal(product.restoredRenderer.passed, true)
    assert.deepEqual(product.images, prior.privateChromium.images); assert.equal(Object.keys(product.images).length, 19)
    assert.notEqual(product.renderer.environment.pid, product.restoredRenderer.environment.pid)
    for (const [file, digest] of Object.entries(product.source)) {
      const current = sha(await readFile(resolve(root, file)))
      if (current !== digest) assert.deepEqual(review.sourceChanges[file], { before: digest, after: current }, 'Exact qualified nonconsumer change: ' + file)
    }
    for (const [file, digest] of Object.entries(product.images)) assert.equal(sha(await readFile(resolve(root, file))), digest, 'Same reviewed PNG: ' + file)
    assert.equal(prior.runs.length, 16)
    const proofs = {}
    for (const item of prior.runs) {
      const bytes = await readFile(item.report), data = JSON.parse(bytes)
      const executed = data.testResults.flatMap(file => file.assertionResults).filter(test => !['pending', 'skipped'].includes(test.status))
      assert.equal(executed.length, item.executed); assert.ok(executed.length > 0); assert.equal(data.numFailedTests, item.failed)
      assert.ok(item.failed === 0 ? item.exitCode === 0 : item.failed === 1 && item.exitCode === 1 && executed.some(test => test.failureMessages.some(message => message.includes('AssertionError'))))
      proofs[item.report] = sha(bytes)
      if (item.trace) {
        const bytes = await readFile(item.trace), rows = bytes.toString().trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => !row.phase || row.phase === 'evaluated')
        assert.ok(rows.length > 0, 'Original modules actually evaluated')
        for (const row of rows) { const file = row.file ?? relative(root, row.path); if (inputs[file]) assert.equal(row.originalSHA256, inputs[file], 'Same evaluated consumer: ' + file) }
        if (item.failed) assert.ok(rows.some(row => row.originalSHA256 !== (row.loadedSHA256 ?? row.consumedSHA256)), 'Same evaluated bearing mutation')
        proofs[item.trace] = sha(bytes)
      }
    }
    assert.deepEqual(proofs, review.proofs, 'The independently qualified raw reports and evaluated traces remain exact')
    assert.equal(prior.build.exitCode, 0)
    assert.equal(sha(await readFile(resolve(dirname(resolve(root, priorRef)), 'mobile-build.log'))), review.buildLogSHA256)
    for (const [file, digest] of Object.entries(inputs)) assert.equal(sha(await readFile(resolve(root, file))), digest, 'Source retained through receipt rejoin: ' + file)
    Object.assign(receipt, prior, { inputs, reuse: { receipt: priorRef, receiptSHA256: sha(priorBytes), review: process.env.MOBILE_RESPONSIVE_REUSE_REVIEW, proofs } })
    await writeFile(resolve(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
    console.log(relative(root, resolve(directory, 'receipt.json')))
    process.exit(0)
  }
  const groups = [
    { name: 'goals', config: 'responsive-goals.config.mts', env: 'RESPONSIVE_GOALS_MUTATION', trace: 'RESPONSIVE_GOALS_LOADED', min: 4, owner: 'src/goals/MobileGoalsSurface.tsx', mutants: ['hide-wide-goal-list', 'remount-width-goal-editor', 'recreate-list-on-selection'] },
    { name: 'topics', config: 'responsive-topics.config.mts', env: 'MOBILE_RESPONSIVE_TOPICS_MUTANT', trace: 'MOBILE_RESPONSIVE_TOPICS_SOURCE_LOG', min: 4, owner: 'src/topics/MobileTopicsSurface.tsx', mutants: ['topic-navigation-hidden', 'knowledge-navigation-hidden', 'source-reader-active', 'source-navigation-sticky'] },
    { name: 'spatial', config: 'responsive-spatial-workfaces.config.mts', env: 'RESPONSIVE_SPATIAL_MUTATION', trace: 'RESPONSIVE_SPATIAL_LOADED', min: 4, owner: 'src/navigation/MobileSpatialNavigation.tsx', mutants: ['space-navigation-lost', 'space-reader-remount'] },
  ]
  for (const group of groups) for (const label of ['baseline', ...group.mutants, 'restored']) {
    const name = group.name + '-' + label, mutated = group.mutants.includes(label)
    const report = resolve(directory, name + '.json'), trace = resolve(directory, name + '-loaded.jsonl')
    await writeFile(trace, '')
    const env = { ...process.env, [group.trace]: trace }; delete env[group.env]
    if (mutated) env[group.env] = label
    const result = await run(name, process.execPath, [vitest, 'run', '--config', 'test/' + group.config, '--reporter=json', '--outputFile=' + report], mobile, env)
    const data = JSON.parse(await readFile(report, 'utf8'))
    const tests = data.testResults.flatMap(file => file.assertionResults).filter(test => !['pending', 'skipped'].includes(test.status))
    const rows = (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => !row.phase || row.phase === 'evaluated')
    const fileOf = row => row.file ?? relative(root, row.path)
    assert.ok(tests.length > 0, 'Nonempty executed consumers: ' + name)
    assert.ok(rows.some(row => fileOf(row) === 'apps/mobile/' + group.owner), 'Original owner actually evaluated: ' + name)
    for (const row of rows) if (inputs[fileOf(row)]) assert.equal(row.originalSHA256, inputs[fileOf(row)], 'Evaluated source identity: ' + fileOf(row))
    if (mutated) {
      assert.equal(result.code, 1, name); assert.equal(data.numFailedTests, 1, name)
      const failed = tests.filter(test => test.status === 'failed')
      assert.equal(failed.length, 1)
      assert.ok(failed[0].failureMessages.some(message => message.includes('AssertionError')), 'A bearing assertion, not infrastructure, kills ' + name)
      assert.ok(rows.some(row => row.originalSHA256 !== (row.loadedSHA256 ?? row.consumedSHA256)), 'The real loaded source changed: ' + name)
    } else {
      assert.equal(result.code, 0, result.log); assert.equal(data.numFailedTests, 0)
      assert.ok(tests.length >= group.min, 'Expected original consumers execute: ' + name)
    }
    receipt.runs.push({ name, exitCode: result.code, executed: tests.length, failed: data.numFailedTests, report, trace })
  }
  const loadingReport = resolve(directory, 'source-loading.json')
  const loading = await run('source-loading', process.execPath, [vitest, 'run', '--config', 'vitest.config.ts', 'test/responsive-source-loading.test.tsx', '--reporter=json', '--outputFile=' + loadingReport], mobile)
  const loadingData = JSON.parse(await readFile(loadingReport, 'utf8'))
  assert.equal(loading.code, 0, loading.log); assert.equal(loadingData.numPassedTests, 1); assert.equal(loadingData.numFailedTests, 0)
  receipt.runs.push({ name: 'source-loading', exitCode: loading.code, executed: 1, failed: 0, report: loadingReport })
  let productRef = process.env.MOBILE_RESPONSIVE_CAPTURE_RECEIPT
  if (!productRef) {
    const product = await run('private-chromium', process.execPath, [resolve(root, 'apps/mobile/scripts/fixtures/mobile-product-redesign/capture-ui.mjs'), '--responsive-primary-workfaces'])
    assert.equal(product.code, 0, product.log)
    productRef = product.log.split('\n').find(line => /^\.tmp\/mobile-product-redesign\/renderer-[^/]+\/receipt\.json$/.test(line.trim()))?.trim()
  }
  assert.ok(productRef, 'An exact private Chromium receipt is required')
  const product = JSON.parse(await readFile(resolve(root, productRef), 'utf8'))
  assert.equal(product.captureSubset, 'responsive-primary-workfaces'); assert.equal(product.passed, true)
  assert.equal(product.renderer.passed, true); assert.equal(product.restoredRenderer.passed, true)
  assert.notEqual(product.renderer.environment.pid, product.restoredRenderer.environment.pid)
  assert.ok(Object.keys(product.images).length >= 10, 'Complete representative Phone and wide workfaces')
  for (const [file, digest] of Object.entries(product.source)) assert.equal(sha(await readFile(resolve(root, file))), digest, 'Reused capture source identity: ' + file)
  for (const [file, digest] of Object.entries(product.images)) assert.equal(sha(await readFile(resolve(root, file))), digest, 'Complete captured PNG identity: ' + file)
  receipt.privateChromium = { receipt: productRef, images: product.images, initialPid: product.renderer.environment.pid, restoredPid: product.restoredRenderer.environment.pid }
  const build = await run('mobile-build', 'pnpm', ['--filter', '@agentmux/mobile', 'build'])
  assert.equal(build.code, 0, build.log)
  receipt.build = { command: 'pnpm --filter @agentmux/mobile build', exitCode: build.code, includes: 'standard tsc --noEmit and Vite build' }
  for (const [file, digest] of Object.entries(inputs)) assert.equal(sha(await readFile(resolve(root, file))), digest, 'Source retained during final gate: ' + file)
  receipt.passed = true
} catch (error) {
  receipt.passed = false; receipt.error = { message: error.message, stack: error.stack }; process.exitCode = 1
}
await writeFile(resolve(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log(relative(root, resolve(directory, 'receipt.json')))
