import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, readdir, cp, rm } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { runProbeProcess, stopProbeProcesses, listProbeProcesses } from './probe-process.mjs'

const root = resolve(import.meta.dirname, '../../..'), evidence = join(root, '.bagakit/feature-tracker/browser-offline-cache-management')
const visual = join(evidence, 'ui-visual'), reportFile = join(evidence, 'ui-verification.json')
await mkdir(visual, { recursive: true })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_)/u.test(key) && key !== 'ELECTRON_RUN_AS_NODE'))
const mutationNames = ['offline-first-key', 'offline-all-first-site', 'offline-stale-target', 'offline-automatic-clear', 'offline-forget-original', 'offline-receipt-regress']
const specs = ['apps/desktop/scripts/verify-browser-offline-cache-reclaim.mjs', 'apps/desktop/scripts/probe-process.mjs',
  ...['performance-reclaim', 'performance-workbench', 'v8-profile-analysis', 'performance-capture', 'vitest.performance-reading'].map(name => `apps/desktop/test/${name}.config.mts`),
  'apps/desktop/scripts/fixtures/performance-panel/vitest.config.mts', 'apps/desktop/scripts/fixtures/settings-overview/vitest.config.mts', 'vitest.setup.ts',
  ...['core', 'relay', 'demand', 'client-ui', 'identity', 'diagnostic-evidence'].map(name => `packages/${name}/package.json`),
  'apps/host/package.json', 'apps/desktop/package.json', 'pnpm-lock.yaml']
const specification = { node: process.versions.node, platform: process.platform, arch: process.arch,
  ...Object.fromEntries(await Promise.all(specs.map(async file => [file, hash(await readFile(join(root, file)))]))) }
const report = { passed: false, boundary: 'Actual production Renderer and CSS with controlled typed Profile inputs; Main/native effects are qualified separately by verify-browser-offline-cache.mjs. No user cache deletion or installed App qualification.', specification, tests: [], visual: null, cleanup: [] }
const save = () => writeFile(reportFile, JSON.stringify(report, null, 2) + '\n')
let directory
async function run(args, overrides = {}, timeoutMs = 90000) {
  const logs = [], result = await runProbeProcess(process.execPath, args, { cwd: root, env: { ...env, ...overrides }, timeoutMs, onLine: line => logs.push(line) })
  return { result, logs }
}
async function currentVisual() {
  try {
    const receipt = JSON.parse(await readFile(join(visual, 'receipt.json'), 'utf8'))
    if (!receipt.passed || !receipt.capture.offlineNativeInputQualified || !receipt.capture.cleanup.windowDestroyed) return null
    const frames = receipt.capture.frames, offline = frames.filter(frame => frame.name.startsWith('offline-'))
    if (!Object.keys(receipt.sources).length || !frames.length || offline.length !== 6 || new Set(offline.map(frame => frame.name)).size !== 6 || new Set(offline.map(frame => frame.file)).size !== 6) return null
    for (const required of ['apps/desktop/src/renderer/src/components/performance/BrowserOfflineCache.tsx', 'apps/desktop/src/renderer/src/styles/performance-toolkit.css', 'apps/desktop/scripts/fixtures/performance-reclaim/main.cjs']) if (!receipt.sources[required]) return null
    for (const [file, input] of Object.entries(receipt.sources)) {
      const path = resolve(root, file)
      if (!path.startsWith(root + '/') || hash(await readFile(path)) !== input.file) return null
    }
    for (const frame of receipt.capture.frames) if (hash(await readFile(join(visual, frame.file))) !== frame.sha256) return null
    return receipt
  } catch { return null }
}
// Reuse only original successful runs with every consumed source and proof byte unchanged.
// This keeps a concurrent unrelated repository edit from requiring another native capture.
async function reusableProof() {
  try {
    const previous = JSON.parse(await readFile(reportFile, 'utf8'))
    if (!previous.passed || JSON.stringify(previous.specification) !== JSON.stringify(specification) || JSON.stringify(previous.tests.map(test => test.name).sort()) !== JSON.stringify([...mutationNames, 'restored'].sort()) || !await currentVisual()) return false
    const sources = new Map()
    for (const test of previous.tests) {
      const input = await readFile(join(evidence, `ui-${test.name}-inputs.jsonl`)), log = await readFile(join(evidence, `ui-${test.name}.log`))
      if (hash(input) !== test.inputsSha256 || hash(log) !== test.logSha256) return false
      for (const row of input.toString().trim().split('\n').map(line => JSON.parse(line))) {
        if (sources.has(row.path) && sources.get(row.path) !== row.source) return false
        sources.set(row.path, row.source)
      }
    }
    if (!sources.size) return false
    for (const [file, digest] of sources) if (!resolve(root, file).startsWith(root + '/') || hash(await readFile(join(root, file))) !== digest) return false
    return true
  } catch { return false }
}
if (await reusableProof()) { console.log('Reused original offline UI proof: specification, all consumed sources, mutation logs, native source bindings and complete PNGs match.'); process.exit(0) }
try {
  for (const name of [...mutationNames, 'restored']) {
    const input = join(evidence, `ui-${name}-inputs.jsonl`)
    await writeFile(input, '')
    const { result, logs } = await run([join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'apps/desktop/test/performance-reclaim.config.mts', 'apps/desktop/test/browser-offline-cache-reclaim.test.tsx', '--maxWorkers=1'], {
      AGENTMUX_RECLAIM_INPUTS: input, ...(name === 'restored' ? {} : { AGENTMUX_RECLAIM_MUTATION: name })
    })
    await writeFile(join(evidence, `ui-${name}.log`), logs.join('\n'))
    const inputs = (await readFile(input, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    assert.ok(inputs.length, 'Nonempty actual product source consumption')
    if (name === 'restored') { assert.equal(result.exitCode, 0, logs.join('\n')); assert.ok(inputs.every(input => !input.mutated)) }
    else {
      assert.equal(result.exitCode, 1, logs.join('\n'))
      assert.ok(inputs.some(input => input.mutated && input.path.endsWith('/BrowserOfflineCache.tsx')), 'Actual selected UI mutation was consumed')
      assert.match(logs.join('\n'), /AssertionError/u, 'Mutation must reach a semantic assertion, not a collection failure')
    }
    assert.equal(result.timedOut, false)
    report.tests.push({ name, result, inputsSha256: hash(await readFile(input)), logSha256: hash(logs.join('\n')) }); await save()
    console.log(`Offline UI ${name}: ${result.exitCode}`)
  }
  let receipt = await currentVisual()
  const reused = Boolean(receipt)
  if (!receipt) {
    const prepared = await promisify(execFile)(process.execPath, [join(root, 'apps/desktop/scripts/capture-performance-reclaim.mjs'), '--prepare'], { cwd: root, env, maxBuffer: 2 * 1024 * 1024 })
    const metadata = prepared.stdout.split('\n').map(line => { try { return JSON.parse(line) } catch { return null } }).find(value => value?.prepared)
    assert.ok(metadata?.directory)
    directory = resolve(metadata.directory)
    assert.ok(directory.startsWith(join(root, '.tmp/performance-reclaim/native-')))
    const captured = await run([join(root, 'apps/desktop/scripts/capture-performance-reclaim.mjs'), '--run', directory])
    assert.equal(captured.result.exitCode, 0, captured.logs.join('\n'))
    receipt = JSON.parse(await readFile(join(directory, 'receipt.json'), 'utf8'))
    for (const entry of await readdir(directory)) if (/\.png$/u.test(entry) || ['source.json', 'capture.json', 'receipt.json', 'native.log'].includes(entry)) await cp(join(directory, entry), join(visual, entry))
  }
  assert.equal(receipt.passed, true); assert.equal(receipt.capture.offlineNativeInputQualified, true)
  assert.equal(receipt.capture.cleanup.windowDestroyed, true)
  const frames = receipt.capture.frames.filter(frame => frame.name.startsWith('offline-'))
  assert.equal(frames.length, 6)
  report.visual = { directory: relative(root, visual), reused, receiptSha256: hash(await readFile(join(visual, 'receipt.json'))), frames: frames.map(frame => ({ name: frame.name, sha256: frame.sha256 })) }
  report.passed = true
} finally {
  if (directory) {
    const receipt = JSON.parse(await readFile(join(directory, 'receipt.json'), 'utf8').catch(() => '{}'))
    if (receipt.outcome?.originalPid) await stopProbeProcesses(receipt.outcome.originalPid, directory)
    const remaining = receipt.outcome?.originalPid ? await listProbeProcesses(receipt.outcome.originalPid, directory) : []
    if (!remaining.length) { await rm(directory, { recursive: true, force: true }); report.cleanup.push({ directory, removed: true }) }
    else report.cleanup.push({ directory, removed: false, remaining })
  }
  await save()
}
assert.equal(report.passed, true)
console.log('Offline cache UI mutations and actual Renderer interaction passed; compiled/native temporary data removed. Independent full-image review remains separate.')
