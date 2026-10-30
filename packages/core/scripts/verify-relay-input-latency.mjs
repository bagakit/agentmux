import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

assert.deepEqual(process.argv.slice(2), ['--mobile-coalescing'], 'Usage: verify-relay-input-latency.mjs --mobile-coalescing')
const root = fileURLToPath(new URL('../../../', import.meta.url))
const evidence = resolve(process.env.AGENTMUX_RELAY_INPUT_EVIDENCE ?? join(root, '.local/relay-input-latency/mobile-coalescing'))
const receiptFile = join(evidence, 'receipt.json'), hash = value => createHash('sha256').update(value).digest('hex')
const sourceHash = path => hash(readFileSync(join(root, path)))
const verificationInputs = ['packages/core/scripts/verify-relay-input-latency.mjs', 'packages/core/test/mobile-terminal-coalescing.config.mts',
  'packages/core/test/mobile-terminal-coalescing.test.ts', 'packages/core/test/helpers/mobile-relay-owner.ts',
  'apps/mobile/test/terminal-control.test.ts', 'apps/mobile/test/terminal-viewer-initial-binding.test.tsx', 'apps/mobile/src/terminal/control.ts',
  'apps/mobile/src/terminal/MobileTerminalViewer.tsx', 'packages/core/tsconfig.build.json', 'apps/mobile/tsconfig.json', 'tsconfig.base.json']
const inputs = Object.fromEntries(verificationInputs.map(path => [path, sourceHash(path)]))
const inspectRun = (run, red) => {
  const report = JSON.parse(readFileSync(join(evidence, run.report), 'utf8'))
  const assertions = report.testResults.flatMap(file => file.assertionResults).filter(test => test.status !== 'pending' && test.status !== 'skipped')
  assert.ok(assertions.length > 0 && report.numTotalTests > 0, 'Empty consumer evidence cannot pass')
  const failures = assertions.filter(test => test.status === 'failed')
  assert.equal(run.exitCode, red ? 1 : 0)
  assert.equal(failures.length > 0, red)
  if (red) assert.ok(failures.some(test => test.failureMessages.some(message => message.includes('AssertionError'))), 'Only actual business assertion RED qualifies')
  assert.equal(hash(readFileSync(join(evidence, run.report))), run.reportSHA256)
  assert.equal(hash(readFileSync(join(evidence, run.loaded))), run.loadedSHA256)
  assert.equal(hash(readFileSync(join(evidence, run.facts))), run.factsSHA256)
  return readFileSync(join(evidence, run.loaded), 'utf8').trim().split('\n').map(line => JSON.parse(line))
}
try {
  const saved = JSON.parse(readFileSync(receiptFile, 'utf8'))
  assert.equal(saved.passed, true); assert.deepEqual(saved.inputs, inputs)
  assert.equal(saved.mutations.length, 6)
  for (const [path, sha] of Object.entries(saved.loadedSources)) assert.equal(sourceHash(path), sha)
  inspectRun(saved.baseline, false)
  for (const mutation of saved.mutations) { inspectRun(mutation.red, true); inspectRun(mutation.green, false) }
  assert.equal(saved.typechecks.length, 2); assert.ok(saved.typechecks.every(run => run.exitCode === 0))
  console.log(JSON.stringify({ passed: true, reused: true, receipt: receiptFile })); process.exit(0)
} catch { /* A missing/stale candidate must obtain its own exact evidence. */ }

mkdirSync(evidence, { recursive: true })
const receipt = { schema: 'agentmux.relay-input-latency.v1', mode: 'mobile-coalescing', passed: false, inputs, loadedSources: {},
  baseline: null, mutations: [], typechecks: [], scope: 'Actual mounted Viewer and Mobile control/Hosted/E2EE/DeviceAuthority/public dispatcher/Core; deterministic Runtime byte leaf. No real-phone claim.' }
const run = (name, args, env = {}, cwd = root) => {
  const result = spawnSync(process.execPath, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 12 * 1024 * 1024 })
  writeFileSync(join(evidence, name + '.log'), result.stdout + result.stderr)
  return result
}
const tests = (name, mutation, pattern) => {
  const report = name + '.json', loaded = name + '.loaded.ndjson', facts = name + '.facts.ndjson'
  writeFileSync(join(evidence, loaded), ''); writeFileSync(join(evidence, facts), '')
  const result = run(name, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'packages/core/test/mobile-terminal-coalescing.config.mts',
    '--reporter=json', '--outputFile', join(evidence, report)], { AGENTMUX_RELAY_INPUT_MUTATION: mutation ?? '', AGENTMUX_RELAY_INPUT_PATTERN: pattern ?? '',
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
  if (!pattern) assert.equal(observations.filter(value => value.kind === 'mobile-coalesced-burst' && value.writeRequests === 2).length, 2)
  return proof
}
try {
  receipt.baseline = tests('baseline')
  const variants = [ ['unbatched', '12-event burst'], ['cross-resize', 'keeps original binary'], ['binary-transcode', 'keeps original binary'],
    ['wrong-byte-count', 'keeps original binary'], ['replay-batch', 'retains one original unknown batch'], ['disconnect-viewer', 'mounted original Viewer'] ]
  for (const [mutation, pattern] of variants) {
    const red = tests(mutation + '-red', mutation, pattern), green = tests(mutation + '-restored', undefined, pattern)
    receipt.mutations.push({ mutation, red, green })
  }
  for (const [name, project] of [['mobile-types', 'apps/mobile/tsconfig.json'], ['core-types', 'packages/core/tsconfig.build.json']]) {
    const result = run(name, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--incremental', 'false', '--composite', 'false', '-p', project])
    receipt.typechecks.push({ name, exitCode: result.status }); assert.equal(result.status, 0, name + ': inspect ' + name + '.log')
  }
  for (const [path, sha] of Object.entries(receipt.loadedSources)) assert.equal(sourceHash(path), sha, 'Source changed during proof: ' + path)
  assert.deepEqual(Object.fromEntries(verificationInputs.map(path => [path, sourceHash(path)])), inputs)
  receipt.passed = true
} finally {
  rmSync(join(root, '.tmp/relay-input-test-cache'), { recursive: true, force: true })
  writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + '\n')
}
console.log(JSON.stringify({ passed: true, mutations: receipt.mutations.length, receipt: receiptFile, inputs: Object.keys(receipt.loadedSources).length }))
