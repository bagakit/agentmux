import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile, readdir, cp, symlink, realpath } from 'node:fs/promises'
import { resolve, join, relative, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { mintObjectId } from '../packages/identity/dist/index.js'
import { packageIdentifierMutations, mutatePackageIdentifiers } from '../packages/connectors/test/helpers/identifier-mutations.mjs'

const root = resolve(import.meta.dirname, '..'), base = join(root, '.tmp/package-identifiers')
const config = 'packages/connectors/test/vitest.package-identifiers.config.mts'
const hash = value => createHash('sha256').update(value).digest('hex')
const schema = 'agentmux.package-identifiers-proof.v1'
const runtime = { node: process.version, platform: process.platform, arch: process.arch }
const baselinePattern = [...new Set(packageIdentifierMutations.map(item => item.pattern)), 'a lost CLI response is recovered by original inspect', 'keeps missing create IDs unknown', 'actual SDK and Axios send the exact frozen post bytes', 'uses the original durable attempt as native UUID'].join('|')
const sourcePaths = [...new Set(packageIdentifierMutations.map(item => item.path))]
const evidencePaths = [config, 'scripts/verify-package-identifiers.mjs', 'packages/connectors/test/helpers/identifier-mutations.mjs',
  'packages/connectors/test/helpers/unified-identifiers.ts', 'packages/connectors/package.json', 'packages/demand/package.json', 'packages/relay/package.json',
  'packages/connectors/test/connection-enrollment-public-consumer.test.ts', 'packages/connectors/test/connection-setup-configuration-consumer.test.ts',
  'packages/connectors/test/connection-setup-inspection-consumer.test.ts', 'packages/connectors/test/unified-identifiers-ingress.test.ts',
  'packages/connectors/test/room-provisioning-public-consumer.test.ts', 'packages/connectors/test/feishu-permission-actions.test.ts',
  'packages/connectors/test/feishu-rooms.test.ts', 'packages/connectors/test/feishu-publication.test.ts',
  'packages/demand/test/unified-identifiers.test.ts', 'packages/demand/test/demand-store-concurrency.test.ts', 'packages/relay/test/local-identifiers.test.ts']
async function files(directory) {
  return (await Promise.all((await readdir(join(root, directory), { withFileTypes: true })).map(entry =>
    entry.isDirectory() ? files(directory + '/' + entry.name) : [directory + '/' + entry.name]))).flat()
}
async function fingerprints(paths) { return Object.fromEntries(await Promise.all(paths.map(async path => [path, hash(await readFile(join(root, path)))]))) }
async function unchanged(values) { for (const [path, value] of Object.entries(values)) assert.equal(hash(await readFile(join(root, path))), value, 'Verification input changed: ' + path) }
async function run(command, args, env = {}, cwd = root) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, pnpm_config_verify_deps_before_run: 'false', ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('Package identifier verification exceeded its bounded stage deadline')) }, 120000)
    child.stdout.on('data', text => { output += text }); child.stderr.on('data', text => { output += text })
    child.once('error', error => { clearTimeout(timer); reject(error) }); child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, output }) })
  })
}
function validateStage(stage, inventory, red = false) {
  assert.deepEqual(stage.inventory, inventory); assert.ok(inventory.length > 0); assert.equal(stage.signal, null)
  assert.equal(stage.active, inventory.length)
  if (red) { assert.ok(stage.code > 0); assert.ok(stage.failed > 0); assert.ok(stage.assertionFailures > 0); assert.ok(stage.applied.length > 0) }
  else { assert.equal(stage.code, 0); assert.equal(stage.failed, 0); assert.equal(stage.applied.length, 0) }
}
function validateProof(proof) {
  assert.equal(proof.schema, schema); assert.equal(proof.passed, true); assert.equal(proof.sharedSourceMutations, 0); assert.ok(proof.isolatedConsumer); assert.deepEqual(proof.runtime, runtime)
  validateStage(proof.baseline, proof.baseline.inventory)
  assert.ok(proof.baseline.inventory.some(item => item.includes('compiled Demand CLI')))
  assert.ok(proof.baseline.inventory.some(item => item.includes('local Relay allocates')))
  assert.ok(proof.baseline.inventory.some(item => item.includes('compiled room CLI')))
  assert.equal(proof.cases.length, packageIdentifierMutations.length)
  for (const [index, mutation] of packageIdentifierMutations.entries()) {
    const entry = proof.cases[index], inventory = proof.baseline.inventory.filter(item => new RegExp(mutation.pattern).test(item))
    assert.equal(entry.name, mutation.name); validateStage(entry.red, inventory, true); validateStage(entry.green, inventory)
  }
  validateStage(proof.restored, proof.baseline.inventory)
}
await mkdir(base, { recursive: true })
try {
  const saved = JSON.parse(await readFile(join(base, 'verified.json'), 'utf8')), proof = JSON.parse(await readFile(join(root, saved.receipt), 'utf8'))
  assert.equal(hash(await readFile(join(root, saved.receipt))), saved.sha256); validateProof(proof)
  await unchanged(proof.sourceHashes); await unchanged(proof.evidenceHashes); await unchanged(proof.consumerHashes); await unchanged(proof.frozenUpstreamSourceHashes); await unchanged(proof.dependencyInstallationHashes); await unchanged(proof.frozenManifestHashes)
  for (const stage of [proof.baseline, ...proof.cases.flatMap(item => [item.red, item.green]), proof.restored]) await unchanged(stage.artifactHashes)
  process.stdout.write(JSON.stringify({ passed: true, reused: true, receipt: saved.receipt, tests: proof.baseline.active, mutations: proof.cases.length }) + '\n'); process.exit(0)
} catch { /* Changed consumer/source/evidence requires a fresh bounded proof. */ }
let directory, candidate, proof
try {
  const pointer = JSON.parse(await readFile(join(base, 'checkpoint.json'), 'utf8')), bytes = await readFile(join(root, pointer.receipt))
  assert.equal(hash(bytes), pointer.sha256)
  const prior = JSON.parse(bytes), verifier = await readFile(join(root, pointer.verifier), 'utf8'), currentVerifier = await readFile(join(root, 'scripts/verify-package-identifiers.mjs'), 'utf8')
  assert.equal(hash(verifier), prior.evidenceHashes['scripts/verify-package-identifiers.mjs'])
  const validation = source => source.slice(source.indexOf('function validateStage('), source.indexOf('await mkdir(base,'))
  assert.ok(validation(verifier).length > 1000); assert.equal(validation(verifier), validation(currentVerifier), 'A checkpoint requires the same acceptance validator')
  assert.equal(prior.schema, schema); assert.deepEqual(prior.runtime, runtime); assert.equal(prior.passed, false)
  assert.ok(prior.cases.length > 0 && prior.cases.length < packageIdentifierMutations.length)
  await unchanged(prior.sourceHashes); await unchanged(Object.fromEntries(Object.entries(prior.evidenceHashes).filter(([path]) => path !== 'scripts/verify-package-identifiers.mjs')))
  await unchanged(prior.consumerHashes); await unchanged(prior.frozenUpstreamSourceHashes); await unchanged(prior.frozenManifestHashes); await unchanged(prior.dependencyInstallationHashes)
  validateStage(prior.baseline, prior.baseline.inventory)
  for (const [index, entry] of prior.cases.entries()) {
    const mutation = packageIdentifierMutations[index], expected = prior.baseline.inventory.filter(item => new RegExp(mutation.pattern).test(item))
    assert.equal(entry.name, mutation.name); validateStage(entry.red, expected, true); validateStage(entry.green, expected)
  }
  for (const stage of [prior.baseline, ...prior.cases.flatMap(item => [item.red, item.green])]) {
    await unchanged(stage.artifactHashes)
    const report = JSON.parse(await readFile(join(root, stage.report), 'utf8')), active = report.testResults.flatMap(file => file.assertionResults).filter(item => ['passed', 'failed'].includes(item.status))
    assert.deepEqual(active.map(item => item.fullName).sort(), stage.inventory); assert.equal(active.filter(item => item.status === 'failed').length, stage.failed)
  }
  directory = dirname(join(root, pointer.receipt)); candidate = join(root, prior.isolatedConsumer); proof = prior
  proof.resumedFrom = { receipt: pointer.receipt, verifier: pointer.verifier, completedCases: prior.cases.length,
    artifactHashes: await fingerprints([pointer.receipt, pointer.verifier]), reason: 'Resolve the CLI mutant compiler through its owning Core development dependency; preceding sources, consumers, assertions and validation functions are unchanged.' }
  proof.evidenceHashes['scripts/verify-package-identifiers.mjs'] = hash(currentVerifier)
  process.stdout.write(JSON.stringify({ resumed: true, completedCases: proof.cases.length, sourceAndConsumersUnchanged: true }) + '\n')
} catch { /* An incompatible or damaged checkpoint cannot replace fresh execution. */ }
if (!proof) {
  directory = join(base, mintObjectId()); await mkdir(directory)
candidate = join(directory, 'candidate'); await mkdir(candidate)
// Private source/compiled consumer owners keep unrelated parallel builds from deleting
// a live test's modules. Workspace links point inside this candidate; external packages
// retain this workspace's already installed, locked dependency identities.
for (const entry of await readdir(root)) if (/^(?:vitest.*\.[cm]?ts|tsconfig.*\.json|package\.json|pnpm-workspace\.yaml|pnpm-lock\.yaml)$/u.test(entry)) await cp(join(root, entry), join(candidate, entry))
await symlink(join(root, 'node_modules'), join(candidate, 'node_modules'), 'dir')
await cp(join(root, 'test'), join(candidate, 'test'), { recursive: true })
const packageNames = await readdir(join(root, 'packages'))
for (const name of packageNames) await cp(join(root, 'packages', name), join(candidate, 'packages', name), { recursive: true,
  filter: path => !/(?:^|\/)(?:node_modules|dist|\.cache|\.ctxmux-build)(?:\/|$)/u.test(path) && !path.endsWith('.tsbuildinfo') })
for (const app of ['desktop', 'host']) {
  await mkdir(join(candidate, 'apps', app), { recursive: true })
  for (const entry of app === 'desktop' ? ['src', 'test', 'scripts/lib', 'package.json'] : ['src', 'package.json']) await cp(join(root, 'apps', app, entry), join(candidate, 'apps', app, entry), { recursive: true })
}
for (const packagePath of [...packageNames.map(name => 'packages/' + name), 'apps/desktop', 'apps/host']) {
  const original = join(root, packagePath, 'node_modules'), destination = join(candidate, packagePath, 'node_modules')
  await mkdir(destination, { recursive: true })
  for (const entry of await readdir(original)) {
    if (entry === '@agentmux') {
      await mkdir(join(destination, entry), { recursive: true })
      for (const dependency of await readdir(join(original, entry))) {
        const target = dependency === 'desktop' ? join(candidate, 'apps/desktop') : join(candidate, 'packages', dependency)
        await symlink(target, join(destination, entry, dependency), 'dir')
      }
    } else await symlink(await realpath(join(original, entry)), join(destination, entry), 'dir')
  }
}
const ownedSources = (await Promise.all(['packages/connectors/src', 'packages/demand/src', 'packages/relay/src'].map(files))).flat().filter(path => /\.ts$/u.test(path))
const frozenSources = (await Promise.all(['packages/core/src', 'packages/client-ui/src', 'apps/desktop/src', 'apps/host/src', 'apps/desktop/scripts/lib', 'apps/desktop/test/helpers', 'packages/connectors/test/fixtures', 'packages/core/test/helpers'].map(path => files(relative(root, join(candidate, path)))))).flat()
proof = { schema, passed: false, runtime, sharedSourceMutations: 0, isolatedConsumer: relative(root, candidate),
  dependencyInstallationHashes: await fingerprints(['pnpm-lock.yaml', 'node_modules/.modules.yaml']),
  frozenManifestHashes: await fingerprints(['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package.json', ...packageNames.map(name => 'packages/' + name + '/package.json'), 'apps/desktop/package.json', 'apps/host/package.json'].map(path => relative(root, join(candidate, path)))),
  frozenUpstreamSourceHashes: await fingerprints(frozenSources), sourceHashes: await fingerprints(ownedSources), evidenceHashes: await fingerprints(evidencePaths), cases: [], builds: [] }
for (const path of sourcePaths) assert.equal(hash(await readFile(join(candidate, path))), proof.sourceHashes[path], 'Frozen source differs from candidate')
for (const args of [['--filter', '@agentmux/core...', 'build'], ['--filter', '@agentmux/connectors', 'build']]) {
  const result = await run('pnpm', args, {}, candidate), path = relative(root, join(directory, 'build-' + proof.builds.length + '.log'))
  await writeFile(join(root, path), result.output); proof.builds.push({ args, code: result.code, signal: result.signal, log: path })
  assert.equal(result.code, 0, 'Necessary compiled consumer build failed; inspect ' + path)
}
const production = (await Promise.all(['packages/connectors/src', 'packages/demand/src', 'packages/relay/src'].map(files))).flat().filter(path => /\.ts$/u.test(path))
assert.ok(production.length >= 40)
for (const path of production) assert.ok(!/randomUUID\s*\(/u.test(await readFile(join(root, path), 'utf8')), 'Remaining autonomous UUID allocation: ' + path)
proof.scan = { files: production.length, autonomousUuidCalls: 0,
  preserved: ['Feishu prepared native SHA-256 request mapping', 'Relay 32-byte control bearer', 'NaCl key material and 24-byte frame nonce', 'original caller and persisted identifiers'] }
const consumers = (await Promise.all(['packages/core/dist', 'packages/connectors/dist', 'packages/demand/dist', 'packages/relay/dist', 'packages/identity/dist'].map(path => files(relative(root, join(candidate, path)))))).flat()
proof.consumerHashes = await fingerprints(consumers)
}
async function stage(name, mutation, pattern = mutation?.pattern ?? baselinePattern) {
  const report = relative(root, join(directory, name + '.json')), loaded = relative(root, join(directory, name + '-loaded.ndjson'))
  const env = { AGENTMUX_PACKAGE_ID_MUTATION: mutation?.name ?? '', AGENTMUX_PACKAGE_ID_LOADED: join(root, loaded), AGENTMUX_TEST_DEMAND_CLI: '' }
  let childApplied = []
  if (mutation?.path === 'packages/demand/src/cli.ts') {
    const { build } = createRequire(join(candidate, 'packages/core/package.json'))('esbuild'), outfile = join(directory, name + '-demand-cli.mjs')
    await build({ entryPoints: [join(candidate, 'packages/demand/bin/agentmux-demand.ts')], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node24',
      plugins: [{ name: 'actual-demand-cli-source-mutation', setup(builder) { builder.onLoad({ filter: /\/packages\/demand\/src\/cli\.ts$/ }, async args => {
        const original = await readFile(args.path, 'utf8'), changed = mutatePackageIdentifiers(original, mutation)
        childApplied.push(mutation.path); return { contents: changed, loader: 'ts' }
      }) } }] })
    assert.deepEqual(childApplied, [mutation.path]); env.AGENTMUX_TEST_DEMAND_CLI = outfile
  }
  const pathForScope = packageIdentifierMutations.find(item => item.pattern === pattern)?.path
  const scopedFiles = {
    'packages/demand/src/cli.ts': 'packages/demand/test/unified-identifiers.test.ts',
    'packages/demand/src/demand-store.ts': 'packages/demand/test/unified-identifiers.test.ts',
    'packages/relay/src/local-adapter.ts': 'packages/relay/test/local-identifiers.test.ts'
  }
  const scopedFile = pattern !== baselinePattern && pathForScope ? scopedFiles[pathForScope] : undefined
  const args = ['node_modules/vitest/vitest.mjs', 'run', '--config', config, '--reporter=json', '--outputFile=' + join(root, report),
    ...(scopedFile ? [scopedFile] : []), ...(pattern ? ['--testNamePattern', pattern] : [])]
  const result = await run(process.execPath, args, env, candidate), log = relative(root, join(directory, name + '.log'))
  await writeFile(join(root, log), result.output)
  const results = JSON.parse(await readFile(join(root, report), 'utf8')), active = results.testResults.flatMap(file => file.assertionResults)
    .filter(item => item.status === 'passed' || item.status === 'failed')
  const loadedRows = (await readFile(join(root, loaded), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  const applied = [...new Set([...loadedRows.filter(item => item.mutation).map(item => item.path), ...childApplied])]
  const stage = { name, code: result.code, signal: result.signal, active: active.length, failed: active.filter(item => item.status === 'failed').length,
    assertionFailures: active.filter(item => item.status === 'failed' && item.failureMessages.some(text => /AssertionError|expected|New connector|pair ID cannot authorize/u.test(text))).length,
    inventory: active.map(item => item.fullName).sort(), applied, report, log, loaded,
    artifactHashes: await fingerprints([report, log, loaded, ...(childApplied.length ? [relative(root, env.AGENTMUX_TEST_DEMAND_CLI)] : [])]) }
  process.stdout.write(JSON.stringify({ stage: name, tests: stage.active, failed: stage.failed, code: stage.code }) + '\n')
  return stage
}
try {
  if (!proof.baseline) proof.baseline = await stage('baseline'); validateStage(proof.baseline, proof.baseline.inventory)
  for (const mutation of packageIdentifierMutations.slice(proof.cases.length)) {
    const red = await stage(mutation.name + '-red', mutation), expected = proof.baseline.inventory.filter(item => new RegExp(mutation.pattern).test(item))
    validateStage(red, expected, true)
    const green = await stage(mutation.name + '-green', undefined, mutation.pattern)
    // The restored stage intentionally keeps only the selected consumer scope.
    validateStage(green, expected)
    proof.cases.push({ name: mutation.name, red, green })
  }
  proof.restored = await stage('restored'); validateStage(proof.restored, proof.baseline.inventory)
  await unchanged(proof.sourceHashes); await unchanged(proof.evidenceHashes); await unchanged(proof.consumerHashes); await unchanged(proof.frozenUpstreamSourceHashes); await unchanged(proof.dependencyInstallationHashes); await unchanged(proof.frozenManifestHashes)
  proof.passed = true; validateProof(proof)
} finally {
  const path = relative(root, join(directory, 'receipt.json')), body = JSON.stringify(proof, null, 2) + '\n'; await writeFile(join(root, path), body)
  if (proof.passed) { await writeFile(join(base, 'verified.json'), JSON.stringify({ receipt: path, sha256: hash(body) }) + '\n'); process.stdout.write(JSON.stringify({ passed: true, receipt: path, tests: proof.baseline.active, mutations: proof.cases.length }) + '\n') }
}
