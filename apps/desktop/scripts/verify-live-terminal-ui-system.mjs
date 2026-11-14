import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../../..')
const evidenceRoot = path.join(root, '.local/state/terminal-ui-system')
mkdirSync(evidenceRoot, { recursive: true })
const mutation = process.argv.includes('--mutation')
const evidence = mkdtempSync(path.join(evidenceRoot, mutation ? 'routed-unrelated-' : 'private-terminal-'))
const run = spawnSync(process.execPath, [path.join(import.meta.dirname, 'verify-conversation-progressive-reading.mjs'), evidence,
  '--terminal-neighbor', ...(mutation ? ['--terminal-scope-mutation'] : [])], { cwd: root, stdio: 'inherit' })
if (run.error) throw run.error
const receipt = JSON.parse(readFileSync(path.join(evidence, 'receipt.json'), 'utf8'))
assert.equal(receipt.executed, true, 'The actual Electron and private Runtime must execute the terminal scene')
assert.deepEqual(receipt.inputDrift, [])
assert.equal(receipt.cleanup.privateRootRemoved, true)
assert.deepEqual(receipt.cleanup.errors, [])
assert.deepEqual(receipt.cleanup.remaining, [])
assert.ok(receipt.terminalPreload?.productionSHA256)
assert.ok(receipt.loaded.some(input => input.browser && input.path.endsWith('/TerminalView.tsx')))
assert.ok(receipt.loaded.some(input => input.browser && input.path.endsWith('/ActivityView.tsx')))
if (mutation) {
  assert.notEqual(run.status, 0)
  assert.ok(receipt.loaded.some(input => input.path.endsWith('/session-events.ts') &&
    input.mutation === 'cross-run-terminal-delivery' && input.loadedSHA256 !== input.originalSHA256))
  assert.match(receipt.phases[0].actual.failure.message, /No unrelated Run may reach a scoped renderer consumer/u)
} else {
  assert.equal(run.status, 0, receipt.failure?.message)
  assert.equal(receipt.passed && receipt.sourceBound, true)
  assert.equal(receipt.phases[0].actual.nativeTerminal.live.state, 'running')
}
console.log(JSON.stringify({ passed: true, intentionalMutation: mutation, receipt: path.relative(root, path.join(evidence, 'receipt.json')) }))
