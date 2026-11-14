import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile), root = resolve(import.meta.dirname, '../../..')
const evidence = join(root, '.local/state/pi-hook-binding-proof'), nativeRoot = join(root, '.local/hook-carrier/pi-native')
const version = '0.84.4', mutations = process.argv.includes('--mutations')
const paths = ['packages/core/src/providers/pi.ts', 'packages/core/test/providers/pi.test.ts', 'packages/core/test/providers/pi-hook-binding.test.ts',
  'packages/core/test/providers/pi-hook-binding.native.test.ts', 'packages/core/test/vitest.pi-hook-binding.config.mts', 'packages/core/scripts/verify-pi-hook-binding.mjs']
const hash = value => createHash('sha256').update(value).digest('hex')
const fingerprints = async () => Object.fromEntries(await Promise.all(paths.map(async path => [path, hash(await readFile(join(root, path)))])))
async function fileHash(path) { const hash = createHash('sha256'); for await (const value of createReadStream(path)) hash.update(value); return hash.digest('hex') }
await mkdir(evidence, { recursive: true, mode: 0o700 })
const before = await fingerprints()
const vitest = join(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs')
async function nativePackage() {
  const selected = process.env.AGENTMUX_PI_NATIVE_PACKAGE ?? join(nativeRoot, 'install/node_modules/@earendil-works/pi-coding-agent')
  let pkg
  try { pkg = await realpath(selected) }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    throw new Error(`Pi ${version} native proof artifact is unavailable. Set AGENTMUX_PI_NATIVE_PACKAGE to an existing private official package; verification does not download or install it.`)
  }
  const manifest = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'))
  assert.equal(manifest.name, '@earendil-works/pi-coding-agent'); assert.equal(manifest.version, version)
  return { path: pkg, version, packageSHA256: await fileHash(join(pkg, 'package.json')), cliSHA256: await fileHash(join(pkg, 'dist/bundle/cli.js')),
    loaderSHA256: await fileHash(join(pkg, 'dist/core/extensions/loader.js')) }
}
const results = []
for (const mutation of mutations ? ['unguarded-host', 'foreign-provider', 'ambient-route', 'trim-native-root'] : [undefined]) {
  const label = mutation ?? 'positive', loadedPath = join(evidence, label + '.loaded.jsonl'), reportPath = join(evidence, label + '.vitest.json')
  const receiptPath = join(evidence, 'native-receipt.json'), native = mutation ? undefined : await nativePackage()
  await writeFile(loadedPath, '')
  // Runtime/auth/provider state for the native run is built from an allowlist in the test.
  const env = { ...process.env, AGENTMUX_PI_HOOK_LOADED: loadedPath }
  delete env.AGENTMUX_PI_HOOK_MUTATION; delete env.AGENTMUX_PI_NATIVE_PACKAGE
  if (mutation) env.AGENTMUX_PI_HOOK_MUTATION = mutation
  else Object.assign(env, { AGENTMUX_PI_NATIVE_PACKAGE: native.path, AGENTMUX_PI_NATIVE_RECEIPT: receiptPath })
  let outcome
  try { outcome = { ...(await exec(process.execPath, [vitest, 'run', '--config', 'packages/core/test/vitest.pi-hook-binding.config.mts',
    '--reporter=json', `--outputFile=${reportPath}`], { cwd: root, env, maxBuffer: 4 * 1024 * 1024 })), code: 0 } }
  catch (error) { outcome = { stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.code } }
  await writeFile(join(evidence, label + '.log'), outcome.stdout + outcome.stderr)
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  const loaded = (await readFile(loadedPath, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
  assert(loaded.length > 0 && loaded.every(row => row.originalSHA256 === before[paths[0]]), 'Current Pi owner was not loaded')
  assert(report.numTotalTests >= 40, 'Empty or incomplete Pi assertions')
  assert(!(report.unhandledErrors ?? []).length && !(report.numRuntimeErrorTestSuites ?? 0), 'Pi test loading must succeed')
  if (mutation) {
    assert(loaded.some(row => row.mutation === mutation && row.applied && row.loadedSHA256 !== row.originalSHA256), 'Actual owner mutation not applied')
    assert.notEqual(outcome.code, 0, 'Pi mutant survived: ' + mutation); assert(report.numFailedTests > 0)
    const failed = report.testResults.flatMap(file => file.assertionResults).filter(test => test.status === 'failed')
    assert(failed.length > 0 && failed.every(test => test.failureMessages.some(text => text.includes('AssertionError'))),
      'Resource/loader/timeout failures do not kill a Pi mutant')
  } else {
    assert.equal(outcome.code, 0, outcome.stdout + outcome.stderr); assert.equal(report.numFailedTests, 0)
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
    for (const key of ['coreReceivedSettled', 'originalBindingKeptAfterEnvChange', 'publicInspection', 'noExternalHookNode', 'privateStateRemoved']) assert.equal(receipt[key], true)
    assert.equal(receipt.passiveNativeHosts, 2); assert.equal(receipt.foreignIngress, 0); assert.equal(receipt.version, version)
    assert(receipt.originalRun.runId && receipt.nativeSessionId)
  }
  results.push({ label, code: outcome.code, assertions: report.numTotalTests, failedAssertions: report.numFailedTests, loaded, native,
    artifacts: { loaded: loadedPath, report: reportPath, log: join(evidence, label + '.log'), ...(native ? { nativeReceipt: receiptPath } : {}) },
    ...(native ? { receiptSHA256: hash(await readFile(receiptPath)) } : {}) })
  process.stdout.write(`${label}: passed\n`)
}
assert.deepEqual(await fingerprints(), before, 'Pi inputs changed during qualification')
await writeFile(join(evidence, mutations ? 'mutations.json' : 'positive.json'), JSON.stringify({ passed: true, inputs: before,
  assertions: results.reduce((sum, result) => sum + result.assertions, 0),
  scope: 'Pi native loader and actual headless CLI through public Core create/inspect; original Run binding and passive host boundary.', results }, null, 2) + '\n')
