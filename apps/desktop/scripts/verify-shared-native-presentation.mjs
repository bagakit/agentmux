import assert from 'node:assert/strict'

// This command is bounded capability research, never product multi-presentation.
assert.deepEqual(process.argv.slice(2), ['--slice', 'capability'], 'Explicit bounded capability slice')
await import('./fixtures/shared-native-presentation-capability/browser-pane-proof.mjs')
