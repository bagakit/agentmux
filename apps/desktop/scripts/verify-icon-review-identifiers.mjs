import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { iconIdentifierMutations } from '../test/fixtures/icon-review-identifiers/mutations.mjs'
const root = resolve(import.meta.dirname, '../../..')
const identityEntry = 'packages/identity/dist/index.js'
const { mintObjectId } = await import(pathToFileURL(join(root, identityEntry)).href)
const config = 'apps/desktop/test/fixtures/icon-review-identifiers/vitest.config.mts', schema = 'agentmux.icon-review-identifiers-proof.v1'
const self = 'apps/desktop/scripts/verify-icon-review-identifiers.mjs', source = 'apps/desktop/scripts/icon-review/app.js'
const base = join(root, '.tmp/icon-review-identifiers'), digest = bytes => createHash('sha256').update(bytes).digest('hex')
const validation = [self, config, 'apps/desktop/test/icon-review-identifiers.test.ts', 'apps/desktop/test/fixtures/icon-review-identifiers/build-loader.mjs',
  'apps/desktop/test/fixtures/icon-review-identifiers/mutations.mjs', 'apps/desktop/scripts/icon-review/dev.mjs', 'packages/identity/src/index.ts',
  identityEntry, 'packages/identity/package.json', 'apps/desktop/package.json', 'pnpm-lock.yaml']
const runtime = { node: process.version, platform: process.platform, arch: process.arch }
async function hashes(paths) { return Object.fromEntries(await Promise.all(paths.map(async path => [path, digest(await readFile(join(root, path)))]))) }
async function unchanged(expected) { for (const [path, value] of Object.entries(expected)) assert.equal(digest(await readFile(join(root, path))), value, 'Changed icon proof input: ' + path) }
async function run(args, env = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; child.stdout.on('data', value => { output += value }); child.stderr.on('data', value => { output += value })
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal, output }))
  })
}
function check(stage, expected, red = false) {
  assert.equal(stage.signal, null); assert.deepEqual(stage.inventory, expected); assert.ok(expected.length > 0)
  if (red) { assert.ok(stage.code > 0); assert.ok(stage.failed > 0); assert.ok(stage.assertions > 0); assert.ok(stage.mutatedSource) }
  else { assert.equal(stage.code, 0); assert.equal(stage.failed, 0); assert.equal(stage.mutatedSource, false) }
}
function validate(proof) {
  assert.equal(proof.schema, schema); assert.equal(proof.passed, true); assert.deepEqual(proof.runtime, runtime); assert.equal(proof.sharedSourceMutations, 0)
  assert.equal(proof.baseline.inventory.length, 2); check(proof.baseline, proof.baseline.inventory)
  const selected = proof.baseline.inventory.filter(name => name.includes('published tool creates shared IDs'))
  assert.equal(selected.length, 1); assert.equal(proof.cases.length, iconIdentifierMutations.length)
  for (const [index, mutation] of iconIdentifierMutations.entries()) { const item = proof.cases[index]; assert.equal(item.name, mutation.name); check(item.red, selected, true); check(item.green, selected) }
  check(proof.restored, proof.baseline.inventory)
}
await mkdir(base, { recursive: true })
try {
  const pointer = JSON.parse(await readFile(join(base, 'verified.json'), 'utf8')), bytes = await readFile(join(root, pointer.receipt)), proof = JSON.parse(bytes)
  assert.equal(digest(bytes), pointer.sha256); validate(proof); await unchanged(proof.sourceHashes); await unchanged(proof.validationHashes)
  for (const stage of [proof.baseline, ...proof.cases.flatMap(item => [item.red, item.green]), proof.restored]) await unchanged(stage.artifactHashes)
  process.stdout.write(JSON.stringify({ passed: true, reused: true, receipt: pointer.receipt, tests: 2, mutations: proof.cases.length }) + '\n'); process.exit(0)
} catch { /* Changed source, build or evidence requires fresh real consumer execution. */ }
const directory = join(base, mintObjectId()); await mkdir(directory)
const proof = { schema, passed: false, runtime, sharedSourceMutations: 0, sourceHashes: await hashes([source]), validationHashes: await hashes(validation), cases: [] }
async function stage(name, mutation, selected = false) {
  const out = join(directory, name + '-site'), report = join(directory, name + '.json'), loaded = join(directory, name + '-loaded.ndjson')
  const build = await run([...(mutation ? ['--import', join(root, 'apps/desktop/test/fixtures/icon-review-identifiers/build-loader.mjs')] : []), 'apps/desktop/scripts/icon-review/build.mjs', '--out', out],
    { AGENTMUX_ICON_ID_MUTATION: mutation?.name ?? '', AGENTMUX_ICON_ID_BUILD_LOADED: loaded })
  await writeFile(join(directory, name + '-build.log'), build.output)
  assert.equal(build.signal, null); assert.equal(build.code, 0, 'Real icon build failed: ' + name)
  const buildInputs = JSON.parse(await readFile(join(out, 'build-inputs.json'), 'utf8'))
  assert.ok(buildInputs.inputs.some(item => item.path === source)); assert.ok(buildInputs.inputs.some(item => item.path.includes('packages/identity/dist/')))
  for (const input of buildInputs.inputs) {
    if (proof.sourceHashes[input.path]) assert.equal(proof.sourceHashes[input.path], input.sha256)
    proof.sourceHashes[input.path] = input.sha256
  }
  const result = await run(['node_modules/vitest/vitest.mjs', 'run', '--config', config, '--reporter=json', '--outputFile=' + report,
    ...(selected ? ['--testNamePattern', 'the published tool creates shared IDs'] : [])], { AGENTMUX_ICON_ID_SITE: out })
  await writeFile(join(directory, name + '.log'), result.output)
  const json = JSON.parse(await readFile(report, 'utf8')), active = json.testResults.flatMap(file => file.assertionResults).filter(item => ['passed', 'failed'].includes(item.status))
  const changed = mutation ? (await readFile(loaded, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).some(item => item.path === source && item.mutation === mutation.name && item.sha256 !== item.originalSHA256) : false
  const artifacts = ['index.html', 'app.js', 'catalog.json', 'review-manifest.json', 'build-inputs.json'].map(file => relative(root, join(out, file)))
  const value = { name, code: result.code, signal: result.signal, inventory: active.map(item => item.fullName).sort(), failed: active.filter(item => item.status === 'failed').length,
    assertions: active.filter(item => item.status === 'failed' && item.failureMessages.some(text => /AssertionError|expected/u.test(text))).length, mutatedSource: changed,
    artifactHashes: await hashes([...artifacts, relative(root, report), relative(root, join(directory, name + '.log')), relative(root, join(directory, name + '-build.log')), ...(mutation ? [relative(root, loaded)] : [])]) }
  process.stdout.write(JSON.stringify({ stage: name, tests: value.inventory.length, failed: value.failed, code: value.code }) + '\n')
  return value
}
try {
  proof.baseline = await stage('baseline'); check(proof.baseline, proof.baseline.inventory); assert.equal(proof.baseline.inventory.length, 2)
  const selected = proof.baseline.inventory.filter(name => name.includes('published tool creates shared IDs'))
  for (const mutation of iconIdentifierMutations) {
    const red = await stage(mutation.name + '-red', mutation, true); check(red, selected, true)
    const green = await stage(mutation.name + '-green', undefined, true); check(green, selected)
    proof.cases.push({ name: mutation.name, red, green })
  }
  proof.restored = await stage('restored'); check(proof.restored, proof.baseline.inventory)
  await unchanged(proof.sourceHashes); await unchanged(proof.validationHashes); proof.passed = true; validate(proof)
} finally {
  const receipt = relative(root, join(directory, 'receipt.json')), bytes = JSON.stringify(proof, null, 2) + '\n'; await writeFile(join(root, receipt), bytes)
  if (proof.passed) { await writeFile(join(base, 'verified.json'), JSON.stringify({ receipt, sha256: digest(bytes) }) + '\n'); process.stdout.write(JSON.stringify({ passed: true, receipt, tests: 2, mutations: proof.cases.length }) + '\n') }
}
