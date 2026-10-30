// Task-specific entry; compile-only is a development aid and never emits a passing receipt.
import assert from 'node:assert/strict'
assert.ok(process.argv.includes('--dispatch'), 'Select the approved dispatch slice')
assert.ok(process.argv.slice(2).every(arg => ['--dispatch', '--compile-only'].includes(arg)), 'Unknown proof option')
await import('./verify-durable-direct-resume.mjs')
