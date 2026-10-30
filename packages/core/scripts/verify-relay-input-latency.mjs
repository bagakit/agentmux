import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const baselineComparison = args[0] === '--carrier-baseline'
assert.ok(baselineComparison ? args.length === 2 && /^[a-f0-9]{40}$/u.test(args[1])
  : args.length === 1 && ['--mobile-coalescing', '--carrier'].includes(args[0]),
  'Usage: verify-relay-input-latency.mjs --mobile-coalescing|--carrier|--carrier-baseline <explicit-commit>')
const carrier = args[0] !== '--mobile-coalescing', mode = baselineComparison ? 'carrier-baseline' : carrier ? 'carrier' : 'mobile-coalescing'
const originalRef = baselineComparison ? args[1] : undefined
const root = fileURLToPath(new URL('../../../', import.meta.url))
const evidence = resolve(process.env.AGENTMUX_RELAY_INPUT_EVIDENCE ?? join(root, '.local/relay-input-latency', mode))
const receiptFile = join(evidence, 'receipt.json'), hash = value => createHash('sha256').update(value).digest('hex')
const sourceHash = path => hash(readFileSync(join(root, path)))
const verificationInputs = ['packages/core/scripts/verify-relay-input-latency.mjs', 'packages/core/test/mobile-terminal-coalescing.config.mts',
  'packages/core/test/mobile-terminal-coalescing.test.ts', 'packages/core/test/helpers/mobile-relay-owner.ts',
  'apps/mobile/test/terminal-control.test.ts', 'apps/mobile/test/terminal-viewer-initial-binding.test.tsx', 'apps/mobile/src/terminal/control.ts',
  'apps/mobile/src/terminal/MobileTerminalViewer.tsx', 'packages/core/tsconfig.build.json', 'apps/mobile/tsconfig.json', 'tsconfig.base.json',
  ...(carrier ? ['packages/core/test/relay-carrier.config.mts', 'packages/core/test/relay-carrier.test.ts',
    'packages/core/test/helpers/relay-carrier-owner.ts', 'apps/host/test/host-lifecycle-recovery-node-loader.mjs',
    'packages/core/src/control-endpoint-listener-worker.ts', 'apps/host/tsconfig.json'] : [])]
const inputs = Object.fromEntries(verificationInputs.map(path => [path, sourceHash(path)]))
const inspectRun = (run, red) => {
  const report = JSON.parse(readFileSync(join(evidence, run.report), 'utf8'))
  const assertions = report.testResults.flatMap(file => file.assertionResults).filter(test => test.status !== 'pending' && test.status !== 'skipped')
  assert.ok(assertions.length > 0 && report.numTotalTests > 0, 'Empty consumer evidence cannot pass')
  const failures = assertions.filter(test => test.status === 'failed')
  assert.equal(run.exitCode, red ? 1 : 0)
  assert.equal(failures.length > 0, red)
  assert.equal(report.success, !red)
  assert.equal(report.numFailedTests, failures.length)
  if (run.name === 'baseline') assert.ok(report.numPassedTests >= (carrier ? 46 : 29))
  if (red) assert.ok(failures.every(test => test.failureMessages.some(message => message.includes('AssertionError'))), 'Only actual business assertion RED qualifies; setup/cleanup errors cannot substitute')
  assert.equal(hash(readFileSync(join(evidence, run.report))), run.reportSHA256)
  assert.equal(hash(readFileSync(join(evidence, run.loaded))), run.loadedSHA256)
  assert.equal(hash(readFileSync(join(evidence, run.facts))), run.factsSHA256)
  const facts = readFileSync(join(evidence, run.facts), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  for (const fact of facts) if (fact.kind === 'cleanup') assert.ok(!existsSync(fact.rootRemoved), 'Previously removed private root reappeared: ' + fact.rootRemoved)
  return readFileSync(join(evidence, run.loaded), 'utf8').trim().split('\n').map(line => JSON.parse(line))
}
try {
  const saved = JSON.parse(readFileSync(receiptFile, 'utf8'))
  assert.equal(saved.passed, true); assert.equal(saved.mode, mode); assert.deepEqual(saved.inputs, inputs)
  assert.equal(saved.mutations.length, baselineComparison ? 0 : carrier ? 9 : 6)
  if (baselineComparison) { assert.equal(saved.originalRef, originalRef); inspectRun(saved.originalTopology, false) }
  if (carrier && !baselineComparison) {
    assert.equal(saved.browserBundle.exitCode, 0)
    assert.equal(saved.browserBundle.sourceSHA256, sourceHash('packages/core/src/relay-hosted.ts'))
    assert.equal(hash(readFileSync(join(evidence, 'browser-inputs.json'))), saved.browserBundle.metafileSHA256)
  }
  for (const [path, sha] of Object.entries(saved.loadedSources)) assert.equal(sourceHash(path), sha)
  if (!baselineComparison) inspectRun(saved.baseline, false)
  for (const mutation of saved.mutations) { inspectRun(mutation.red, true); inspectRun(mutation.green, false) }
  assert.equal(saved.typechecks.length, baselineComparison ? 0 : carrier ? 3 : 2); assert.ok(saved.typechecks.every(run => run.exitCode === 0))
  console.log(JSON.stringify({ passed: true, reused: true, receipt: receiptFile })); process.exit(0)
} catch { /* A missing/stale candidate must obtain its own exact evidence. */ }

mkdirSync(evidence, { recursive: true })
const receipt = { schema: 'agentmux.relay-input-latency.v1', mode, passed: false, inputs, loadedSources: {},
  originalRef: carrier ? originalRef : undefined, baseline: null, mutations: [], typechecks: [], scope: baselineComparison ? 'Explicit one-time historical Relay leaf comparison on actual current Host/LocalRelay/DeviceAuthority; not part of the default current-checkout gate.' : carrier ? 'Actual startAgentMuxHost/headless/LocalRelay/attachSocket/DeviceAuthority/Hosted and public SDK/Core, plus original mounted Mobile consumers. Controlled native Runtime I/O, not a real phone or IME.' : 'Actual mounted Viewer and Mobile control/Hosted/E2EE/DeviceAuthority/public dispatcher/Core; deterministic Runtime byte leaf. No real-phone claim.' }
const run = (name, args, env = {}, cwd = root) => {
  console.log(JSON.stringify({ phase: name, mode }))
  const result = spawnSync(process.execPath, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 12 * 1024 * 1024 })
  writeFileSync(join(evidence, name + '.log'), result.stdout + result.stderr)
  return result
}
const tests = (name, mutation, pattern, extraEnv = {}) => {
  const report = name + '.json', loaded = name + '.loaded.ndjson', facts = name + '.facts.ndjson'
  writeFileSync(join(evidence, loaded), ''); writeFileSync(join(evidence, facts), '')
  const result = run(name, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', carrier ? 'packages/core/test/relay-carrier.config.mts' : 'packages/core/test/mobile-terminal-coalescing.config.mts',
    '--reporter=json', '--outputFile', join(evidence, report)], { AGENTMUX_RELAY_INPUT_MUTATION: carrier ? '' : mutation ?? '', HOST_RELAY_CARRIER_MUTATION: carrier ? mutation ?? '' : '',
    AGENTMUX_RELAY_INPUT_PATTERN: pattern ?? '', HOST_RELAY_CARRIER_BASELINE: '', ...extraEnv,
    AGENTMUX_RELAY_INPUT_LOADED: join(evidence, loaded), AGENTMUX_RELAY_INPUT_FACTS: join(evidence, facts) })
  assert.ok(existsSync(join(evidence, report)), name + ' produced no consumer report; inspect ' + name + '.log')
  const proof = { name, report, loaded, facts, exitCode: result.status, reportSHA256: hash(readFileSync(join(evidence, report))), loadedSHA256: hash(readFileSync(join(evidence, loaded))), factsSHA256: hash(readFileSync(join(evidence, facts))) }
  const modules = inspectRun(proof, Boolean(mutation))
  assert.ok(modules.length > 0)
  if (mutation) assert.ok(modules.some(value => value.mutation === mutation && value.servedSHA256 !== value.originalSHA256), 'The exact mutated product source must be consumed')
  else for (const value of modules) receipt.loadedSources[value.path] = value.originalSHA256
  const observations = readFileSync(join(evidence, facts), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  if (pattern !== 'mounted original Viewer') {
    const removed = observations.filter(value => value.kind === 'cleanup')
    assert.ok(removed.length > 0 && removed.every(value => !existsSync(value.rootRemoved)), 'Every actual private Relay/Core root must be removed')
  }
  if (!pattern) {
    assert.equal(observations.filter(value => value.kind === 'mobile-coalesced-burst' && value.writeRequests === 2).length, 2)
    if (carrier) assert.equal(observations.filter(value => value.kind === 'actual-host-mobile-coalescing' && value.nativeCalls === 2 && value.additionalHandshakes === 0).length, 2)
  }
  if (carrier && (!pattern || pattern === 'original topology')) {
    const topology = observations.filter(value => value.kind === 'actual-concurrent-topology')
    assert.deepEqual(topology.map(value => [value.attempted, value.fulfilled, value.rejected, value.afterDispose]), [[64, 64, 0, 0], [193, 128, 65, 0]])
  }
  return proof
}
try {
  if (baselineComparison) {
    receipt.originalTopology = tests('original-main-topology', undefined, 'original topology', { HOST_RELAY_CARRIER_BASELINE: originalRef })
    const loaded = inspectRun(receipt.originalTopology, false)
    for (const path of ['packages/core/src/public-rpc-relay.ts', 'packages/core/src/public-rpc-client.ts', 'packages/core/src/relay-hosted.ts']) {
      const original = execFileSync('git', ['show', originalRef + ':' + path], { cwd: root })
      assert.ok(loaded.some(value => value.path === path && value.baseline === originalRef && value.servedSHA256 === hash(original)), 'Original immutable source was not consumed: ' + path)
    }
  }
  else {
    receipt.baseline = tests('baseline')
  const variants = carrier ? [ ['reopen', 'reuses sequential finite'], ['borrow-busy', 'held native ACK'], ['early-idle', 'actual reader release'],
    ['loose-reply', 'rejects foreign-id|rejects partial-envelope'], ['cancel-peer', 'pending cancellation reaches'],
    ['dispose-idle-leak', 'held native ACK'], ['callback-stops-cleanup', 'original Hosted stream callback failure'],
    ['leaf-callback-stops-cleanup', 'leaf callback failure'], ['retain-extra-idle', 'held native ACK'] ] : [ ['unbatched', '12-event burst'], ['cross-resize', 'keeps original binary'], ['binary-transcode', 'keeps original binary'],
    ['wrong-byte-count', 'keeps original binary'], ['replay-batch', 'retains one original unknown batch'], ['disconnect-viewer', 'mounted original Viewer'] ]
  for (const [mutation, pattern] of variants) {
    const red = tests(mutation + '-red', mutation, pattern), green = tests(mutation + '-restored', undefined, pattern)
    receipt.mutations.push({ mutation, red, green })
  }
  for (const [name, project] of [['mobile-types', 'apps/mobile/tsconfig.json'], ['core-types', 'packages/core/tsconfig.build.json'],
    ...(carrier ? [['host-types', 'apps/host/tsconfig.json']] : [])]) {
    const result = run(name, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--incremental', 'false', '--composite', 'false', '-p', project])
    receipt.typechecks.push({ name, exitCode: result.status }); assert.equal(result.status, 0, name + ': inspect ' + name + '.log')
  }
  if (carrier) {
    const { build } = await import('esbuild')
    const aliases = new Map()
    for (const name of readdirSync(join(root, 'packages'))) {
      const directory = join(root, 'packages', name), manifest = join(directory, 'package.json')
      if (!existsSync(manifest)) continue
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
      for (const [key, value] of Object.entries(pkg.exports ?? {})) {
        const entry = typeof value === 'string' ? value : value?.import
        if (!entry?.startsWith('./dist/')) continue
        const source = resolve(directory, entry.replace(/^\.\/dist\/(?:src\/)?/u, './src/').replace(/\.js$/u, '.ts'))
        if (existsSync(source)) aliases.set(key === '.' ? pkg.name : pkg.name + key.slice(1), source)
      }
    }
    const bundled = await build({ absWorkingDir: root, entryPoints: ['packages/core/src/relay-hosted.ts'], bundle: true, write: false,
      platform: 'browser', format: 'esm', conditions: ['browser', 'module', 'import'], metafile: true, logLevel: 'silent',
      plugins: [{ name: 'actual-browser-source', setup(build) { build.onResolve({ filter: /^@agentmux\// }, args => {
        const path = aliases.get(args.path); return path ? { path } : undefined
      }) } }] })
    const paths = Object.keys(bundled.metafile.inputs)
    assert.ok(paths.includes('packages/core/src/public-rpc-relay.ts'))
    assert.ok(!paths.some(path => /(?:apps\/desktop|node_modules\/(?:react|electron)(?:\/|$))/u.test(path)))
    writeFileSync(join(evidence, 'browser-inputs.json'), JSON.stringify(bundled.metafile, null, 2) + '\n')
    receipt.browserBundle = { exitCode: 0, sourceSHA256: sourceHash('packages/core/src/relay-hosted.ts'), inputCount: paths.length, metafileSHA256: hash(readFileSync(join(evidence, 'browser-inputs.json'))) }
  }
  }
  for (const [path, sha] of Object.entries(receipt.loadedSources)) assert.equal(sourceHash(path), sha, 'Source changed during proof: ' + path)
  assert.deepEqual(Object.fromEntries(verificationInputs.map(path => [path, sourceHash(path)])), inputs)
  receipt.passed = true
} finally {
  rmSync(join(root, carrier ? '.tmp/relay-carrier-test-cache' : '.tmp/relay-input-test-cache'), { recursive: true, force: true })
  if (carrier) rmSync(join(root, '.tmp/relay-carrier-listener.mjs'), { force: true })
  writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + '\n')
}
console.log(JSON.stringify({ passed: true, mutations: receipt.mutations.length, receipt: receiptFile, inputs: Object.keys(receipt.loadedSources).length }))
