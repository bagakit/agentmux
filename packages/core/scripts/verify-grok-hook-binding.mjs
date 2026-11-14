import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import ts from 'typescript'
import { buildHookWorker } from './build-hook-worker.mjs'

const exec = promisify(execFile)
const vitest = join(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const evidence = join(root, '.local/hook-durability/grok-proof')
await mkdir(evidence, { recursive: true, mode: 0o700 })
const binary = await realpath(process.env.AGENTMUX_GROK_NATIVE_BINARY ||
  (await exec('/bin/sh', ['-c', 'command -v grok'], { env: { PATH: process.env.PATH } })).stdout.trim())
await access(binary)
async function hashFile(path) { const hash = createHash('sha256'); for await (const bytes of createReadStream(path)) hash.update(bytes); return hash.digest('hex') }
const binarySHA256 = await hashFile(binary)
const built = await buildHookWorker(join(root, 'packages/core'))
const workerSHA256 = await hashFile(built.outfile)
const owners = ['packages/core/src/providers/grok.ts', 'packages/core/src/providers/shared.ts', 'packages/core/src/client.ts',
  'packages/core/src/managed-hook-runtime.ts', 'packages/core/src/managed-hook-installer.ts']
const mutations = process.argv.includes('--mutations')
const compiled = process.argv.includes('--compiled')
assert(!(compiled && mutations), 'Run source mutations separately from compiled package consumption')
const coreEntry = pathToFileURL(join(root, 'packages/core/dist/index.js')).href
const fixtureInputs = ['packages/core/test/providers/grok-hook-binding.native.test.ts', 'packages/core/test/vitest.grok-hook-binding.config.mts',
  'packages/core/scripts/verify-grok-hook-binding.mjs']
const fixtureHashes = Object.fromEntries(await Promise.all(fixtureInputs.map(async path => [path, await hashFile(join(root, path))])))
async function qualifyCompiled() {
  const config = JSON.parse(await readFile(join(root, 'tsconfig.base.json'), 'utf8'))
  const options = ts.convertCompilerOptionsFromJson(config.compilerOptions, root).options
  assert.equal(JSON.parse(await readFile(join(root, 'packages/core/package.json'), 'utf8')).type, 'module')
  const current = {}
  for (const path of [...owners, 'packages/core/src/agent-provider.ts', 'packages/core/src/agent-session-store.ts', 'packages/core/src/index.ts']) {
    const source = await readFile(join(root, path), 'utf8'), artifact = path.replace('/src/', '/dist/').replace(/\.ts$/u, '.js')
    const output = await readFile(join(root, artifact), 'utf8')
    // An independent in-memory emit of these eight actual owners checks current build identity;
    // it neither writes an alternate package nor redirects the compiled consumer to source.
    const emitted = ts.transpileModule(source, { fileName: join(root, path), compilerOptions: { ...options,
      module: ts.ModuleKind.ESNext, sourceMap: false, inlineSourceMap: false, declaration: false } }).outputText
    assert(output.replace(/\n?\/\/# sourceMappingURL=.*$/u, '\n') === emitted,
      `Compiled owner is stale: ${artifact}; build the candidate before --compiled`)
    const mapping = JSON.parse(await readFile(join(root, artifact + '.map'), 'utf8'))
    assert.equal(mapping.sources.length, 1)
    assert.equal(resolve(dirname(join(root, artifact)), mapping.sourceRoot ?? '', mapping.sources[0]), join(root, path))
    current[artifact] = { sourceSHA256: await hashFile(join(root, path)), artifactSHA256: await hashFile(join(root, artifact)),
      sourceMapSHA256: await hashFile(join(root, artifact + '.map')) }
  }
  return current
}
const compiledArtifacts = compiled ? await qualifyCompiled() : undefined
const results = []
for (const mutation of mutations ? ['no-retained-runtime', 'no-native-tool-hooks', 'outside-scope-claimed'] : [undefined]) {
  const label = mutation ?? (compiled ? 'compiled-positive' : 'positive'), loadedPath = join(evidence, `${label}.loaded.jsonl`)
  const reportPath = join(evidence, `${label}.vitest.json`), receiptPath = join(evidence, compiled ? 'compiled-native-receipt.json' : 'native-receipt.json')
  const baseline = Object.fromEntries(await Promise.all(owners.map(async path => [path, await hashFile(join(root, path))])))
  await writeFile(loadedPath, '')
  if (!mutation) await rm(receiptPath, { force: true })
  const privateRunner = await mkdtemp(join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'amgv-'))
  await mkdir(join(privateRunner, 'home')); await mkdir(join(privateRunner, 'tmp'))
  // The test and all native processes start without inherited native overrides or real auth.
  const env = { PATH: process.env.PATH, HOME: join(privateRunner, 'home'), TMPDIR: join(privateRunner, 'tmp'), LANG: 'en_US.UTF-8',
    AGENTMUX_GROK_NATIVE_BINARY: binary, AGENTMUX_GROK_NATIVE_RECEIPT: receiptPath, AGENTMUX_GROK_HOOK_LOADED: loadedPath,
    ...(compiled ? { AGENTMUX_GROK_CORE_ENTRY: coreEntry } : {}),
    ...(mutation ? { AGENTMUX_GROK_HOOK_MUTATION: mutation } : {}) }
  let outcome
  try {
    try { outcome = { ...(await exec(process.execPath, [vitest, 'run', '--config', 'packages/core/test/vitest.grok-hook-binding.config.mts',
      '--reporter=json', `--outputFile=${reportPath}`], { cwd: root, env, timeout: 100_000, maxBuffer: 4 * 1024 * 1024 })), code: 0 } }
    catch (error) { outcome = { stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.code } }
    await writeFile(join(evidence, `${label}.log`), outcome.stdout + outcome.stderr)
    const loaded = (await readFile(loadedPath, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
    if (compiled) assert.equal(loaded.length, 0, 'Compiled consumption must not load the source alias/mutation pipeline')
    else for (const owner of owners) assert(loaded.some(value => value.path === owner && value.originalSHA256 === baseline[owner]), `Current owner was not consumed: ${owner}`)
    const report = JSON.parse(await readFile(reportPath, 'utf8'))
    assert.equal(report.numTotalTests, 1, 'The native Core consumer must execute')
    if (mutation) {
      assert(loaded.some(value => value.mutation === mutation && value.applied), 'Actual owner mutant was not loaded')
      assert.notEqual(outcome.code, 0, `Native product mutant survived: ${mutation}`)
      assert.equal(report.numFailedTests, 1)
      assert(report.testResults.some(file => file.assertionResults.some(test => test.status === 'failed' &&
        test.failureMessages.some(message => /AssertionError|expected/.test(message)))), 'Mutation must fail a nonempty semantic assertion')
    } else {
      assert.equal(outcome.code, 0, outcome.stdout + outcome.stderr); assert.equal(report.numPassedTests, 1)
      const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
      assert.equal(receipt.binary, binary); assert.equal(receipt.scope, 'native-headless')
      assert.equal(receipt.compiledPackageConsumer, compiled)
      assert.equal(receipt.coreEntry, compiled ? coreEntry : 'current-source')
      for (const key of ['publicCreate', 'privateCtxmux', 'coreToolConsumed', 'retainedRuntime', 'coreRecreated', 'sameRunReattached',
        'oldLaunchBindingDeliveredStop', 'sharedDeclarationUnchanged', 'privateRootRemovedAfterTest']) assert.equal(receipt[key], true, key)
      assert.equal(receipt.outsideIngress, false)
      assert(receipt.originalRun.runId && receipt.originalPid > 0 && receipt.nativeSessionId)
      for (const event of ['session_start', 'user_prompt_submit', 'pre_tool_use', 'post_tool_use', 'stop']) assert(receipt.nativeEvents.includes(event))
      await assert.rejects(access(receipt.privateRoot), { code: 'ENOENT' })
      assert.throws(() => process.kill(receipt.originalPid, 0), { code: 'ESRCH' })
    }
    results.push({ label, code: outcome.code, assertions: report.numTotalTests, loaded, baseline, fixtureHashes })
    process.stdout.write(`${label}: passed\n`)
  } finally { await rm(privateRunner, { recursive: true, force: true }) }
}
if (compiled) assert.deepEqual(await qualifyCompiled(), compiledArtifacts, 'Compiled candidate changed during native consumption')
await writeFile(join(evidence, mutations ? 'mutations.json' : compiled ? 'compiled-positive.json' : 'positive.json'), JSON.stringify({ schema: 'agentmux.grok-native-hook-proof.v1',
  binary, binarySHA256, workerSHA256, compiledArtifacts, scope: 'native-headless-public-Core-create-and-same-Run-reattach', passed: true, results }, null, 2) + '\n', { mode: 0o600 })
