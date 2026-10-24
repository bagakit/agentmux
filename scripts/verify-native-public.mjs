import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(new URL('../packages/core/package.json', import.meta.url))
const { build } = require('esbuild')
const temporaryRoot = join(root, 'packages/core/.tmp')
await mkdir(temporaryRoot, { recursive: true })
const directory = await mkdtemp(join(temporaryRoot, 'native-public-'))
const proofRoot = join(root, '.local/state/native-public')
await mkdir(proofRoot, { recursive: true })
const proofDirectory = await mkdtemp(join(proofRoot, 'run-'))
const cli = join(directory, 'amux.mjs')
const run = (args, env = process.env) => spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
const hash = value => createHash('sha256').update(value).digest('hex')
const receipt = { schema: 'agentmux.native-public-verification.v1', passed: false, mutations: [], boundary: 'Actual public service/client/CLI through the production Native connection; controlled Unix native protocol, no OS pixels, UI, permissions or installed-app proof.' }
try {
  const native = run([join(root, 'packages/native-desktop/scripts/verify-client.mjs')])
  await writeFile(join(proofDirectory, 'native-client.log'), native.stdout + native.stderr)
  process.stdout.write(native.stdout); process.stderr.write(native.stderr)
  assert.equal(native.status, 0, 'Native transport and image boundary must pass before public consumption')
  // Use the actual current production listener asset, without replacing its dispatcher.
  await build({ entryPoints: [join(root, 'packages/core/src/control-endpoint-listener-worker.ts')], outfile: join(root, 'packages/core/dist/control-endpoint-listener-worker.js'),
    bundle: true, platform: 'node', target: 'node24', format: 'esm', logLevel: 'silent' })
  const cliBuild = await build({ entryPoints: [join(root, 'packages/core/src/agentmux.ts')], outfile: cli, metafile: true,
    bundle: true, platform: 'node', target: 'node24', format: 'esm', packages: 'external',
    banner: { js: "import { createRequire as nativeProofRequire } from 'node:module'; const require = nativeProofRequire(import.meta.url);" }, logLevel: 'silent' })
  const sources = [...new Set([...Object.keys(cliBuild.metafile.inputs), 'apps/desktop/src/main/native-desktop-public.ts', 'apps/desktop/test/native-desktop-public.test.ts',
    'packages/core/test/native-desktop.config.mts', 'scripts/verify-native-public.mjs', 'packages/native-desktop/src/client.ts', 'packages/native-desktop/src/index.ts'])]
  const sourceHashes = async () => Object.fromEntries(await Promise.all(sources.map(async path => [path, hash(await readFile(join(root, path)))])))
  receipt.sourceHashes = await sourceHashes()
  const cliBytes = await readFile(cli)
  receipt.cliSha256 = hash(cliBytes)
  await writeFile(join(proofDirectory, 'cli.mjs'), cliBytes)
  const args = [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'packages/core/test/native-desktop.config.mts']
  const baselinePath = join(proofDirectory, 'baseline.json')
  const baseline = run([...args, '--reporter=json', '--outputFile', baselinePath], { ...process.env, NATIVE_PUBLIC_CLI: cli })
  await writeFile(join(proofDirectory, 'baseline.log'), baseline.stdout + baseline.stderr)
  process.stdout.write(baseline.stdout); process.stderr.write(baseline.stderr)
  assert.equal(baseline.status, 0, 'Native public baseline must pass')
  const baselineTests = JSON.parse(await readFile(baselinePath, 'utf8'))
  assert.ok(baselineTests.numPassedTests > 0 && baselineTests.numFailedTests === 0, 'Native public baseline must execute passing behavior assertions')
  receipt.baseline = { tests: baselineTests.numPassedTests, jsonSha256: hash(await readFile(baselinePath)), logSha256: hash(baseline.stdout + baseline.stderr) }
  const cases = {
    target: 'accurate result codec rejects', owner: 'public service consumes',
    auth: 'only transport-authenticated', action: 'typed action codec rejects',
    provenance: 'public capture provenance rejects', geometry: 'public capture geometry rejects'
  }
  for (const [mutation, title] of Object.entries(cases)) {
    const report = join(proofDirectory, `${mutation}.json`)
    const prefix = join(proofDirectory, mutation)
    const result = run([...args, '-t', title, '--reporter=json', '--outputFile', report], { ...process.env, NATIVE_PUBLIC_CLI: cli, NATIVE_PUBLIC_MUTATION: mutation, NATIVE_PUBLIC_LOAD_PREFIX: prefix })
    await writeFile(join(proofDirectory, `${mutation}.log`), result.stdout + result.stderr)
    assert.notEqual(result.status, 0, `Surviving native public mutation: ${mutation}`)
    const tests = JSON.parse(await readFile(report, 'utf8'))
    const failures = tests.testResults.flatMap(suite => suite.assertionResults).filter(test => test.status === 'failed' && test.fullName.includes(title))
    assert.ok(failures.length > 0 && failures.some(test => test.failureMessages.some(message => /AssertionError|expected.*to|to have been called|promise (?:resolved|rejected).*instead of (?:rejecting|resolving)/i.test(message))), `Mutation must fail in its owning behavior assertion, not loading: ${mutation}`)
    const loading = JSON.parse(await readFile(prefix + '-load.json', 'utf8'))
    assert.equal(loading.mutation, mutation)
    assert.equal(loading.sourceSha256, receipt.sourceHashes[loading.file], 'Mutation must load the same baseline source')
    assert.equal(loading.sourceSha256, hash(await readFile(prefix + '-source.txt')))
    assert.equal(loading.mutatedSha256, hash(await readFile(prefix + '-mutated.txt')))
    receipt.mutations.push({ mutation, expectedTitle: title, failedTests: failures.map(test => test.fullName), loading, jsonSha256: hash(await readFile(report)), logSha256: hash(result.stdout + result.stderr) })
    console.log(`killed: native public ${mutation}`)
  }
  assert.deepEqual(await sourceHashes(), receipt.sourceHashes, 'Native public sources changed during verification')
  receipt.passed = true
  console.log('Native public: actual CLI → public Unix service → shared host adapter → production Node connection; protocol fixture is not OS/TCC proof.')
  console.log(`Native public evidence: ${proofDirectory}`)
} finally {
  await writeFile(join(proofDirectory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  await rm(directory, { recursive: true, force: true })
}
