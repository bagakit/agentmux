import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { bundlePrivateNodeSource } from '../../core/test/helpers/private-node-source-bundle.mjs'
import { workspaceSourceExport } from '../../core/test/helpers/workspace-source-export.mjs'
import { bundleIdentityRuntime } from '../../identity/scripts/runtime-bundle.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const store = 'packages/demand/src/demand-store.ts'
const hash = value => createHash('sha256').update(value).digest('hex')
const run = promisify(execFile)
const args = process.argv.slice(2)
assert.ok(!args.length || args.length === 2 && args[0] === '--case', 'Usage: verify-writer-lock-recovery.mjs [--case name]')
const selected = args[1] ?? 'all'
const mutants = {
  'skip-kernel': { case: 'kernel-exclusion', edits: [["while (!locked && !native.tryLock(handle.fd))", 'while (false)']] },
  'adopt-unknown': { case: 'legacy-unknown', edits: [["if (marker.subarray(0, bytesRead).toString('utf8') !== WRITER_LOCK_MARKER)", 'if (false)']] },
  'publish-before-complete': { case: 'atomic-publication', edits: [
    ["          await handle.writeFile(WRITER_LOCK_MARKER, 'utf8')\n          await handle.sync()\n", ''],
    ['try { await fs.link(temporary, this.lockPath) }', "try { await fs.link(temporary, this.lockPath); await handle.writeFile(WRITER_LOCK_MARKER, 'utf8'); await handle.sync() }"]
  ] },
  'unlink-release': { case: 'permanent-inode', edits: [['try { await acquired.close() }', 'try { await acquired.close(); await fs.rm(this.lockPath, { force: true }) }']] }
}
const directory = join(root, 'packages/demand/.tmp/writer-lock-recovery')
await fs.mkdir(directory, { recursive: true })
const attempt = await fs.mkdtemp(join(directory, 'attempt-')), compiled = join(attempt, 'compiled')
await fs.mkdir(compiled)
const receipt = { schema: 'agentmux.demand-writer-lock-proof.v1', selected, attempt: relative(root, attempt), startedAt: new Date().toISOString(),
  runs: [], source: {}, passed: false, compiledRemoved: false }
const demandRequire = createRequire(join(root, 'packages/demand/package.json'))
const nativeEntry = demandRequire.resolve('fs-native-extensions')
receipt.nativeDependency = { entry: nativeEntry, sha256: hash(await fs.readFile(nativeEntry)),
  version: demandRequire('fs-native-extensions/package.json').version, realTryLock: typeof demandRequire('fs-native-extensions').tryLock === 'function' }
assert.equal(receipt.nativeDependency.version, '1.5.1'); assert.equal(receipt.nativeDependency.realTryLock, true)
const observed = new Set([store, 'packages/demand/src/cli.ts', 'apps/host/src/goals.ts', 'packages/core/src/public-rpc-service.ts'])
const sourceFiles = [store, 'packages/demand/package.json', 'packages/demand/test/writer-lock-worker.mjs', 'packages/demand/test/writer-lock-host.mjs',
  'packages/demand/test/writer-lock-scenes.mjs', 'packages/demand/scripts/verify-writer-lock-recovery.mjs',
  'packages/core/test/helpers/private-node-source-bundle.mjs', 'packages/core/test/helpers/workspace-source-export.mjs',
  'packages/identity/scripts/runtime-bundle.mjs', ...(await fs.readdir(join(root, 'packages/identity/src'))).filter(file => file.endsWith('.ts')).map(file => 'packages/identity/src/' + file)]
for (const path of sourceFiles) receipt.source[path] = hash(await fs.readFile(join(root, path)))
let identitySource
try {
  if (selected === 'all' || selected === 'host-public-and-async-wait') {
    identitySource = join(compiled, 'identity-runtime-source.mjs')
    const runtime = await bundleIdentityRuntime()
    await fs.writeFile(identitySource, 'export const identityRuntimeSource = ' + JSON.stringify(runtime.source) + ';\n')
    receipt.identityRuntime = { generatedSHA256: hash(await fs.readFile(identitySource)), sourceSHA256: hash(runtime.source) }
  }
  const loaded = join(attempt, 'evaluated.jsonl')
  const instrument = mutant => (original, path) => {
    let content = original, applied = false
    if (path === store && mutant) {
      for (const [from, to] of mutants[mutant].edits) {
        assert.equal(content.split(from).length, 2, 'mutation must hit exactly one current source anchor: ' + mutant)
        content = content.replace(from, to); applied = true
      }
    }
    if (observed.has(path)) content = `import { appendFileSync as __writerProof } from 'node:fs'; __writerProof(${JSON.stringify(loaded)}, ${JSON.stringify(JSON.stringify({ path, originalSHA256: hash(original), effectiveSHA256: hash(content), mutant: applied ? mutant : null }) + '\n')});\n` + content
    return content
  }
  const sourceExport = id => id === '@agentmux/identity/runtime-source' ? identitySource : workspaceSourceExport(root, id)
  const build = async (entry, name, mutant) => {
    const result = await bundlePrivateNodeSource({ root, entry, file: join(compiled, name + '.mjs'), sourceExport, instrument: instrument(mutant) })
    return result
  }
  const worker = await build('packages/demand/test/writer-lock-worker.mjs', 'worker')
  const cli = await build('packages/demand/bin/agentmux-demand.ts', 'cli')
  const host = identitySource ? await build('packages/demand/test/writer-lock-host.mjs', 'host') : null
  const records = [worker, cli, ...(host ? [host] : [])]
  receipt.bundles = records.map(value => value.record)
  const execute = async (label, workerFile, which, red = false) => {
    let result
    try { result = await run(process.execPath, [join(root, 'packages/demand/test/writer-lock-scenes.mjs'), workerFile, cli.file, host?.file ?? '', which], { cwd: root, timeout: 90_000, maxBuffer: 4 * 1024 * 1024 }) }
    catch (error) { result = { stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.code, signal: error.signal } }
    await fs.writeFile(join(attempt, label + '.log'), result.stdout + result.stderr)
    const cases = result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    const record = { label, cases, exitCode: result.code ?? 0, signal: result.signal ?? null, logSHA256: hash(result.stdout + result.stderr) }
    receipt.runs.push(record)
    assert.ok(cases.length > 0, 'no empty proof')
    assert.ok(cases.every(value => value.privateRootRemoved && value.cleanupErrors.length === 0), 'all exact private resources must be cleaned')
    if (red) {
      assert.equal(record.exitCode, 1, 'mutant must fail an actual assertion')
      assert.equal(cases.length, 1)
      assert.equal(cases[0].code, 'ERR_ASSERTION', 'infrastructure errors and timeouts are not mutant kills')
      assert.equal(cases[0].passed, false)
    } else {
      assert.equal(record.exitCode, 0, label + ' must pass; see ' + join(attempt, label + '.log'))
      assert.ok(cases.every(value => value.passed))
      assert.equal(cases.length, which === 'all' ? 8 : 1)
    }
    console.log(label + ': ' + (red ? 'assertion RED' : `${cases.length} GREEN`))
  }
  await execute('baseline', worker.file, selected)
  if (selected === 'all') for (const [name, mutation] of Object.entries(mutants)) {
    const changed = await build('packages/demand/test/writer-lock-worker.mjs', name, name); records.push(changed); receipt.bundles = records.map(value => value.record)
    await execute(name, changed.file, mutation.case, true)
    await execute(name + '-restored', worker.file, mutation.case)
  }
  const evaluations = (await fs.readFile(loaded, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.ok(evaluations.some(value => value.path === store && value.mutant === null), 'real Store must execute')
  assert.ok(evaluations.some(value => value.path === 'packages/demand/src/cli.ts'), 'real CLI must execute')
  if (host) for (const path of ['apps/host/src/goals.ts', 'packages/core/src/public-rpc-service.ts']) assert.ok(evaluations.some(value => value.path === path), 'real public consumer must execute: ' + path)
  if (selected === 'all') for (const name of Object.keys(mutants)) assert.ok(evaluations.some(value => value.path === store && value.mutant === name && value.originalSHA256 !== value.effectiveSHA256), 'mutant must execute: ' + name)
  receipt.bundles = records.map(value => value.record)
  for (const record of records) for (const source of record.record.sources) {
    if (resolve(root, source.path).startsWith(compiled + '/')) continue
    assert.equal(hash(await fs.readFile(join(root, source.path))), source.originalSHA256, 'compiled source changed: ' + source.path)
  }
  for (const [file, original] of Object.entries(receipt.source)) assert.equal(hash(await fs.readFile(join(root, file))), original, 'candidate changed during proof: ' + file)
  receipt.sourceStable = true; receipt.passed = true
} catch (error) { receipt.error = error.stack; process.exitCode = 1 }
finally {
  await fs.rm(compiled, { recursive: true, force: true })
  receipt.compiledRemoved = await fs.stat(compiled).then(() => false, error => { if (error.code !== 'ENOENT') throw error; return true })
  receipt.finishedAt = new Date().toISOString()
  await fs.writeFile(join(attempt, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log('Receipt: ' + join(attempt, 'receipt.json'))
  if (!receipt.passed) console.error(receipt.error)
}
