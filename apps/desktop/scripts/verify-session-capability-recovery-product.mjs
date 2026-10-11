import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '../../..')
const captureOnly = process.argv.includes('--capture')
const output = path.resolve(process.argv.slice(2).find(one => !one.startsWith('--')) ?? path.join(root, '.tmp/session-capability-recovery/product'))
const hash = value => createHash('sha256').update(value).digest('hex')
const helper = path.join(import.meta.dirname, 'session-capability-evidence.mjs')
const self = new URL(import.meta.url).pathname
const pins = async () => Object.fromEntries(await Promise.all([self, helper].map(async file => [path.relative(root, file), hash(await readFile(file))])))
const before = await pins()
const { readSessionCapabilityEvidence } = await import(pathToFileURL(helper).href + '?source=' + before[path.relative(root, helper)])
const receipt = { schema: 'agentmux.session-capability-recovery-joined.v1', passed: false, captureOnly, before,
  limitations: ['Private Native protocol fixture; no upstream CLI crash or account-bootstrap repair is claimed.',
    'The original gate receipts own their respective behavior and loaded counterexamples; this entry joins their exact source and real public consumers.',
    'Actual full-App restart frames are retained for the final independent review. Capturing them is not an aesthetic approval.'] }
await mkdir(output, { recursive: true })
try {
  if (!captureOnly) receipt.owners = await readSessionCapabilityEvidence(root)
  process.argv[2] = output
  process.env.AGENTMUX_RECOVERY_CAPABILITY_PROOF = '1'
  const product = path.join(import.meta.dirname, 'verify-session-continuity-product.mjs')
  const productSha256 = hash(await readFile(product))
  await import(pathToFileURL(product).href + '?source=' + productSha256)
  const nativeFile = path.join(output, 'receipt.json'), nativeBytes = await readFile(nativeFile), native = JSON.parse(nativeBytes)
  assert.equal(native.schema, 'agentmux.session-capability-recovery.v1'); assert.equal(native.passed, true)
  assert.equal(native.publicCli.passed, true); assert.equal(native.publicCli.zeroLifecycleOrInputDuringRefresh, true)
  assert.deepEqual(native.publicCli.results.map(one => one.kind), ['healthy', 'rebound', 'unconfirmed', 'retired'])
  assert.equal(native.phases.length, 3); assert.equal(new Set(native.phases.map(one => one.native.pid)).size, 3)
  assert.deepEqual(native.cleanup.errors, []); assert.deepEqual(native.cleanup.remaining, []); assert.equal(native.cleanup.temporaryRootRemoved, true)
  if (!captureOnly) assert.deepEqual(await readSessionCapabilityEvidence(root), receipt.owners, 'An original owner proof changed during the joined product run.')
  assert.deepEqual(await pins(), before, 'The joined proof producer changed while it was running.')
  receipt.native = { receipt: nativeFile, sha256: hash(nativeBytes), sourceSha256: productSha256,
    publicCliKinds: native.publicCli.results.map(one => one.kind), originalHealthy: native.originalHealthy }
  receipt.passed = !captureOnly
} catch (error) {
  receipt.failure = { name: error.name, message: error.message, stack: error.stack }
  throw error
} finally {
  await writeFile(path.join(output, 'qualification.json'), JSON.stringify(receipt, null, 2) + '\n')
}
console.log(captureOnly ? 'Private Native component captured; joined owner and final review qualification remains pending.'
  : 'Session-chain owner proofs and actual Native/public CLI consumers qualified; final independent full-App review remains separate.')
