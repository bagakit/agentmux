import assert from 'node:assert/strict'

// Reuse the real Desktop Main/Renderer/Browser and ordinary recovery probe.
// No isolated owner fixture can substitute for this product-facing file gate.
assert.deepEqual(process.argv.slice(2), ['--case', 'download'])
process.argv.push('--case-download')
await import('./verify-browser-recovery-restart.mjs')
