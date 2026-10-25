import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { relative, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..'), evidence = resolve(root, '.local/creation-resource-wake/desktop')
const require = createRequire(new URL('../package.json', import.meta.url))
const hash = value => createHash('sha256').update(value).digest('hex')
const json = async file => JSON.parse(await readFile(file, 'utf8'))
const config = 'apps/desktop/test/creation-resource-wake.config.mts'
const required = [
  'apps/desktop/src/shared/contracts.ts', 'apps/desktop/src/main/runtime-controller.ts', 'apps/desktop/src/main/ipc.ts',
  'apps/desktop/src/main/ipc-sender-trust.ts', 'apps/desktop/src/preload/index.ts', 'apps/desktop/src/renderer/src/lib/api.ts',
  'apps/desktop/src/renderer/src/lib/session-state.ts', 'apps/desktop/src/renderer/src/store.ts',
  'apps/desktop/src/renderer/src/components/SessionPane.tsx', 'apps/desktop/src/renderer/src/components/SessionConnectingSurface.tsx',
  'apps/desktop/src/renderer/src/components/SessionRecoveryActions.tsx',
  'apps/desktop/test/disk-start-recovery-surface.test.tsx', 'apps/desktop/test/creation-resource-wake-ipc.test.ts',
  'apps/desktop/test/fixtures/terminal-observation-bridge.ts', config]
const variants = [
  { name: 'baseline' },
  { name: 'wrong-request', file: 'apps/desktop/src/renderer/src/components/SessionPane.tsx', target: 'continues only the original request',
    from: 'createOperationId: request.createOperationId, agentSessionId: sessionId', to: "createOperationId: 'replacement-operation', agentSessionId: sessionId" },
  { name: 'uncorrelated-receipt', file: 'apps/desktop/src/main/runtime-controller.ts', target: 'actual preload and trusted Main wake',
    from: 'return parseCreationContinueResult({ ...receipt, hostId: request.hostId }, request)', to: 'return { ...receipt, hostId: request.hostId }' }
]
async function run(command, args, env = process.env) {
  return await new Promise((done, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = ''; child.stdout.on('data', bytes => { log += bytes }); child.stderr.on('data', bytes => { log += bytes })
    child.once('error', reject); child.once('exit', (code, signal) => done({ code, signal, log }))
  })
}
async function inputsMatch(inputs) {
  for (const file of required) assert.match(inputs[file] ?? '', /^[a-f0-9]{64}$/, 'Required exact source: ' + file)
  // A prior producer also recorded its reader/visual files. Only this focused test's
  // contributing inputs are projected here; their original hashes are never rebound.
  for (const file of required) assert.equal(hash(await readFile(resolve(root, file))), inputs[file], 'Candidate changed: ' + file)
}
async function focusedMatches(receipt) {
  assert.equal(receipt.schema, 'agentmux.desktop-creation-wake-focused.v1'); await inputsMatch(receipt.inputs)
  assert.deepEqual(receipt.results.map(row => row.name), variants.map(row => row.name))
  for (const [index, variant] of variants.entries()) {
    const result = receipt.results[index]
    for (const key of ['report', 'loaded', 'log']) assert.equal(hash(await readFile(resolve(root, result[key]))), result[key + 'SHA256'])
    const report = await json(resolve(root, result.report)), loaded = await json(resolve(root, result.loaded))
    assert.equal(report.numRuntimeErrorTestSuites ?? 0, 0, 'Import/transform errors cannot kill a mutant')
    const tests = report.testResults.flatMap(row => row.assertionResults)
    assert.ok(tests.some(row => ['passed', 'failed'].includes(row.status)), 'Nonempty real consumers')
    if (!variant.file) {
      assert.equal(result.code, 0); assert.equal(report.success, true); assert.equal(report.numFailedTests, 0); assert.ok(report.numPassedTests >= 15)
      for (const file of required.filter(file => file !== config)) {
        assert.equal(loaded[file]?.sourceSHA256, receipt.inputs[file], 'Actual loaded consumer: ' + file)
        assert.equal(loaded[file]?.loadedSHA256, receipt.inputs[file], 'Actual received source bytes: ' + file)
      }
      for (const name of ['actual preload and trusted Main wake', 'continues only the original request', 'late response', 'not-waiting', 'read-only', 'actual creation projection'])
        assert.ok(tests.some(row => row.status === 'passed' && row.fullName.includes(name)), 'Required consumer: ' + name)
    } else {
      assert.notEqual(result.code, 0); assert.equal(loaded[variant.file]?.mutant, variant.name)
      assert.equal(loaded[variant.file].sourceSHA256, receipt.inputs[variant.file])
      const source = await readFile(resolve(root, variant.file), 'utf8')
      assert.equal(source.split(variant.from).length - 1, 1, 'Unique loaded mutation')
      assert.equal(loaded[variant.file].loadedSHA256, hash(source.replace(variant.from, variant.to)), 'Exact actual mutant bytes')
      assert.notEqual(loaded[variant.file].loadedSHA256, loaded[variant.file].sourceSHA256)
      assert.ok(tests.some(row => row.status === 'failed' && row.fullName.includes(variant.target) &&
        row.failureMessages.some(message => /AssertionError|expected|promise resolved/iu.test(message))), 'Designated semantic RED: ' + variant.name)
    }
  }
}
async function dependenciesMatch() {
  for (const args of [['packages/core/scripts/verify-creation-resource-wake.mjs'], ['apps/desktop/scripts/verify-agent-creation-pre-admission-restart.mjs', '--wake']]) {
    const result = await run(process.execPath, args); assert.equal(result.code, 0, result.log)
  }
  const visualPath = resolve(evidence, 'visual/receipt.json'), visual = await json(visualPath)
  assert.equal(visual.passed, true); assert.equal(visual.creationWake, true); assert.equal(visual.privateHiddenWindow, true)
  assert.equal(visual.fixtureRunnerSHA256, hash(await readFile(resolve(root, 'apps/desktop/scripts/fixtures/recovery-actions/presentation.mjs'))))
  assert.ok(visual.images.length >= 8); assert.equal(visual.userRuntimeTouched, false)
  for (const label of ['creation-wait-dark', 'creation-wait-narrow-light', 'creation-wait-short', 'creation-wait-short-prompt',
    'creation-wait-details', 'creation-continue-feedback', 'creation-no-wait-details', 'creation-unconfirmed-light'])
    assert.ok(visual.images.some(image => image.label === label), 'Required actual scene: ' + label)
  assert.deepEqual(visual.keyboard.actions, ['Check original', 'Take over', 'Analyze…']); assert.equal(visual.keyboard.returned, 'Analyze…')
  assert.equal(visual.reducedMotion.reduced, true); assert.equal(visual.reducedMotion.iterations, '0'); assert.equal(visual.hidden.activeWait, false)
  assert.ok(visual.shortScroll.top > 0); assert.equal(visual.exit.code, 0)
  for (const file of ['components/SessionPane.tsx', 'components/SessionConnectingSurface.tsx', 'components/SessionRecoveryActions.tsx',
    'components/FullPageLoadingSurface.tsx', 'components/SurfaceState.tsx', 'lib/session-state.ts', 'lib/api.ts', 'store.ts', 'styles/session-connecting.css'])
    assert.match(visual.sourcePins['apps/desktop/src/renderer/src/' + file] ?? '', /^[a-f0-9]{64}$/, 'Required actual visual source: ' + file)
  assert.match(visual.sourcePins['apps/desktop/scripts/fixtures/recovery-actions/presentation-cases.tsx'] ?? '', /^[a-f0-9]{64}$/)
  for (const [file, digest] of Object.entries(visual.sourcePins)) assert.equal(hash(await readFile(resolve(root, file))), digest, 'Visual candidate changed: ' + file)
  for (const image of visual.images) assert.equal(hash(await readFile(image.path)), image.sha256)
  const reviewPath = resolve(evidence, 'visual/review.json'), review = await json(reviewPath)
  assert.equal(review.status, 'approved'); assert.equal(review.visualReceiptSHA256, hash(await readFile(visualPath)))
  assert.deepEqual(review.images, visual.images.map(({ label, sha256 }) => ({ label, sha256 })))
  assert.ok(review.reviewer && review.reviewer !== '/root/creation_wait_surface', 'Independent visual reviewer')
  return Object.fromEntries(await Promise.all([
    '.local/creation-resource-wake/core/receipt.json', '.local/creation-resource-wake/restart/receipt.json',
    relative(root, visualPath), relative(root, reviewPath)
  ].map(async file => [file, hash(await readFile(resolve(root, file)))])))
}
await mkdir(evidence, { recursive: true })
if (process.argv.includes('--run-focused')) {
  const inputs = Object.fromEntries(await Promise.all(required.map(async file => [file, hash(await readFile(resolve(root, file)))])))
  const results = []
  for (const variant of variants) {
    const prefix = resolve(evidence, variant.name), report = prefix + '.json', loaded = prefix + '.loaded.json', log = prefix + '.log'
    const result = await run(process.execPath, [require.resolve('vitest/vitest.mjs'), 'run', '--config', config, '--reporter=json', '--outputFile=' + report], {
      ...process.env, AGENTMUX_DESKTOP_CREATION_WAKE_MUTANT: variant.file ? variant.name : '', AGENTMUX_DESKTOP_CREATION_WAKE_LOADED: loaded
    })
    await writeFile(log, result.log)
    const record = { name: variant.name, code: result.code }
    for (const [key, file] of Object.entries({ report, loaded, log })) { record[key] = relative(root, file); record[key + 'SHA256'] = hash(await readFile(file)) }
    results.push(record)
    if (!variant.file) assert.equal(result.code, 0, result.log)
    process.stdout.write(variant.name + ': ' + result.code + '\n')
  }
  const receipt = { schema: 'agentmux.desktop-creation-wake-focused.v1', inputs, results }
  await focusedMatches(receipt); await writeFile(resolve(evidence, 'focused.json'), JSON.stringify(receipt, null, 2) + '\n')
} else {
  const focused = await json(resolve(evidence, 'focused.json')); await focusedMatches(focused)
  const dependencies = await dependenciesMatch()
  const record = { schema: 'agentmux.desktop-creation-wake-proof.v1', status: 'passed', verifierSHA256: hash(await readFile(new URL(import.meta.url))), focusedSHA256: hash(await readFile(resolve(evidence, 'focused.json'))), dependencies }
  if (process.argv.includes('--record')) await writeFile(resolve(evidence, 'receipt.json'), JSON.stringify(record, null, 2) + '\n')
  else assert.deepEqual(await json(resolve(evidence, 'receipt.json')), record, 'Exact integrated receipt')
  process.stdout.write('Desktop creation continuation: exact Core, bridge/Pane, semantic mutants, original workface restart and independent visual acceptance verified\n')
}
