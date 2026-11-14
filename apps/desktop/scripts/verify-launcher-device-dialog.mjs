import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const evidenceRoot = resolve(root, '.tmp/launcher-device-dialog-verify')
mkdirSync(evidenceRoot, { recursive: true })
const runDirectory = mkdtempSync(join(evidenceRoot, 'run-'))
const receiptPath = join(runDirectory, 'receipt.json')
const ORACLE_FILES = [
  'apps/desktop/scripts/capture-space-launcher.mjs',
  'apps/desktop/scripts/verify-launcher-device-dialog.mjs',
  'apps/desktop/scripts/fixtures/space-launcher/main.cjs',
  'apps/desktop/scripts/fixtures/space-launcher/region-workflow.cjs',
  'apps/desktop/scripts/fixtures/space-launcher/entry.tsx',
  'apps/desktop/scripts/fixtures/launcher-launchpad/entry.tsx',
  'apps/desktop/scripts/fixtures/space-launcher/index.html',
  'apps/desktop/scripts/fixtures/launcher-launchpad/index.html',
  'apps/desktop/scripts/fixtures/launcher-launchpad/vitest.owning.config.mts',
  'apps/desktop/scripts/fixtures/bookmark-local-link/vitest.owning.config.mts',
  'apps/desktop/scripts/probe-process.mjs',
  'apps/desktop/scripts/radix-overlay-aliases.ts',
  'apps/desktop/scripts/lib/fixture-values.mjs',
  'apps/desktop/test/helpers/client-ui-render.tsx',
  'packages/core/package.json',
  'packages/demand/package.json',
  'packages/layout/package.json',
  'packages/client-ui/package.json',
  'apps/host/package.json',
]
const receipt = { schema: 'agentmux.launcher-device-dialog-verification.v2', passed: false,
  gate: 'Only this independent device-dialog gate proves this slice; the generic Launcher receipt does not cover it.',
  run: { id: basename(runDirectory), directory: relative(root, runDirectory) }, cases: [] }

function capture(name, mutation = null) {
  const output = join(runDirectory, name)
  mkdirSync(output, { recursive: true })
  const env = { ...process.env }
  if (mutation) env.LAUNCHER_AFFORDANCE_MUTATION = mutation
  else delete env.LAUNCHER_AFFORDANCE_MUTATION
  const oracleBefore = oracleDigest()
  const result = spawnSync(process.execPath, ['apps/desktop/scripts/capture-space-launcher.mjs', relative(root, output), '--region-workflow'], {
    cwd: root, env, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 180_000,
  })
  const oracleAfter = oracleDigest()
  writeFileSync(join(output, 'driver.log'), (result.stdout ?? '') + (result.stderr ?? ''))
  assert.ifError(result.error)
  const captureReceipt = JSON.parse(readFileSync(join(output, 'receipt.json'), 'utf8'))
  for (const file of readdirSync(output)) {
    if (file.startsWith('workflow-') && file.endsWith('.png')) unlinkSync(join(output, file))
  }
  assert.equal(oracleAfter, oracleBefore, `${name}: oracle changed during capture`)
  return { name, mutation, status: result.status, captureReceipt, oracleDigest: oracleBefore }
}

function digest(value) {
  const sources = Object.fromEntries(Object.entries(value.captureReceipt.sources ?? {}).sort(([a], [b]) => a.localeCompare(b)))
  const styles = Object.fromEntries(Object.entries(value.captureReceipt.styles ?? {}).sort(([a], [b]) => a.localeCompare(b)))
  return createHash('sha256').update(JSON.stringify({ sources, styles })).digest('hex')
}

function oracleDigest() {
  const hash = createHash('sha256')
  for (const file of ORACLE_FILES) hash.update(file).update('\0').update(readFileSync(join(root, file), 'utf8')).update('\0')
  return hash.digest('hex')
}

function record(value) {
  receipt.cases.push({ name: value.name, mutation: value.mutation, status: value.status,
    passed: value.captureReceipt.passed, candidateDigest: digest(value), oracleDigest: value.oracleDigest, mutationHits: value.captureReceipt.mutationHits,
    failure: value.captureReceipt.ui?.failure ?? value.captureReceipt.failure ?? null,
    receipt: relative(root, join(runDirectory, value.name, 'receipt.json')) })
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n')
}

function assertMutationUsesBaseline(value, baseline) {
  assert.deepEqual(value.captureReceipt.sources, baseline.captureReceipt.sources, `${value.name}: all production sources must equal the baseline candidate`)
  assert.deepEqual(value.captureReceipt.styles, baseline.captureReceipt.styles, `${value.name}: all production styles must equal the baseline candidate`)
  assert.equal(value.oracleDigest, baseline.oracleDigest, `${value.name}: probe and oracle files must equal the baseline`)
  for (const hit of value.captureReceipt.mutationHits) {
    const family = hit.file.endsWith('.css') ? 'styles' : 'sources'
    const original = baseline.captureReceipt[family]?.[hit.file]
    assert.ok(original, `${value.name}: baseline does not contain the mutated production module ${hit.file}`)
    assert.equal(hit.original, original, `${value.name}: mutation original must match the baseline candidate ${hit.file}`)
  }
}

const mutations = [
  { name: 'dialog-root-scroll', expected: ['Location Cancel and Apply are visible before any scrolling', 'The anchored editor root does not own a scrolling page', 'The header keeps its exact geometry', 'The footer keeps its exact geometry'] },
  { name: 'dialog-body-height', expected: ['Location Cancel and Apply are visible before any scrolling', 'Only the arrangement body scrolls after expanding complete details', 'The anchored editor root does not own a scrolling page'] },
  { name: 'dialog-footer-order', expected: ['Custom startup action stays inside progressive details'] },
  { name: 'dialog-path-disclosure', expected: ['Complete original project path is disclosed without clamping'] },
  { name: 'dialog-menu-boundary', expected: ['Overlay height stays in its original Region'] },
  { name: 'dialog-device-tail', expected: ['Every configured Agent device remains available'] },
  { name: 'dialog-device-scroll', expected: ['Native scrolling reaches the last configured Agent device'] },
]

try {
  const baseline = capture('baseline')
  record(baseline)
  assert.equal(baseline.status, 0, 'Baseline driver must complete')
  assert.equal(baseline.captureReceipt.exitCode, 0, 'Baseline capture must complete')
  assert.equal(baseline.captureReceipt.passed, true, 'The accepted production candidate must pass before mutation')
  for (const mutation of mutations) {
    const value = capture(mutation.name, mutation.name)
    record(value)
    assert.notEqual(value.status, 0, `${mutation.name}: driver must report the counterexample`)
    assert.notEqual(value.captureReceipt.exitCode, 0, `${mutation.name}: capture must report the counterexample`)
    assert.equal(value.captureReceipt.passed, false, `${mutation.name}: the counterexample must not pass`)
    assert.equal(value.captureReceipt.mutation, mutation.name, `${mutation.name}: exact mutation identity`)
    assert.equal(value.captureReceipt.mutationHits.length, 1, `${mutation.name}: mutate exactly one production source`)
    assertMutationUsesBaseline(value, baseline)
    const failure = value.captureReceipt.ui?.failure?.message ?? ''
    assert.ok(mutation.expected.some(text => failure.includes(text)), `${mutation.name}: expected a bearing assertion, received: ${failure || 'no renderer assertion'}`)
  }
  const restored = capture('restored')
  record(restored)
  assert.equal(restored.status, 0, 'Restored driver must complete')
  assert.equal(restored.captureReceipt.exitCode, 0, 'Restored capture must complete')
  assert.equal(restored.captureReceipt.passed, true, 'Restoring the production implementation must return to green')
  assert.deepEqual(restored.captureReceipt.sources, baseline.captureReceipt.sources, 'Restored sources must equal the exact baseline candidate')
  assert.deepEqual(restored.captureReceipt.styles, baseline.captureReceipt.styles, 'Restored styles must equal the exact baseline candidate')
  assert.equal(restored.oracleDigest, baseline.oracleDigest, 'Restored probe and oracle files must equal the baseline')
  receipt.source = { candidateDigest: digest(baseline), oracleDigest: baseline.oracleDigest, sources: baseline.captureReceipt.sources, styles: baseline.captureReceipt.styles }
  receipt.passed = true
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, receipt: relative(root, receiptPath) }))
} catch (error) {
  receipt.failure = { message: error instanceof Error ? error.message : String(error) }
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n')
  console.error(JSON.stringify({ passed: false, receipt: relative(root, receiptPath), failure: receipt.failure }))
  process.exitCode = 1
}
