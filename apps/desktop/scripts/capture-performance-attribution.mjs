import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { capturePerformancePanel } from './fixtures/performance-panel/capture.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const args = process.argv.slice(2)
const prepareOnly = args[0] === '--prepare-only'
if (prepareOnly) args.shift()
assert.ok(args.length === 0 || args.length === 2 && args[0] === '--evidence' && path.isAbsolute(args[1]),
  'Use optional --prepare-only followed by an explicit absolute --evidence directory, or defaults')
const evidence = args[1] ?? path.join(root, ".local/state/performance-attribution-fixture/ui-captures", ("" + (prepareOnly ? 'prepare' : 'run') + "-" + (globalThis.crypto.randomUUID()) + ""))
const receipt = await capturePerformancePanel({ root, evidence, captureScope: 'attribution', prepareOnly })
assert.equal(receipt.captureScope, 'attribution')
assert.equal(receipt.completed, true, 'Bounded actual App attribution capture must pass; see ' + evidence)
assert.equal(receipt.sourceCurrentReadbackExact, true, 'Actual capture inputs remain exact')
assert.equal(receipt.officialOwnerQualification, false, 'This capture does not substitute for public resource qualification')
assert.deepEqual(receipt.remainingPrivateProcesses, [])
assert.equal(receipt.privateRootRemoved, true)
assert.ok(receipt.inputs['apps/desktop/src/renderer/src/components/performance/PerformanceAttribution.tsx'], 'Actual product attribution source is loaded')
if (prepareOnly) {
  assert.equal(receipt.actualApp, false)
  assert.deepEqual(receipt.processes, [])
  assert.deepEqual(receipt.frames, [])
  console.log(JSON.stringify({ prepared: true, evidence, sourceIdentity: receipt.sourceIdentity,
    boundary: 'Exact product source compilation only; no App mount, screenshot or behavioral acceptance.' }))
  process.exit(0)
}
assert.equal(receipt.actualApp, true)
assert.deepEqual(receipt.processes.map(value => value.phase), ['attribution'], 'Only one bounded private phase runs')
assert.equal(receipt.processes[0].timedOut, false)
assert.equal(receipt.processes[0].exitCode, 0)
const raw = JSON.parse(await readFile(path.join(evidence, 'attribution-render.json'), 'utf8'))
assert.equal(raw.qualificationScope, 'resource-attribution-only')
assert.equal(raw.qualified, true)
assert.equal(raw.afterDisposalLeases, 0)
assert.equal(raw.rendererMemoryProof.strictCoreParserPassed, true)
assert.equal(raw.rendererMemoryProof.sandbox, true)
assert.equal(raw.rendererMemoryProof.contextIsolation, true)
assert.deepEqual(receipt.frames.map(frame => frame.file), [
  '1480-dark-attribution.png', '1480-dark-work-wait.png', '380-light-attribution.png',
  '380-light-attribution-stale.png', '1480-dark-attribution-unknown.png', '1480-dark-attribution-paused.png'
])
assert.ok(raw.nativeEvents.some(event => event.isTrusted && event.key === 'Tab'), 'Native keyboard positive control is nonempty')
assert.ok(raw.nativeEvents.some(event => event.isTrusted && event.key === 'Enter'), 'Native keyboard expands actual details')
console.log(JSON.stringify({ completed: true, evidence, frames: receipt.frames.length, sourceIdentity: receipt.sourceIdentity,
  boundary: 'Actual App attribution screenshots and bounded UI interactions; independent visual review and same-candidate public resource gate are separate.' }))
