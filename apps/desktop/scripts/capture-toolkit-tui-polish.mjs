import assert from 'node:assert/strict'
import { resolve, isAbsolute } from 'node:path'
import { captureTuiToolkit } from './fixtures/toolkit-tui/capture.mjs'

const args = process.argv.slice(2)
assert.ok(args.length === 2 && args[0] === '--evidence' && isAbsolute(args[1]), 'Use --evidence absolute-path')
const receipt = await captureTuiToolkit({ root: resolve(import.meta.dirname, '../../..'), evidence: args[1], toolkitScene: 'polish' })
assert.equal(receipt.completed, true, JSON.stringify(receipt.failure))
assert.equal(receipt.sourceCurrentReadbackExact, true)
assert.equal(receipt.actualTerminalView, true)
assert.equal(receipt.frames.length, 9)
assert.deepEqual(receipt.remainingPrivateProcesses, [])
assert.equal(receipt.nativeCleanupConfirmed, true)
assert.equal(receipt.privateRootRemoved, true)
console.log(JSON.stringify({ completed: true, frames: receipt.frames, sourceIdentity: receipt.sourceIdentity, boundary: receipt.boundary }))
