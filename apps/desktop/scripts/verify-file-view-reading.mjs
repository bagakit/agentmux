import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '../../..')
const output = resolve(root, process.argv.find(value => value.startsWith('--output='))?.slice(9) ?? '.tmp/file-view-reading')
const unitOnly = process.argv.includes('--unit-only')
const nativePath = resolve(root, process.argv.find(value => value.startsWith('--native-receipt='))?.slice(17) ?? process.env.FILE_VIEW_READING_NATIVE_RECEIPT ?? '.tmp/file-view-reading/native-restart.json')
await mkdir(output, { recursive: true })
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const paths = ['apps/desktop/src/main/workbench-user-state.ts', 'apps/desktop/src/shared/workbench-user-state.ts', 'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/lib/file-view-reading.ts', 'apps/desktop/src/renderer/src/lib/use-workspace-file-source.ts', 'apps/desktop/src/renderer/src/components/BookPreview.tsx', 'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/preload/index.ts', 'apps/desktop/src/shared/contracts.ts', 'packages/editor-extensions/src/book-reader/BookReader.tsx', 'apps/desktop/test/file-view-reading.test.ts', 'apps/desktop/test/vitest.file-view-reading.config.mts', 'apps/desktop/scripts/verify-file-view-reading.mjs']
const sources = async () => Object.fromEntries(await Promise.all(paths.map(async path => [path, sha(await readFile(join(root, path)))])))
const receipt = { schema: 'agentmux.file-view-reading-verification.v1', passed: false, complete: false, scope: unitOnly ? 'targeted owner, Store and loaded mutations only; native restart remains required' : 'native member owner and actual Store, loaded mutations, source-bound shared File UI two-process restart', sources: await sources(), mutations: [] }
// These tests load the native member owner, Store and binding helper. The book frame,
// IPC and preload are independently source-bound by the shared native receipt.
const unitPaths = ['apps/desktop/src/main/workbench-user-state.ts', 'apps/desktop/src/shared/workbench-user-state.ts', 'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/lib/file-view-reading.ts', 'apps/desktop/test/file-view-reading.test.ts', 'apps/desktop/test/vitest.file-view-reading.config.mts']
let previous
try { previous = JSON.parse(await readFile(join(output, 'receipt.json'), 'utf8')) } catch {}
const reusable = previous?.baseline?.passed === 15 && previous.baseline.exitCode === 0 && previous.restored?.passed === 15 && previous.restored.exitCode === 0 &&
  previous.mutations?.length === 9 && previous.mutations.every(value => value.failed === 1 && value.assertionFailures && value.exitCode !== 0) &&
  unitPaths.every(path => previous.sources?.[path] === receipt.sources[path]) && previous.mutations.every(value => previous.loaded?.some(hit => hit.name === value.name && hit.original === receipt.sources[hit.file] && hit.loaded !== hit.original))
const hits = join(output, 'mutation-loaded.ndjson'); if (!reusable) await writeFile(hits, '')
const run = async (name, mutation, pattern) => {
  const report = join(output, name + '-tests.json')
  const child = spawnSync(join(root, 'node_modules/.bin/vitest'), ['run', '--config', 'apps/desktop/test/vitest.file-view-reading.config.mts', '--reporter=json', '--outputFile=' + report, ...(pattern ? ['--testNamePattern', pattern] : [])], { cwd: root, env: { ...process.env, FILE_VIEW_READING_MUTATION: mutation ?? '', FILE_VIEW_READING_HITS: hits, FILE_VIEW_READING_COST: join(output, 'cost.json') }, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  const result = JSON.parse(await readFile(report, 'utf8'))
  assert.equal(result.numTotalTests, 15, 'Every intended nonempty owner test is collected')
  assert.equal(result.numPassedTests + result.numFailedTests, pattern ? 1 : 15, 'The intended behavior actually executes')
  assert.equal(result.testResults.length, 1, 'Only the exact owning test file is authoritative')
  const failed = result.testResults.flatMap(value => value.assertionResults).filter(value => value.status === 'failed')
  return { name, exitCode: child.status, passed: result.numPassedTests, failed: result.numFailedTests, assertionFailures: failed.length > 0 && failed.every(value => value.failureMessages.some(message => /AssertionError|__VITEST_REJECTS__/.test(message))), report, stderr: child.stderr }
}
try {
  if (reusable) {
    for (const key of ['baseline', 'mutations', 'loaded', 'restored', 'cost']) receipt[key] = previous[key]
    receipt.reusedUnitReceipt = sha(JSON.stringify(previous))
  } else {
  receipt.baseline = await run('baseline'); assert.equal(receipt.baseline.exitCode, 0, receipt.baseline.stderr)
  for (const [name, pattern] of Object.entries({ graph: 'uses one physical', qualified: 'refuses writes', witness: 'refuses writes', stale: 'preserves the Region key', receipt: 'rejects wrong receipts', baseline: 'keeps initial unread', capture: 'captures the actual final', root: 'keeps ordinary root fences', namespace: 'requires the existing App root' })) {
    const red = await run("mutation-" + name, name, pattern); assert.notEqual(red.exitCode, 0, name + ' must turn RED'); assert.ok(red.failed > 0 && red.assertionFailures, name + ' must fail a business assertion, not import/setup'); receipt.mutations.push({ ...red, name })
  }
  receipt.loaded = (await readFile(hits, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  for (const item of receipt.mutations) assert.ok(receipt.loaded.some(hit => hit.name === item.name && hit.original === receipt.sources[hit.file] && hit.original !== hit.loaded), item.name + ' must load the recorded original source and exactly one changed anchor')
  receipt.restored = await run('restored'); assert.equal(receipt.restored.exitCode, 0, receipt.restored.stderr)
  receipt.cost = JSON.parse(await readFile(join(output, 'cost.json'), 'utf8'))
  assert.deepEqual([receipt.cost.sessionReads, receipt.cost.pathReads, receipt.cost.graphInvalidations, receipt.cost.rootReadOrWrite], [0, 0, 0, false])
  assert.ok(receipt.cost.memberWriteBytes > 0 && receipt.cost.memberWriteBytes < 512)
  }
  if (!unitOnly) {
    const native = JSON.parse(await readFile(nativePath, 'utf8'))
    assert.equal(native.schema, 'agentmux.book-file-restart.v1')
    assert.ok(!native.writer.failure && !native.reader.failure && native.reader.restored === true, 'Both actual native File processes must succeed')
    assert.ok(native.writer.checks > 0 && native.reader.checks > 0 && native.processes.length === 2 && native.processes.every(item => item.exitCode === 0), 'Two real native processes have nonempty assertions')
    assert.ok(native.writer.readingReceipt.position.progress > .79 && native.reader.physicalProgress > .77, 'Real DOM latest position before 500ms and physical restart restoration are proved')
    for (const path of paths.filter(value => /src\//.test(value) && !value.endsWith('/shared/contracts.ts'))) assert.equal(native.sourceHashes[path], receipt.sources[path], 'Shared native proof consumes current source: ' + path)
    receipt.native = { path: nativePath, sha256: sha(await readFile(nativePath)), writerChecks: native.writer.checks, readerChecks: native.reader.checks, physicalProgress: native.reader.physicalProgress, readingReceipt: native.writer.readingReceipt }
    receipt.complete = true
  }
  const current = await sources()
  for (const path of unitPaths) assert.equal(current[path], receipt.sources[path], 'Actual unit owner source stayed unchanged: ' + path)
  if (receipt.complete) assert.deepEqual(current, receipt.sources, 'Native consumer source stayed unchanged during the join')
  else receipt.sources = current
  receipt.unitSources = Object.fromEntries(unitPaths.map(path => [path, current[path]]))
  receipt.passed = true
} catch (error) { receipt.failure = error.stack ?? String(error) }
await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify({ passed: receipt.passed, complete: receipt.complete, output, tests: receipt.baseline?.passed, mutations: receipt.mutations.length, cost: receipt.cost, failure: receipt.failure }))
process.exitCode = receipt.passed ? 0 : 1
