import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile, cp, symlink, realpath } from 'node:fs/promises'
import { resolve, relative, join } from 'node:path'
import { mintObjectId } from '../../identity/dist/index.js'

const root = resolve(import.meta.dirname, '../../..')
const proof = join(root, '.tmp', 'core-unified-identifiers', mintObjectId())
await mkdir(proof, { recursive: true })
const candidate = join(proof, 'candidate')
await mkdir(candidate)
const digest = text => createHash('sha256').update(text).digest('hex')
async function sources(directory) {
  const all = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) all.push(...await sources(path))
    else if (/\.(?:ts|mjs)$/u.test(path)) all.push(path)
  }
  return all
}
const files = [...await sources(join(root, 'packages/core/src')), ...await sources(join(root, 'packages/core/examples'))]
assert.ok(files.length > 0)
const inspected = await Promise.all(files.map(async path => ({ path: relative(root, path), source: await readFile(path, 'utf8') })))
const allocators = inspected.filter(file => /mintObjectId|deriveObjectId|identityRuntimeSource/u.test(file.source))
assert.ok(allocators.length >= 40, 'Production allocator inventory must be nonempty and cover Core consumers.')
for (const file of inspected) assert.doesNotMatch(file.source, /(?:crypto\.)?\brandomUUID\s*\(|from ['"]uuid['"]|bytes\[6\]\s*=/u, file.path)
await writeFile(join(proof, 'inventory.json'), JSON.stringify(allocators.map(file => ({ path: file.path, sha256: digest(file.source) })), null, 2) + '\n')

// Compile and execute one frozen source tree. Another consumer may rebuild its
// own Core concurrently; neither proof removes the other's listener/worker assets.
for (const entry of await readdir(root)) if (/^(?:vitest.*\.[cm]?ts|tsconfig.*\.json|package\.json|pnpm-workspace\.yaml|pnpm-lock\.yaml)$/u.test(entry)) {
  await cp(join(root, entry), join(candidate, entry))
}
await symlink(join(root, 'node_modules'), join(candidate, 'node_modules'), 'dir')
await cp(join(root, 'test'), join(candidate, 'test'), { recursive: true })
const packageNames = await readdir(join(root, 'packages'))
for (const name of packageNames) {
  await cp(join(root, 'packages', name), join(candidate, 'packages', name), { recursive: true,
    filter: path => !/(?:^|\/)(?:node_modules|dist|vendor|\.tmp|\.local|\.cache|\.ctxmux-build)(?:\/|$)/u.test(path) && !path.endsWith('.tsbuildinfo') })
  const original = join(root, 'packages', name, 'node_modules'), destination = join(candidate, 'packages', name, 'node_modules')
  await mkdir(destination, { recursive: true })
  for (const entry of await readdir(original)) {
    if (entry === '@agentmux') {
      await mkdir(join(destination, entry), { recursive: true })
      for (const dependency of await readdir(join(original, entry))) {
        await symlink(join(candidate, 'packages', dependency), join(destination, entry, dependency), 'dir')
      }
    } else await symlink(await realpath(join(original, entry)), join(destination, entry), 'dir')
  }
}
// Vendor artifacts are immutable inputs verified by the owning build manifest.
await symlink(join(root, 'packages/core/vendor'), join(candidate, 'packages/core/vendor'), 'dir')
for (const file of inspected) assert.equal(digest(await readFile(join(candidate, file.path), 'utf8')), digest(file.source), 'Frozen source differs: ' + file.path)

function command(label, args, env = {}) {
  const result = spawnSync('pnpm', args, { cwd: candidate, env: { ...process.env, pnpm_config_verify_deps_before_run: 'false', ...env }, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  const log = result.stdout + result.stderr
  return writeFile(join(proof, label + '.log'), log).then(() => ({ result, log }))
}
const built = await command('build', ['--filter', '@agentmux/core...', 'build'])
assert.equal(built.result.status, 0, 'This Core candidate must build; see its bounded proof log.')
const config = 'packages/core/test/unified-identifiers.config.mts'
async function tests(label, mutation, adjacent = false) {
  const resultPath = join(proof, label + '.json'), loadedPath = join(proof, label + '.loaded.ndjson')
  const env = { AMUX_IDENTIFIER_LOADED: loadedPath, AMUX_IDENTIFIER_ADJACENT: adjacent ? '1' : '0',
    ...(mutation ? { AMUX_IDENTIFIER_MUTATION: mutation } : {}) }
  const execution = await command(label, ['exec', 'vitest', 'run', '--config', config, '--reporter=json', '--outputFile', resultPath], env)
  const result = JSON.parse(await readFile(resultPath, 'utf8'))
  const active = result.testResults.flatMap(file => file.assertionResults).filter(test => test.status === 'passed' || test.status === 'failed')
  assert.ok(active.length >= 9, 'An empty or inactive test inventory cannot prove identifier behavior.')
  const loaded = (await readFile(loadedPath, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.ok(loaded.some(file => file.path === 'packages/core/src/client.ts'))
  if (mutation) {
    assert.notEqual(execution.result.status, 0, 'Mutant survived: ' + mutation)
    assert.ok(active.some(test => test.status === 'failed'), 'Mutation must fail a behavioral assertion: ' + mutation)
    assert.equal(result.numRuntimeErrorTestSuites ?? 0, 0, 'Loader/runtime errors are not behavioral mutation evidence.')
    assert.ok(loaded.some(file => file.mutation === mutation && file.sourceSHA !== file.loadedSHA), 'Actual production source must be mutated.')
  } else {
    assert.equal(execution.result.status, 0, 'Baseline failed: ' + label)
    assert.ok(active.every(test => test.status === 'passed'))
  }
  return { label, mutation: mutation ?? null, active: active.length, failed: active.filter(test => test.status === 'failed').length,
    loadedProduction: loaded.filter(file => file.path.includes('/src/')).length }
}
const baseline = await tests('baseline', null, true)
const mutationNames = ['request-allocator', 'cli-operation', 'avatar-uuid-only', 'reading-view', 'captured-epoch', 'registry-reservation', 'observer-source', 'pi-receipt', 'rpc-request', 'rpc-subscription']
const mutations = []
for (const mutation of mutationNames) mutations.push(await tests(mutation, mutation))
const restored = await tests('restored', null)
for (const file of inspected) assert.equal(digest(await readFile(join(root, file.path), 'utf8')), digest(file.source), 'Source changed during proof: ' + file.path)
const proofInputs = await Promise.all(['packages/core/test/unified-identifiers.test.ts', 'packages/core/test/unified-identifiers.config.mts', 'packages/core/scripts/verify-unified-identifiers.mjs'].map(async path => ({ path, sha256: digest(await readFile(join(root, path), 'utf8')) })))
const receipt = { proofInputs, isolatedCandidate: relative(root, candidate), status: 'passed', productionFiles: inspected.length, allocatorFiles: allocators.length, baseline, mutations, restored,
  consumer: 'compiled CLI → public Unix RPC → original Core Session/message journal; generated Provider runtime modules; real private owner process restart',
  externalUuidOwners: ['ctxmux Run/runtime/daemon', 'Provider native Session/Turn/record'],
  preservedSecurity: ['32-byte authentication/HMAC keys', '24-byte native correlation protocol nonce'] }
await writeFile(join(proof, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
process.stdout.write(JSON.stringify({ ...receipt, proof: relative(root, proof) }, null, 2) + '\n')
