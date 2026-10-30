// Task-specific entry; compile-only is a development aid and never emits a passing receipt.
import assert from 'node:assert/strict'
assert.equal(Number(process.argv.includes('--dispatch')) + Number(process.argv.includes('--resolution')), 1, 'Select one approved prepared resume slice')
assert.ok(process.argv.slice(2).every(arg => ['--dispatch', '--resolution', '--compile-only'].includes(arg)), 'Unknown proof option')
await import('./verify-durable-direct-resume.mjs')
