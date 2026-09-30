import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(new URL('../../../../..', import.meta.url).pathname)
const sourcePath = resolve(root, 'apps/desktop/scripts/verify-browser-input-history-native-receipt.mjs')
const testPath = resolve(root, 'apps/desktop/scripts/fixtures/browser-input-history/native-consumer.test.mjs')
const output = resolve(process.argv[2] ?? 'docs/reviews/evidence/browser-input-history-native-consumer-source-2026-10-04/attempt-1')
const source = await readFile(sourcePath, 'utf8'), hash = bytes => createHash('sha256').update(bytes).digest('hex')
const helperPath = resolve(root, 'apps/desktop/scripts/browser-input-history-component-evidence.mjs'), helper = await readFile(helperPath)
const mutations = [
  ['false-receipt-native-task-block-flipped',
    "scope: 'readonly-entry-and-original-integrity', passed: false, nativePassed: false, taskComplete: false,\n    adapterImplemented: false",
    "scope: 'readonly-entry-and-original-integrity', passed: true, nativePassed: true, taskComplete: true,\n    adapterImplemented: true"],
  ['cli-nonhelp-success-exit', 'process.exitCode = 2', 'process.exitCode = 0'],
  ['strict-arguments-removed',
    "assert.ok([2, 4].includes(args.length) && args[0] === '--receipt' && typeof args[1] === 'string' && args[1] && !args[1].startsWith('--') &&\n        (args.length === 2 || args[2] === '--visual-review' && typeof args[3] === 'string' && args[3] && !args[3].startsWith('--')),\n        'Only --receipt <original.json> [--visual-review <review.json>] is accepted')", 'void args'],
  ['nonempty-json-guard-removed', "assert.ok(Object.keys(receipt).length > 0, 'Receipt fields are nonempty')", 'void receipt'],
  ['record-type-guard-removed', "assert.ok(receipt && typeof receipt === 'object' && !Array.isArray(receipt), 'A receipt is a nonempty record')", 'void receipt'],
  ['utf8-corruption-accepted', "new TextDecoder('utf-8', { fatal: true }).decode(bytes)", "bytes.toString('utf8')"],
  ['original-digest-replaced', 'sha256: sha(bytes)', "sha256: '0'.repeat(64)"],
  ['reported-true-overwritten', "reportedPassed: receipt.passed === true ? true : receipt.passed === false ? false : 'unknown'", "reportedPassed: 'unknown'"]
]
assert.ok(mutations.length > 0)
await mkdir(output, { recursive: true })
const scratch = await realpath(await mkdtemp(resolve(tmpdir(), 'agentmux-history-native-entry-mutations-')))
const copy = resolve(scratch, 'consumer.mjs')
const packet = { schema: 'agentmux.browser-input-history-native-entry-mutations.v1', passed: false, nativePassed: false,
  taskComplete: false, scope: 'Source-readonly-entry-only', originalSha256: hash(source), copiedSourceBytes: Buffer.byteLength(source), rows: [], scratch }
async function run(label) {
  const result = spawnSync(process.execPath, ['--test', testPath], { cwd: root, encoding: 'utf8', timeout: 15000,
    env: { ...process.env, AGENTMUX_HISTORY_NATIVE_CONSUMER_MODULE: copy, AGENTMUX_HISTORY_NATIVE_REFERENCE_ROOT: root } })
  const log = `${result.stdout}\n${result.stderr}`
  await writeFile(resolve(output, label + '.log'), log)
  return { exit: result.status, signal: result.signal, error: result.error?.message, assertionRed: /ERR_ASSERTION/.test(log), log: label + '.log' }
}
try {
  await writeFile(resolve(scratch, 'browser-input-history-component-evidence.mjs'), helper)
  await writeFile(copy, source)
  await writeFile(resolve(output, 'consumer-original.mjs'), source)
  packet.baseline = await run('baseline-green')
  assert.equal(packet.baseline.exit, 0)
  for (const [id, from, to] of mutations) {
    assert.equal(source.split(from).length - 1, 1, 'One actual Source anchor: ' + id)
    await writeFile(copy, source.replace(from, to))
    const red = await run(id + '-red')
    await writeFile(copy, source)
    const restored = await run(id + '-restored-green')
    packet.rows.push({ id, actualSourceBlock: { from, to }, red, restored })
    assert.notEqual(red.exit, 0, 'Actual mutant is RED: ' + id)
    assert.equal(red.assertionRed, true, 'Behavior Assertion RED, not syntax/infrastructure: ' + id)
    assert.equal(red.signal, null); assert.equal(red.error, undefined)
    assert.equal(restored.exit, 0, 'Original restored GREEN: ' + id)
  }
  assert.equal(hash(await readFile(sourcePath)), packet.originalSha256, 'Production Source was never mutated')
  packet.passed = true
} catch (error) { packet.error = error.message }
finally {
  await rm(scratch, { recursive: true })
  packet.scratchRemoved = true
  await writeFile(resolve(output, 'receipt.json'), JSON.stringify(packet, null, 2) + '\n')
}
process.stdout.write(JSON.stringify({ passed: packet.passed, actualSourceBlocks: packet.rows.length, nativePassed: false,
  taskComplete: false, receipt: resolve(output, 'receipt.json'), scratchRemoved: packet.scratchRemoved }) + '\n')
process.exitCode = packet.passed ? 0 : 1
