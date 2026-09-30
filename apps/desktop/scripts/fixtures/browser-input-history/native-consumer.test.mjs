import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { after, before, test } from 'node:test'

const root = resolve(process.env.AGENTMUX_HISTORY_NATIVE_REFERENCE_ROOT ?? new URL('../../../../..', import.meta.url).pathname)
const modulePath = process.env.AGENTMUX_HISTORY_NATIVE_CONSUMER_MODULE ?? resolve(root, 'apps/desktop/scripts/verify-browser-input-history-native-receipt.mjs')
const consumer = await import(pathToFileURL(modulePath).href)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const nodeProofPath = resolve(root, 'docs/reviews/evidence/browser-input-history-main-source-2026-10-04/attempt-1/two-process-durable.json')
const foreignPath = resolve(root, 'docs/reviews/evidence/browser-operation-pointer-motion-native-2026-10-04/attempt-4/first-receipt.json')
const nodeBytes = await readFile(nodeProofPath), foreignBytes = await readFile(foreignPath)
let scratch
before(async () => { scratch = await mkdtemp(resolve(tmpdir(), 'agentmux-history-native-consumer-own-')) })
after(async () => { await rm(scratch, { recursive: true }); assert.equal(hash(await readFile(nodeProofPath)), hash(nodeBytes)); assert.equal(hash(await readFile(foreignPath)), hash(foreignBytes)) })
async function original(name, bytes) {
  await writeFile(resolve(scratch, name), bytes)
  return { path: name, bytes: bytes.length, sha256: hash(bytes) }
}
function noNative(report) {
  assert.equal(report.passed, false); assert.equal(report.nativePassed, false); assert.equal(report.taskComplete, false)
  assert.equal(report.adapterImplemented, false); assert.deepEqual(report.actions, [])
  assert.ok(report.missing.length > 0); assert.match(report.missing[0], /internal TODO/)
}

test('registered actual CLI refuses missing receipt, unknown flags and Node Source, without touching originals', () => {
  for (const [args, expected] of [
    [['--receipt', 'docs/reviews/evidence/browser-input-history-native/receipt.json'], 'pending'],
    [['--unused', nodeProofPath], 'rejected'], [['--receipt', nodeProofPath], 'unsupported']
  ]) {
    const run = spawnSync(process.execPath, [modulePath, ...args], { cwd: root, encoding: 'utf8', timeout: 10000 })
    assert.equal(run.error, undefined); assert.equal(run.status, 2); assert.equal(run.signal, null)
    const report = JSON.parse(run.stdout); noNative(report); assert.equal(report.outcome, expected)
  }
})

test('empty arguments stay pending, and every malformed argument set is rejected', async () => {
  const empty = await consumer.verifyInputHistoryNativeReceipt([]); noNative(empty); assert.equal(empty.outcome, 'pending')
  for (const args of [['--receipt'], ['--receipt', '--unused'], ['--unused', nodeProofPath], ['--receipt', nodeProofPath, '--extra']]) {
    const report = await consumer.verifyInputHistoryNativeReceipt(args); noNative(report)
    assert.equal(report.outcome, 'rejected'); assert.match(report.reason, /Only --receipt/); assert.equal(report.evidence, null)
  }
})

test('actual Node and foreign failed Native originals are unsupported, with exact original identity preserved', async () => {
  for (const [path, bytes] of [[nodeProofPath, nodeBytes], [foreignPath, foreignBytes]]) {
    const raw = JSON.parse(bytes), report = await consumer.verifyInputHistoryNativeReceipt(['--receipt', path])
    noNative(report); assert.equal(report.outcome, 'unsupported')
    assert.deepEqual(report.evidence, { path, bytes: bytes.length, sha256: hash(bytes), producerSchema: raw.schema ?? null, reportedPassed: raw.passed })
  }
})

test('a JSON success flag or unknown/false result cannot certify Native', async () => {
  // Boolean probes only; no fabricated complete Native packet.
  for (const [value, reported] of [[true, true], [false, false], ['unknown', 'unknown'], [undefined, 'unknown']]) {
    const row = await original('boolean.json', Buffer.from(JSON.stringify({ schema: 'source-boolean-probe-only', passed: value })))
    const report = await consumer.verifyInputHistoryNativeReceipt(['--receipt', resolve(scratch, row.path)])
    noNative(report); assert.equal(report.outcome, 'unsupported'); assert.equal(report.evidence.reportedPassed, reported)
  }
})

test('missing, malformed and empty receipt records are never success', async () => {
  const missing = await consumer.verifyInputHistoryNativeReceipt(['--receipt', resolve(scratch, 'missing.json')])
  noNative(missing); assert.equal(missing.outcome, 'pending')
  for (const text of ['{', '{}', '[]', '[{"passed":true}]', 'null', 'true']) {
    const row = await original('invalid.json', Buffer.from(text))
    const report = await consumer.verifyInputHistoryNativeReceipt(['--receipt', resolve(scratch, row.path)])
    noNative(report); assert.equal(report.outcome, 'rejected'); assert.equal(report.evidence, null)
  }
  const invalidUtf8 = await original('invalid-utf8.json', Buffer.concat([Buffer.from('{"value":"'), Buffer.from([0xff]), Buffer.from('"}')]))
  const rejected = await consumer.verifyInputHistoryNativeReceipt(['--receipt', resolve(scratch, invalidUtf8.path)])
  noNative(rejected); assert.equal(rejected.outcome, 'rejected'); assert.equal(rejected.evidence, null)
})
