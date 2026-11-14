import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
// Each bounded presentation mutation must turn exactly its bearing Chromium assertion red; a build,
// load or timeout failure is not mutation proof. Usage: verify-capture-mutations.mjs --<subset> <id>...
const root = resolve(import.meta.dirname, '../../../../..'), capture = resolve(import.meta.dirname, 'capture-ui.mjs')
const bearing = {
  'connection-inline-notice': 'Connection diagnostics never insert a row above the original reader',
  'metadata-bottom-notice': 'Metadata diagnostics never insert a bottom service row',
  'focus-attention-rail': 'Focus attention cards have no decorative side rail',
  'interaction-attention-rail': 'Interaction cards have no decorative side rail or duplicate outline',
  'header-extra-pixel': 'mote-main keeps one 52px header',
  'dismiss-button-highlight': 'Dismiss has no inherited button highlight',
  'narrow-avatar-hidden': 'Narrow headers retain the original identity avatar',
  'actions-always-visible': 'An unchosen message shows no copy or details icons on touch',
  'human-bubble-icons': "The person's bubble carries no icon row at rest",
  'dismiss-small-hit': 'Dismiss keeps a 44px touch target'
}
const subset = process.argv.slice(2).find(value => value.startsWith('--'))
const ids = process.argv.slice(2).filter(value => !value.startsWith('--'))
assert.ok(subset && ids.length, 'A capture subset and at least one mutation id are required')
for (const id of ids) assert.ok(bearing[id], 'Known mutation with a bearing assertion: ' + id)
const directory = resolve(root, '.local/state/mobile-capture-mutations', randomUUID())
const sha = value => createHash('sha256').update(value).digest('hex')
const receipt = { schema: 'agentmux.mobile-capture-mutations.v1', passed: false, subset, runs: [],
  scope: 'Actual MobileApp in private Electron Chromium with CDP touch; each mutation is a private load-time source override. Physical phones and live Hosts are separate evidence.' }
await mkdir(directory, { recursive: true })
const run = args => new Promise((accept, reject) => {
  const child = spawn(process.execPath, [capture, subset, ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '', log = ''
  child.stdout.on('data', value => { out += value; log += value }); child.stderr.on('data', value => { log += value })
  child.once('error', reject); child.once('close', (code, signal) => accept({ code, signal, out, log }))
})
try {
  for (const label of ['baseline', ...ids, 'restored']) {
    const result = await run(['baseline', 'restored'].includes(label) ? [] : ['--mutation=' + label])
    await writeFile(resolve(directory, label + '.log'), result.log)
    assert.equal(result.signal, null)
    const receiptFile = result.out.trim().split('\n').findLast(line => line.endsWith('receipt.json'))
    assert.ok(receiptFile, 'The capture wrote its receipt: ' + label)
    const captured = JSON.parse(await readFile(resolve(root, receiptFile), 'utf8'))
    if (['baseline', 'restored'].includes(label)) {
      assert.equal(result.code, 0, result.log); assert.equal(captured.passed, true)
    } else {
      const override = captured.sourceOverride, error = captured.renderer?.error
      assert.notEqual(result.code, 0, 'Mutated presentation must fail its Chromium assertion: ' + label)
      assert.equal(captured.passed, false); assert.equal(captured.renderer?.passed, false, 'The failure comes from the renderer scenario')
      assert.equal(override?.id, label); assert.notEqual(override.sha256, override.originalSha256)
      assert.equal(captured.loadedSource[override.file], override.sha256, 'The mutated bytes were the ones the product loaded')
      assert.ok(error?.stack?.startsWith('AssertionError'), 'Only an assertion is mutation proof: ' + error?.message)
      assert.ok(error.message.startsWith(bearing[label]), `Fails its bearing assertion, not another: ${error.message}`)
    }
    receipt.runs.push({ label, exitCode: result.code, receipt: receiptFile, receiptSHA256: sha(await readFile(resolve(root, receiptFile))),
      failure: captured.renderer?.error?.message ?? null, sourceOverride: captured.sourceOverride ?? null })
    process.stdout.write(JSON.stringify({ label, exitCode: result.code }) + '\n')
  }
  receipt.passed = true
} catch (error) { receipt.error = { message: error.message, stack: error.stack }; process.exitCode = 1 }
await writeFile(resolve(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
process.stdout.write(JSON.stringify({ passed: receipt.passed, receipt: relative(root, resolve(directory, 'receipt.json')) }) + '\n')
