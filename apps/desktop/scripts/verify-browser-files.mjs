import assert from 'node:assert/strict'

// Reuse the real Desktop Main/Renderer/Browser and ordinary recovery probe.
// No isolated owner fixture can substitute for this product-facing file gate.
assert.equal(process.argv.length,4)
assert.equal(process.argv[2],'--case')
assert.ok(['download','upload'].includes(process.argv[3]))
process.argv.push(`--case-${process.argv[3]}`)
await import('./verify-browser-recovery-restart.mjs')
