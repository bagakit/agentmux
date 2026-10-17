import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

// Bounded negative checks against one explicitly selected real proof set.
// No native application is launched and no shared source or receipt is edited.
const root = resolve(import.meta.dirname, '../../..')
assert.equal(process.argv.length, 4, 'Provide the approved qualified input and a fresh output directory')
const input = resolve(process.argv[2]), output = resolve(process.argv[3])
await mkdir(dirname(output), { recursive: true }); await mkdir(output)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const source = await readFile(input), original = JSON.parse(source)
const files = [import.meta.filename, join(root, 'apps/desktop/scripts/verify-browser-operator-presence.mjs'),
  join(root, 'apps/desktop/scripts/lib/browser-operator-presence-qualified.mjs')]
const before = Object.fromEntries(await Promise.all(files.map(async file => [file, sha(await readFile(file))])))
const proof = { schema: 'agentmux.browser-operator-presence-qualified-input-checks.v1', passed: false,
  input: { path: input, sha256: sha(source) }, sources: before, sharedSourceMutations: 0, runs: [] }
async function changed(selection, field, mutate) {
  const value = JSON.parse(await readFile(selection[field].path, 'utf8'))
  mutate(value)
  const path = join(output, field + '-' + randomUUID() + '.json'), bytes = JSON.stringify(value)
  await writeFile(path, bytes, { flag: 'wx' }); selection[field] = { ...selection[field], path, sha256: sha(bytes) }
}
async function run(name, mutate, expected, environment = false) {
  const selection = structuredClone(original)
  if (mutate) await mutate(selection)
  const path = join(output, name + '-input.json'), receiptPath = join(output, name + '-receipt.json')
  await writeFile(path, JSON.stringify(selection, null, 2) + '\n', { flag: 'wx' })
  const env = { ...process.env }; delete env.AGENTMUX_BROWSER_PRESENCE_QUALIFIED_PROOF
  const args = [join(root, 'apps/desktop/scripts/verify-browser-operator-presence.mjs')]
  if (environment) env.AGENTMUX_BROWSER_PRESENCE_QUALIFIED_PROOF = path
  else args.push('--qualified-proof', path)
  args.push('--receipt', receiptPath)
  const result = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  await writeFile(join(output, name + '.log'), result.stdout + result.stderr)
  assert.equal(result.signal, null, 'An interrupted verifier is not a contract result')
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
  proof.runs.push({ name, exitCode: result.status, receipt: receiptPath, passed: receipt.passed, failure: receipt.failure })
  if (expected) {
    assert.equal(result.status, 1); assert.equal(receipt.passed, false); assert.equal(receipt.taskComplete, false)
    assert.ok(receipt.failure?.message.includes(expected), 'The intended proof boundary must reject the altered input: ' + name)
  } else { assert.equal(result.status, 0, receipt.failure?.message); assert.equal(receipt.passed, true); assert.equal(receipt.taskComplete, true) }
}
try {
  await run('original', null, null)
  await run('changed-artifact-identity', async selection => { selection.native.sha256 = '0'.repeat(64) }, 'Original artifact identity: native')
  await run('review-was-not-approved', selection => changed(selection, 'osReview', review => { review.approved = false }), 'independent review explicitly approved')
  await run('ordinary-cue-expired', selection => changed(selection, 'os', os => {
    os.runs[0].actual.captures.find(frame => frame.before.phase === 'completed').before.expiresAt = 0
  }), 'ordinary completed cue was captured before its original expiry')
  await run('compiled-core-mismatch', selection => changed(selection, 'currentCoreBuild', core => {
    core.outputs['packages/core/dist/metrics.js'] = '0'.repeat(64)
  }), 'selected private compiled Core input remains original')
  await run('source-difference-not-reviewed', selection => changed(selection, 'equivalenceReview', review => {
    review.changes = review.changes.filter(change => change.file !== 'apps/desktop/src/main/config-store.ts')
  }), 'Every changed product input has a precise reviewed SHA pair')
  await run('restored-explicit-environment', null, null, true)
  for (const [file, digest] of Object.entries(before)) assert.equal(sha(await readFile(file)), digest, 'Verifier sources remained unchanged')
  assert.equal(sha(await readFile(input)), sha(source), 'The selected original input remained immutable')
  proof.passed = true
} catch (error) { proof.failure = { name: error.name, message: error.message, stack: error.stack } }
await writeFile(join(output, 'receipt.json'), JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ passed: proof.passed, runs: proof.runs.length, receipt: join(output, 'receipt.json') }))
if (!proof.passed) process.exitCode = 1
