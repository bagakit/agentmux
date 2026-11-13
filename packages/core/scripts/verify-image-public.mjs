import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const require = createRequire(new URL('../package.json', import.meta.url)), { build } = require('esbuild')
const temporaryRoot = join(root, 'packages/core/.tmp'); await mkdir(temporaryRoot, { recursive: true })
const directory = await mkdtemp(join(temporaryRoot, 'image-public-'))
const proofRoot = join(root, '.local/state/image-public'); await mkdir(proofRoot, { recursive: true })
const proof = await mkdtemp(join(proofRoot, 'run-')), cli = join(directory, 'dist/agentmux.js')
const hash = value => createHash('sha256').update(value).digest('hex')
const receipt = { schema: 'agentmux.image-public-verification.v1', passed: false, mutations: [],
  boundary: 'Actual Core public service/client and CLI with a controlled client image port; no OS window, screenshot, permission or installed-product proof.' }
const run = (args, env = process.env) => spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
try {
  const sourceRoot = join(root, 'packages/core/src')
  const entries = [], assets = []
  async function collect(path) {
    for (const item of await readdir(path, { withFileTypes: true })) {
      const file = join(path, item.name)
      if (item.isDirectory()) await collect(file)
      else if (item.name.endsWith('.ts') && !item.name.endsWith('.d.ts')) entries.push(file)
      else if (item.name.endsWith('.json')) assets.push(file)
    }
  }
  await collect(sourceRoot)
  // Preserve module URLs and the real executable guards; bundling helper runners
  // into the CLI would incorrectly turn their import.meta.url into its own URL.
  const built = await build({ entryPoints: entries, outdir: join(directory, 'dist'), outbase: sourceRoot, metafile: true,
    platform: 'node', target: 'node24', format: 'esm', logLevel: 'silent' })
  await cp(join(root, 'packages/core/package.json'), join(directory, 'package.json'))
  for (const file of assets) await cp(file, join(directory, 'dist', file.slice(sourceRoot.length + 1)))
  const files = [...new Set([...Object.keys(built.metafile.inputs), 'packages/core/src/public-rpc-image.ts', 'packages/core/src/png-image.ts',
    'packages/core/src/public-rpc-service.ts', 'packages/core/src/rpc-native-codec.ts', 'packages/core/test/image-public.test.ts', 'packages/core/test/image-public.config.mts',
    'packages/core/scripts/verify-image-public.mjs'])]
  const fingerprints = async () => Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(join(root, file)))])))
  receipt.sourceHashes = await fingerprints(); receipt.cliSha256 = hash(await readFile(cli))
  const args = [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'packages/core/test/image-public.config.mts']
  const baselinePath = join(proof, 'baseline.json')
  const baseline = run([...args, '--reporter=json', '--outputFile', baselinePath], { ...process.env, IMAGE_PUBLIC_CLI: cli })
  await writeFile(join(proof, 'baseline.log'), baseline.stdout + baseline.stderr)
  process.stdout.write(baseline.stdout); process.stderr.write(baseline.stderr)
  assert.equal(baseline.status, 0, 'Image public baseline must pass')
  const report = JSON.parse(await readFile(baselinePath, 'utf8'))
  assert.ok(report.numPassedTests > 0 && report.numFailedTests === 0, 'Image public baseline must execute nonempty assertions')
  receipt.baseline = { tests: report.numPassedTests, logSha256: hash(baseline.stdout + baseline.stderr) }
  const cases = { owner: 'public service consumes', authority: 'only authenticated actors', host: 'image result codec rejects',
    operation: 'image result codec rejects', png: 'typed image requests reject' }
  for (const [mutation, title] of Object.entries(cases)) {
    const path = join(proof, mutation + '.json'), prefix = join(proof, mutation)
    const changed = run([...args, '-t', title, '--reporter=json', '--outputFile', path],
      { ...process.env, IMAGE_PUBLIC_CLI: cli, IMAGE_PUBLIC_MUTATION: mutation, IMAGE_PUBLIC_LOAD_PREFIX: prefix })
    await writeFile(join(proof, mutation + '.log'), changed.stdout + changed.stderr)
    assert.notEqual(changed.status, 0, 'Surviving image public mutation: ' + mutation)
    const tests = JSON.parse(await readFile(path, 'utf8'))
    const failures = tests.testResults.flatMap(suite => suite.assertionResults).filter(test => test.status === 'failed' && test.fullName.includes(title))
    assert.ok(failures.some(test => test.failureMessages.some(message => /AssertionError|expected.*to|promise (?:resolved|rejected).*instead of/i.test(message))), 'Mutation must fail its owning assertion: ' + mutation)
    const loading = JSON.parse(await readFile(prefix + '-load.json', 'utf8'))
    assert.equal(loading.sourceSha256, receipt.sourceHashes[loading.file]); assert.equal(loading.sourceSha256, hash(await readFile(prefix + '-source.txt')))
    assert.equal(loading.mutatedSha256, hash(await readFile(prefix + '-mutated.txt')))
    receipt.mutations.push({ mutation, failedTests: failures.map(test => test.fullName), loading })
    console.log('killed: image public ' + mutation)
  }
  const after = await fingerprints()
  for (const [file, digest] of Object.entries(receipt.sourceHashes)) assert.equal(after[file], digest, 'Image public source changed during verification: ' + file)
  receipt.passed = true
  console.log('Image public: typed owner → public service/client/actual CLI; Main window join remains separate.')
  console.log('Image public evidence: ' + proof)
} finally {
  await writeFile(join(proof, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  await rm(directory, { recursive: true, force: true })
}
