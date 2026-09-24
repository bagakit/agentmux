import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

// The sole canonical harness owns launch, recovery, source identity and cleanup.
assert.equal(process.argv.length, 2)
process.argv.push('--case-frames')
await import('./verify-browser-recovery-restart.mjs')
const receipt = JSON.parse(await readFile(join(resolve(import.meta.dirname, '../../..'), '.tmp/browser-frame-observation-last.json'), 'utf8'))
assert.equal(receipt.case, 'frames'); assert.equal(receipt.passed, true); assert.equal(receipt.completeGate, true)
assert.equal(receipt.frames?.complete, true); assert.equal(receipt.frames.sameEvidenceAfterRestart, true)
assert.equal(receipt.frames.noActionReplay, true); assert.equal(receipt.frames.physicalDeviceTested, false)
assert.ok(receipt.frames.operations.length > 0)
assert.deepEqual(receipt.identityBefore, receipt.identityAfter)
assert.equal(receipt.cleanup.privateProcessesReaped, true); assert.equal(receipt.cleanup.temporaryRootRemoved, true)
