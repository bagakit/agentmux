import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = resolve(import.meta.dirname, '../../..')
const test = 'packages/core/test/run-storage-observation.test.ts'
const script = 'packages/core/scripts/verify-run-storage-observation-mutations.mjs'
const mutations = [
  { id: 'confirmed-watermark-replaced-by-offered', file: 'packages/core/src/run-storage-observation.ts',
    before: 'confirmedByte: p.committed_output_bytes', after: 'confirmedByte: p.offered_output_bytes',
    assertion: 'keeps independent facts and null persistence through actual SDK/Adapter/Core without a replay or actor read' },
  { id: 'required-capability-reclassified-as-optional', file: 'packages/core/src/ctxmux-run-adapter.ts',
    before: "error instanceof CtxmuxUnsupportedCapabilityError && error.capability === 'services.storage_observation'",
    after: 'error instanceof CtxmuxUnsupportedCapabilityError',
    assertion: 'does not label another required capability failure as optional storage unavailability' },
  { id: 'selected-host-replaced-by-first-host', file: 'packages/core/src/public-rpc-service.ts',
    before: "case 'system.storage': {\n        const hostId = rpcString(p.hostId, 'Host ID'), runId = rpcString(p.runId, 'Run ID')\n        const owner = (await this.clients()).find(entry => entry.hostId === hostId)",
    after: "case 'system.storage': {\n        const hostId = rpcString(p.hostId, 'Host ID'), runId = rpcString(p.runId, 'Run ID')\n        const owner = (await this.clients())[0]",
    assertion: 'routes exactly the chosen Host through native RPC and the compiled discoverable CLI, with no Session fanout' }
]
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const inputs = [...new Set([test, script, ...mutations.map(value => value.file)])]
const original = new Map(await Promise.all(inputs.map(async file => [file, await readFile(join(repository, file))])))
const evidenceRoot = join(repository, '.tmp/run-storage-observation-mutations')
await mkdir(evidenceRoot, { recursive: true })
const evidence = await mkdtemp(join(evidenceRoot, 'run-'))
const scratch = join(evidence, 'source')
const core = join(scratch, 'packages/core')
const cli = 'packages/core/bin/agentmux'
const receipt = { schema: 'agentmux.run-storage-observation-source-mutations.v1', passed: false,
  sourceBefore: Object.fromEntries([...original].map(([file, bytes]) => [file, digest(bytes)])),
  productionTest: test, compiledCli: cli, runtimeControl: [], sourceTreeWrites: 0, cases: [] }

async function treeManifest(directory, prefix = '') {
  const entries = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = join(prefix, entry.name), file = join(directory, entry.name)
    if (entry.isDirectory()) entries.push(...await treeManifest(file, relative))
    else if (entry.isFile()) entries.push([relative, digest(await readFile(file))])
  }
  return entries.sort(([left], [right]) => left.localeCompare(right))
}

async function run(label) {
  const report = join(evidence, `${label}.json`), loaded = join(evidence, `${label}-loaded.json`)
  const configuration = join(scratch, 'vitest.config.mts')
  await writeFile(configuration, `import {defineConfig} from 'vitest/config'; import {readFileSync,writeFileSync} from 'node:fs'; import {createHash} from 'node:crypto';\nconst files=${JSON.stringify(inputs.filter(file => file !== script).map(file => join(scratch, file)))}; const loaded={};\nexport default defineConfig({plugins:[{name:'exact-storage-source',enforce:'pre',transform(code,id){const file=id.split('?')[0]; if(files.includes(file)){loaded[file]={fileSha256:createHash('sha256').update(readFileSync(file)).digest('hex'),loadedCodeSha256:createHash('sha256').update(code).digest('hex'),loadedCode:code};writeFileSync(${JSON.stringify(loaded)},JSON.stringify(loaded,null,2))}}}],test:{include:[${JSON.stringify(test)}],environment:'node',maxWorkers:1,fileParallelism:false,passWithNoTests:false}})\n`)
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_')))
  const result = spawnSync(process.execPath, [join(repository, 'node_modules/vitest/vitest.mjs'), 'run',
    '--config', configuration, '--reporter=json', `--outputFile=${report}`],
  { cwd: scratch, env: environment, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })
  await writeFile(join(evidence, `${label}.log`), `${result.stdout ?? ''}${result.stderr ?? ''}`)
  assert.equal(result.error, undefined, `${label}: test process failed before its assertions`)
  assert.equal(result.signal, null, `${label}: test process was interrupted`)
  const summary = JSON.parse(await readFile(report, 'utf8'))
  const assertions = summary.testResults.flatMap(value => value.assertionResults)
  assert(assertions.length >= mutations.length, `${label}: empty or incomplete owning assertion set`)
  assert(summary.testResults.every(value => value.assertionResults.length > 0),
    `${label}: loading failure is not assertion RED`)
  assert.equal(summary.numTotalTests, assertions.length, `${label}: incomplete assertion execution`)
  assert.equal(summary.numPendingTests + summary.numTodoTests, 0, `${label}: skipped tests cannot qualify Source`)
  for (const mutation of mutations) assert(assertions.some(value => value.fullName.endsWith(mutation.assertion)),
    `${label}: owning production assertion was not collected`)
  const actual = JSON.parse(await readFile(loaded, 'utf8'))
  for (const file of inputs.filter(file => file !== script)) {
    const expected = digest(await readFile(join(scratch, file)))
    assert.equal(actual[join(scratch, file)]?.fileSha256, expected, `${label}: selected source was not loaded: ${file}`)
  }
  return { exitCode: result.status, assertions, report: `${label}.json`, log: `${label}.log`,
    loaded: `${label}-loaded.json` }
}
function requireGreen(result, label) {
  assert.equal(result.exitCode, 0, `${label}: selected Source did not pass`)
  assert(result.assertions.every(value => value.status === 'passed'), `${label}: incomplete restored GREEN`)
  return { exitCode: result.exitCode, executed: result.assertions.length, report: result.report,
    log: result.log, loaded: result.loaded }
}
function isAssertionFailure(message) {
  // Vitest's rejects getter throws Error before chai can name it AssertionError.
  return message.includes('AssertionError') || (message.startsWith('Error: promise resolved') &&
    message.includes('instead of rejecting') && message.includes('__VITEST_REJECTS__'))
}

try {
  await mkdir(core, { recursive: true })
  for (const directory of ['src', 'bin', 'dist', 'vendor']) await cp(join(repository, 'packages/core', directory), join(core, directory), { recursive: true })
  await mkdir(join(core, 'test'), { recursive: true })
  await cp(join(repository, 'packages/core/test/helpers'), join(core, 'test/helpers'), { recursive: true })
  await cp(join(repository, test), join(scratch, test))
  for (const file of ['package.json', 'tsconfig.base.json']) await cp(join(repository, file), join(scratch, file))
  await cp(join(repository, 'packages/core/package.json'), join(core, 'package.json'))
  await symlink(join(repository, 'node_modules'), join(scratch, 'node_modules'), 'dir')
  await symlink(join(repository, 'packages/core/node_modules'), join(core, 'node_modules'), 'dir')
  const closure = { src: Object.fromEntries(await treeManifest(join(core, 'src'))),
    helpers: Object.fromEntries(await treeManifest(join(core, 'test/helpers'))),
    dist: Object.fromEntries(await treeManifest(join(core, 'dist'))) }
  await writeFile(join(evidence, 'source-manifest.json'), JSON.stringify(closure, null, 2) + '\n')
  receipt.sourceManifestSha256 = digest(Buffer.from(JSON.stringify(closure, null, 2) + '\n'))
  const cliSource = await readFile(join(core, 'dist/agentmux.js'))
  const sdkEntry = fileURLToPath(import.meta.resolve('@ctxmux/sdk'))
  receipt.compiledCliSha256 = digest(cliSource)
  receipt.sdk = { entry: sdkEntry, sha256: digest(await readFile(sdkEntry)),
    clientSha256: digest(await readFile(join(dirname(sdkEntry), 'client.js'))) }
  receipt.baseline = requireGreen(await run('baseline-green'), 'baseline')
  for (const mutation of mutations) {
    const source = original.get(mutation.file).toString()
    assert.equal(source.split(mutation.before).length, 2, `${mutation.id}: expected one precise production seam`)
    const changed = source.replace(mutation.before, mutation.after)
    await writeFile(join(scratch, mutation.file), changed)
    try {
      const result = await run(`${mutation.id}-red`)
      assert.equal(result.exitCode, 1, `${mutation.id}: counterfactual was not rejected`)
      const failed = result.assertions.filter(value => value.status === 'failed')
      assert(failed.some(value => value.fullName.endsWith(mutation.assertion) &&
        value.failureMessages.some(isAssertionFailure)),
      `${mutation.id}: the owning behavioral assertion did not reject the loaded mutation`)
      const loaded = JSON.parse(await readFile(join(evidence, result.loaded), 'utf8'))[join(scratch, mutation.file)]
      assert(loaded.loadedCode.includes(mutation.after), `${mutation.id}: changed production fragment was not loaded`)
      receipt.cases.push({ id: mutation.id, source: mutation.file, sourceSha256: digest(Buffer.from(changed)),
        fragment: mutation.after, assertion: mutation.assertion, exitCode: result.exitCode,
        executed: result.assertions.length, failed: failed.map(value => value.fullName), report: result.report,
        log: result.log, loaded: result.loaded })
    } finally { await writeFile(join(scratch, mutation.file), original.get(mutation.file)) }
    receipt.cases.at(-1).restored = requireGreen(await run(`${mutation.id}-restore-green`), mutation.id)
  }
  receipt.sourceAfter = Object.fromEntries(await Promise.all(inputs.map(async file => [file, digest(await readFile(join(repository, file)))])))
  assert.deepEqual(receipt.sourceAfter, receipt.sourceBefore, 'Selected owning Source changed during this run')
  receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
finally {
  await rm(scratch, { recursive: true, force: true })
  receipt.cleanup = { privateSourceRemoved: true }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
assert.equal(receipt.passed, true, receipt.failure?.message)
console.log(JSON.stringify({ passed: true, mutants: receipt.cases.length, receipt: join(evidence, 'receipt.json') }))
