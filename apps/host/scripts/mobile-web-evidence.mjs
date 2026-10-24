import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { open, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export const repository = resolve(import.meta.dirname, '../../..')
export const evidenceDirectory = resolve(repository, '.local/state/mobile-web-verification')
export const sha256 = value => createHash('sha256').update(value).digest('hex')
const inside = (root, path) => { const part = relative(root, path); return !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep) }

async function bytes(path, max = 2 * 1024 * 1024, allowEmpty = false) {
  const handle = await open(path, 'r')
  try {
    const info = await handle.stat()
    assert.ok(info.isFile() && (allowEmpty || info.size > 0) && info.size <= max, 'Bounded original proof file: ' + path)
    const value = Buffer.alloc(info.size)
    let offset = 0
    while (offset < value.length) {
      const result = await handle.read(value, offset, value.length - offset, offset)
      assert.ok(result.bytesRead > 0, 'Proof file did not shrink during read'); offset += result.bytesRead
    }
    assert.equal((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead, 0, 'Proof file stayed fixed during read')
    return value
  } finally { await handle.close() }
}
export async function readJSON(path) { return JSON.parse((await bytes(path)).toString('utf8')) }
export async function readReference(ref) {
  assert.match(ref.sha256, /^[a-f0-9]{64}$/u)
  const path = await realpath(resolve(repository, ref.path))
  assert.ok(inside(await realpath(evidenceDirectory), path), 'Evidence references stay in this private proof namespace')
  const value = await bytes(path, 2 * 1024 * 1024, true)
  assert.equal(sha256(value), ref.sha256, 'Original evidence bytes match their reference: ' + ref.path)
  return value
}
async function checkSourceHash(path, expected) {
  assert.ok(!isAbsolute(path) && inside(repository, resolve(repository, path)), 'Loaded source belongs to this worktree')
  const current = await bytes(resolve(repository, path))
  if (sha256(current) === expected) return
  // The final HTTP parse guard is a narrow, separately proved delta over the
  // original frozen owner. It cannot silently bless unrelated source changes.
  assert.equal(path, 'apps/host/src/mobile-assets-owner.ts', 'Source changed beyond the accepted HTTP owner delta')
  const delta = await readJSON(resolve(evidenceDirectory, 'http-target-delta/receipt.json'))
  const before = await readReference(delta.sourceDelta.before)
  assert.equal(sha256(before), expected); assert.equal(sha256(current), delta.sourceDelta.afterSHA256)
  const anchor = "    const path = new URL(request.url ?? '/', 'http://localhost').pathname"
  const replacement = "    let path: string\n    try { path = new URL(request.url ?? '/', 'http://localhost').pathname }\n    catch { response.writeHead(400, { 'Cache-Control': 'no-store' }); response.end(); return }"
  assert.equal(before.toString().split(anchor).length, 2)
  assert.equal(before.toString().replace(anchor, replacement), current.toString(), 'Only the proved URL parse rejection changed')
}
export async function checkInputs(inputs) {
  assert.ok(inputs && Object.keys(inputs).length > 0, 'Source input set cannot be empty')
  for (const [path, expected] of Object.entries(inputs)) {
    assert.ok(!isAbsolute(path) && inside(repository, resolve(repository, path)), 'Source input belongs to this worktree')
    await checkSourceHash(path, expected)
  }
}
async function checkLoaded(run, mutant = null) {
  const rows = (await readReference(run.loaded)).toString('utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.ok(rows.length > 0 && rows.length <= 256, 'Actual evaluated modules are a nonempty finite set')
  for (const row of rows) {
    assert.ok(Number.isSafeInteger(row.pid) && row.pid > 1)
    await checkSourceHash(row.path, row.originalSHA256)
    if (!row.mutant) assert.equal(row.loadedSHA256, row.originalSHA256)
  }
  if (mutant) assert.ok(rows.some(row => row.mutant === mutant && row.loadedSHA256 !== row.originalSHA256), 'Mutant was actually evaluated: ' + mutant)
  else assert.ok(rows.every(row => !row.mutant), 'Restored run loads only original source')
  return rows
}
export async function checkBackendProof() {
  const path = resolve(evidenceDirectory, 'backend-final/receipt.json'), proof = await readJSON(path)
  assert.equal(proof.schema, 'agentmux.mobile-web-backend-proof.v1')
  await checkInputs(proof.inputs)
  const labels = ['baseline', 'main-route', 'manifest-hash', 'report-owner', 'report-producer', 'restored']
  assert.deepEqual(proof.runs.map(run => run.label), labels)
  for (const run of proof.runs) {
    assert.equal(run.signal, null); assert.equal(run.command.program, 'pnpm'); assert.ok(isAbsolute(run.command.cwd))
    await readReference(run.log)
    const result = JSON.parse((await readReference(run.result)).toString('utf8'))
    const mutant = !['baseline', 'restored'].includes(run.label)
    assert.equal(run.exitCode, mutant ? 1 : 0)
    assert.equal(result.numPassedTests, mutant ? 0 : 2); assert.equal(result.numFailedTests, mutant ? 1 : 0)
    assert.equal(result.numTotalTests, 2); assert.equal(result.numPendingTests, mutant ? 1 : 0)
    const failed = result.testResults.flatMap(test => test.assertionResults).filter(test => test.status === 'failed')
    if (mutant) {
      assert.equal(failed.length, 1)
      const failure = failed[0].failureMessages.join('\n')
      // Vitest's `.resolves` mismatch is named Error, but is an explicit expect
      // assertion. Require its own assertion frame rather than accepting an RPC throw.
      assert.ok(failure.includes('AssertionError') ||
        /Error: promise rejected[^\n]+ instead of resolving\n/u.test(failure) && failure.includes('__VITEST_RESOLVES__'),
      'A product assertion detects the loaded mutation')
    }
    await checkLoaded(run, mutant ? run.label : null)
  }
  return { path, sha256: sha256(await bytes(path)), sources: proof.inputs }
}
export async function checkOwnerDelta() {
  const path = resolve(evidenceDirectory, 'backend-owner-delta/receipt.json'), proof = await readJSON(path)
  assert.equal(proof.schema, 'agentmux.mobile-web-owner-delta-proof.v1'); await checkInputs(proof.inputs)
  assert.deepEqual(proof.runs.map(run => run.label), ['baseline', 'snapshot-exchange', 'operation-inspect', 'restored'])
  for (const run of proof.runs) {
    const mutant = !['baseline', 'restored'].includes(run.label)
    assert.equal(run.signal, null); assert.equal(run.exitCode, mutant ? 1 : 0)
    const log = (await readReference(run.log)).toString('utf8')
    assert.match(log, mutant ? /AssertionError/u : /Tests\s+4 passed \(4\)/u)
    await checkLoaded(run, mutant ? run.label : null)
  }
  return { path, sha256: sha256(await bytes(path)) }
}
export async function checkScopedProof() {
  const path = resolve(evidenceDirectory, 'backend-scoped/receipt.json'), proof = await readJSON(path)
  assert.equal(proof.schema, 'agentmux.mobile-web-scoped-proof.v1'); await checkInputs(proof.inputs)
  assert.deepEqual(proof.runs.map(run => run.label), ['security', 'host-typecheck', 'main-owner-typecheck'])
  for (const run of proof.runs) {
    assert.equal(run.signal, null); assert.equal(run.exitCode, 0); await readReference(run.log)
    if (run.label === 'security') {
      const result = JSON.parse((await readReference(run.result)).toString('utf8'))
      assert.equal(result.numPassedTests, 1); assert.equal(result.numFailedTests, 0)
      await checkLoaded(run)
    }
  }
  return { path, sha256: sha256(await bytes(path)) }
}
export async function checkHTTPDelta() {
  const path = resolve(evidenceDirectory, 'http-target-delta/receipt.json'), proof = await readJSON(path)
  assert.equal(proof.schema, 'agentmux.mobile-http-target-delta-proof.v1'); await checkInputs(proof.inputs)
  assert.deepEqual(proof.runs.map(run => run.label), ['baseline', 'remove-target-catch', 'restored'])
  for (const run of proof.runs) {
    const mutant = run.label === 'remove-target-catch'
    assert.equal(run.signal, null); assert.equal(run.exitCode, mutant ? 1 : 0); await readReference(run.log)
    const result = JSON.parse((await readReference(run.result)).toString())
    assert.equal(result.numTotalTests, 2); assert.equal(result.numPassedTests, mutant ? 1 : 2)
    assert.equal(result.numFailedTests, mutant ? 1 : 0)
    if (mutant) assert.ok(result.testResults.flatMap(test => test.assertionResults)
      .some(test => test.status === 'failed' && test.failureMessages.join('\n').includes('AssertionError')))
    await checkLoaded(run, mutant ? run.label : null)
    await checkLoaded({ loaded: run.nodeLoaded })
  }
  const typecheckPath = resolve(evidenceDirectory, 'http-target-delta/typecheck.json'), typecheck = await readJSON(typecheckPath)
  assert.equal(typecheck.exitCode, 0); assert.equal(typecheck.signal, null)
  assert.equal(typecheck.sourceSHA256, proof.sourceDelta.afterSHA256); await readReference(typecheck.log)
  return { path, sha256: sha256(await bytes(path)), sourceDelta: proof.sourceDelta,
    typecheck: { path: typecheckPath, sha256: sha256(await bytes(typecheckPath)) } }
}

export async function browserJSON(name, references, join) {
  assert.match(name, /^[a-z0-9-]+$/u)
  const path = resolve(evidenceDirectory, 'browser-e2e-final', name + '.json'), value = await bytes(path)
  const pinned = join.roles[name]
  assert.ok(pinned, 'The joined original proof includes this role: ' + name)
  assert.equal(await realpath(resolve(repository, pinned.path)), await realpath(path))
  assert.equal(sha256(value), pinned.sha256, 'Exact joined original browser/CLI role')
  references.push({ path, sha256: sha256(value) })
  return JSON.parse(value.toString())
}
export function originalCLI(record, operation, main = false) {
  assert.equal(record.schema, 'agentmux.private-cli-command.v1'); assert.equal(record.exitCode, 0); assert.equal(record.signal, null)
  assert.ok(Array.isArray(record.command) && record.command.length > 1)
  assert.match(record.injectedEndpoint, /^unix:.+\/control\.sock$/u)
  assert.equal(record.exactEndpoint, record.injectedEndpoint + (main ? '.desktop' : ''))
  const result = JSON.parse(record.stdout)
  assert.equal(result.ok, true); assert.equal(result.operation, operation)
  return result.result
}
export function originalPage(record) {
  assert.equal(record.schema, 'agentmux.private-browser-command.v1'); assert.equal(record.exitCode, 0); assert.equal(record.signal, null)
  assert.deepEqual(record.result, JSON.parse(record.stdout), 'Page facts equal the original browser command result')
  assert.match(record.scriptSHA256, /^[a-f0-9]{64}$/u)
  return record.result
}
export async function checkBrowserSourceJoin() {
  const path = resolve(evidenceDirectory, 'browser-join.json'), value = await bytes(path), proof = JSON.parse(value.toString())
  assert.equal(proof.schema, 'agentmux.mobile-web-browser-join.v1')
  await checkInputs(proof.sourceHashes)
  assert.ok(Object.keys(proof.sourceHashes).length >= 8, 'Browser proof binds the real product sources')
  assert.ok(Array.isArray(proof.references) && proof.references.length > 0 && proof.references.length <= 128)
  for (const ref of proof.references) await readReference(ref)
  return { path, sha256: sha256(value), proof }
}
