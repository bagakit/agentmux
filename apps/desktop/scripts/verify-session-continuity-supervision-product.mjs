import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { readSessionSupervisionEvidence, verifySupervisionProduct } from './session-supervision-evidence.mjs'

const root = path.resolve(import.meta.dirname, '../../..'), args = process.argv.slice(2), captureOnly = args.includes('--capture')
const at = args.indexOf('--owners'), ownerFile = path.resolve(root, at < 0 ? '.tmp/session-continuity-supervision/owners.json' : args[at + 1])
const output = path.resolve(args.find((one, index) => !one.startsWith('--') && (at < 0 || index !== at + 1)) ?? path.join(root, '.tmp/session-continuity-supervision/product'))
const hash = value => createHash('sha256').update(value).digest('hex')
const producers = [new URL(import.meta.url).pathname, path.join(import.meta.dirname, 'session-supervision-evidence.mjs'),
  path.join(import.meta.dirname, 'session-capability-evidence.mjs')]
const pins = async () => Object.fromEntries(await Promise.all(producers.map(async file => [path.relative(root, file), hash(await readFile(file))])))
const before = await pins(), receipt = { schema: 'agentmux.continuity-supervision-product-qualification.v1', passed: false, captureOnly, before,
  limitations: ['Private Native protocol fixture, not upstream Provider bootstrap or account-network certification.',
    'A context-only process recovery does not prove that the old task continued or that uncertain prior input was not applied.',
    'Independent full-App visual acceptance remains a separate review of these exact frames.'] }
await mkdir(output, { recursive: true })
try {
  let files
  if (!captureOnly) {
    files = JSON.parse(await readFile(ownerFile, 'utf8'))
    receipt.owners = await readSessionSupervisionEvidence(root, files)
  }
  process.argv[2] = output
  process.env.AGENTMUX_CONTINUITY_SUPERVISION_PROOF = '1'
  delete process.env.AGENTMUX_CONTINUITY_SUPERVISION_SURFACE
  const runner = path.join(import.meta.dirname, 'verify-session-continuity-product.mjs'), runnerSha256 = hash(await readFile(runner))
  await import(pathToFileURL(runner).href + '?source=' + runnerSha256)
  const nativeFile = path.join(output, 'receipt.json'), bytes = await readFile(nativeFile), native = JSON.parse(bytes)
  verifySupervisionProduct(native)
  for (const phase of native.phases) assert.equal(hash(await readFile(phase.image.path)), phase.image.sha256)
  if (!captureOnly) assert.deepEqual(await readSessionSupervisionEvidence(root, files), receipt.owners, 'Original task proof changed during the product run')
  assert.deepEqual(await pins(), before)
  receipt.native = { receipt: nativeFile, sha256: hash(bytes), runnerSha256, originalHealthy: native.originalHealthy,
    phases: native.phases.map(one => ({ phase: one.phase, pid: one.native.pid, image: one.image })) }
  receipt.passed = !captureOnly
} catch (error) {
  receipt.failure = { name: error.name, message: error.message, stack: error.stack }; throw error
} finally { await writeFile(path.join(output, 'qualification.json'), JSON.stringify(receipt, null, 2) + '\n') }
console.log(captureOnly ? 'Private restart evidence captured; joined task and independent visual qualification remains pending.'
  : 'Original task evidence and three App/Core generations qualified; independent visual acceptance remains separate.')
