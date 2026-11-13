import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { spawn } from 'node:child_process'
import { clipboardPermissionMutations } from './browser-clipboard-permissions-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..'), require = createRequire(join(root, 'package.json')), args = process.argv.slice(2)
const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1] }
for (let index = 0; index < args.length; index++) { if (['--output', '--electron-evidence', '--review'].includes(args[index])) { assert.ok(args[++index]); continue }; assert.equal(args[index], '--mutations') }
const output = resolve(option('--output') ?? join(root, '.tmp/browser-clipboard-permissions/gate-' + randomUUID()))
await mkdir(output, { recursive: true })
const sha = bytes => createHash('sha256').update(bytes).digest('hex'), fileHash = async path => sha(await readFile(resolve(root, path)))
const files = [...new Set([...clipboardPermissionMutations.map(m => m.path), 'apps/desktop/test/browser-webauthn-access.test.ts', 'apps/desktop/test/browser-webauthn-accounts.test.ts',
  'apps/desktop/scripts/fixtures/browser-clipboard-permissions/vitest.config.mts', 'apps/desktop/scripts/browser-clipboard-permissions-mutations.mjs', 'apps/desktop/scripts/verify-browser-clipboard-permissions.mjs'])]
const sources = Object.fromEntries(await Promise.all(files.map(async path => [path, await fileHash(path)])))
const receipt = { schema: 'agentmux.browser-clipboard-permissions-proof.v1', passed: false, output, sources, results: [], boundary: 'Exact Browser Session policy/HID tests, actual source mutations and previously completed private BrowserManager webpage writes to OS. No repeated clipboard marker writes by this verifier.' }
async function unit(mutation) {
  const label = mutation?.name ?? 'baseline', report = join(output, label + '.json'), hits = join(output, label + '-hits.jsonl')
  const child = spawn(process.execPath, [require.resolve('vitest/vitest.mjs'), 'run', '--config', 'apps/desktop/scripts/fixtures/browser-clipboard-permissions/vitest.config.mts', '--reporter=json', '--outputFile=' + report], { cwd: root, env: { ...process.env, AGENTMUX_CLIPBOARD_MUTATION: mutation?.name ?? '', AGENTMUX_CLIPBOARD_HITS: hits }, stdio: ['ignore', 'pipe', 'pipe'] })
  const logs = []; child.stdout.on('data', bytes => logs.push(bytes)); child.stderr.on('data', bytes => logs.push(bytes))
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  await writeFile(join(output, label + '.log'), Buffer.concat(logs))
  const actual = JSON.parse(await readFile(report, 'utf8')), assertions = actual.testResults.flatMap(suite => suite.assertionResults)
  assert.equal(actual.testResults.length, 2); assert.ok(actual.testResults.every(suite => suite.assertionResults.length > 0)); assert.ok(actual.numTotalTests > 0)
  let consumed = []
  if (!mutation) { assert.equal(code, 0); assert.equal(actual.numFailedTests, 0) }
  else {
    consumed = (await readFile(hits, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.ok(consumed.length > 0 && consumed.every(hit => hit.path === mutation.path && hit.sourceSHA256 === sources[mutation.path] && hit.loadedSHA256 !== hit.sourceSHA256))
    assert.notEqual(code, 0); assert.ok(assertions.some(test => test.status === 'failed' && test.fullName.includes(mutation.expected)), 'Declared semantic oracle must kill ' + label)
  }
  receipt.results.push({ label, code, tests: actual.numTotalTests, failed: actual.numFailedTests, reportSHA256: sha(await readFile(report)), consumed })
  console.log(label + ': ' + (mutation ? 'semantic red' : 'green'))
}
try {
  const defaults = JSON.parse(await readFile(join(root, '.tmp/browser-clipboard-permissions/electron-evidence.json'), 'utf8'))
  const pointer = option('--electron-evidence') ?? process.env.AGENTMUX_CLIPBOARD_EVIDENCE ?? defaults.path
  const proofPath = resolve(root, pointer), proof = JSON.parse(await readFile(proofPath, 'utf8'))
  assert.equal(proof.schema, 'agentmux.browser-clipboard-electron-receipt.v1'); assert.equal(proof.passed, true); assert.deepEqual(proof.remaining, [])
  assert.equal(proof.process.exitConfirmed, true); assert.equal(proof.process.exitCode, 0)
  assert.ok(Object.keys(proof.sources).length > 0 && Object.keys(proof.artifacts).length > 0)
  for (const [path, hash] of Object.entries(proof.sources)) assert.equal(await fileHash(path), hash, 'Real Electron source is still exact: ' + path)
  for (const [path, hash] of Object.entries(proof.artifacts)) assert.equal(sha(await readFile(join(proof.output, path))), hash)
  for (const [path, hash] of Object.entries(proof.dependencies)) assert.equal(await fileHash(path), hash)
  assert.equal(await fileHash(proof.electron.executable), proof.electron.sha256)
  assert.equal(proof.result.writes.length, 2); assert.ok(proof.result.writes.every(write => write.system.state === 'confirmed' && write.trusted && write.focused && write.activation))
  assert.equal(proof.result.clipboardAfter.restored, true); assert.deepEqual(proof.result.clipboardBefore.items, proof.result.clipboardAfter.items)
  assert.equal(proof.result.cleanup.helper.code, 0); assert.equal(proof.result.cleanup.windowsDestroyed, true); assert.equal(proof.result.originalRetained, true)
  assert.equal(proof.result.reads.length, 2); assert.ok(proof.result.reads.every(read => read.state === 'denied'))
  assert.deepEqual(proof.result.sourceQueries.map(query => query.kind), ['main', 'blank', 'srcdoc', 'file']); assert.ok(proof.result.sourceQueries.every(query => query.state === 'granted'))
  const inputPath = join(proof.output, 'input-observation.json'), input = JSON.parse(await readFile(inputPath, 'utf8'))
  assert.equal(input.schema, 'agentmux.browser-clipboard-input-observation.v1'); assert.equal(input.pid, proof.result.pid)
  assert.equal(input.actions.length, 2); assert.ok(input.actions.every(action => action.source === 'CUA app.click on a fresh AX index'))
  receipt.electron = { path: proofPath, sha256: sha(await readFile(proofPath)), inputObservation: { path: inputPath, sha256: sha(await readFile(inputPath)) }, boundary: 'Trusted page events and actual OS clipboard results; no OS hit-test qualification.' }
  for (const [path, image] of Object.entries(input.screenshots)) assert.equal(sha(await readFile(join(proof.output, path))), image.sha256)
  const reviewPath = resolve(root, option('--review') ?? process.env.AGENTMUX_CLIPBOARD_REVIEW ?? defaults.review)
  const review = await readFile(reviewPath, 'utf8'); assert.match(review, /approved/)
  receipt.review = { path: reviewPath, sha256: sha(review) }
  await unit()
  if (args.includes('--mutations')) for (const mutation of clipboardPermissionMutations) await unit(mutation)
  for (const [path, hash] of Object.entries(sources)) assert.equal(await fileHash(path), hash)
  receipt.passed = true
} catch (error) { receipt.failure = error.stack }
await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2))
console.log(JSON.stringify({ output, passed: receipt.passed, failure: receipt.failure }, null, 2))
process.exitCode = receipt.passed ? 0 : 1
