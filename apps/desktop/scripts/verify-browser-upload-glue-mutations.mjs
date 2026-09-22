import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '../../..')
const evidence = path.resolve(process.argv[2] ?? path.join(root, `.tmp/browser-upload-glue-mutations-${Date.now()}`))
const isolated = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'amux-upload-glue-')))
const manager = 'apps/desktop/src/main/browser-view-manager.ts'
const dispatch = 'apps/desktop/src/main/browser-page-dispatch.ts'
const test = 'apps/desktop/test/browser-run-script-wiring.test.ts'
const cases = [
  ['upload-stop-during-workspace-io-proof-removed', manager, "if (signal?.aborted) throw new Error('This Browser operation stopped before file assignment could be confirmed.')", 'void signal'],
  ['upload-takeover-during-workspace-io-proof-removed', manager, "if (takeover.at !== null) throw new Error('Human took control before file assignment could be confirmed.')", 'void takeover'],
  ['upload-original-view-source-proof-removed', manager, "if (view !== observingView) throw new Error('The Browser view changed before upload.')", 'void view'],
  ['upload-original-view-current-proof-removed', manager, "if (currentView !== observingView) throw new Error('The Browser view changed during upload.')", 'void currentView'],
  ['upload-owner-disconnected', manager, 'this.uploads ? { uploads:', 'false ? { uploads:'],
  ['upload-issued-ref-proof-removed', dispatch, '!current || !issued?.has(ref) || expired.has(ref)', '!current || expired.has(ref)'],
  ['upload-uses-main-sender-for-iframe', dispatch, 'target: { objectId: target.objectId, sendCommand: target.send }', 'target: { objectId: target.objectId, sendCommand: session.sendCommand }'],
  ['uncertain-upload-warning-disconnected', dispatch, 'if (error instanceof BrowserUploadUnconfirmedError) context.note(error.message)', 'void error'],
  ['script-completion-deletes-file-list', manager, 'const cleanupWarning = session.detach()', 'await this.uploads?.releaseBrowser(entry.id); const cleanupWarning = session.detach()'],
  ['same-document-history-deletes-file-list', manager, 'if (!details.isSameDocument) this.releaseUploadFiles(entry)', 'this.releaseUploadFiles(entry)'],
  ['navigation-does-not-release-file-list', manager, 'if (!details.isSameDocument) this.releaseUploadFiles(entry)', 'void details.isSameDocument'],
  ['human-takeover-permits-file-selection', manager, 'takeover.at !== null && BROWSER_ACTION_PAGE_CALLS.has(name)', "takeover.at !== null && name !== 'uploadFiles' && BROWSER_ACTION_PAGE_CALLS.has(name)"],
  ['upload-cleanup-warning-hidden', manager, "entry.activity = { ...entry.activity, warning: 'Selected-file staging could not be fully released. The Browser remains usable; navigate or close it to retry cleanup.' }", 'void entry.activity']
]
const inputs = [manager, dispatch, test]
const originals = new Map(await Promise.all(inputs.map(async file => [file, await fs.readFile(path.join(root, file))])))
assert.equal(originals.size, inputs.length, 'Source inputs must be nonempty and exact.')
assert.ok(cases.length > 0, 'Mutation cases must be nonempty.')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const receipt = { passed: false, candidate: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceHashes: Object.fromEntries([...originals].map(([file, bytes]) => [file, hash(bytes)])), cases: [] }
await fs.mkdir(evidence, { recursive: true })
try {
  for (const directory of ['apps/desktop/src/main', 'apps/desktop/src/shared']) await fs.cp(path.join(root, directory), path.join(isolated, directory), { recursive: true })
  await fs.symlink(path.join(root, 'apps/desktop/resources'), path.join(isolated, 'apps/desktop/resources'), 'dir')
  await fs.mkdir(path.join(isolated, path.dirname(test)), { recursive: true })
  await fs.writeFile(path.join(isolated, test), originals.get(test))
  await fs.symlink(path.join(root, 'node_modules'), path.join(isolated, 'node_modules'), 'dir')
  await fs.symlink(path.join(root, 'apps/desktop/node_modules'), path.join(isolated, 'apps/desktop/node_modules'), 'dir')
  await fs.writeFile(path.join(isolated, 'package.json'), '{"type":"module"}\n')
  const config = path.join(isolated, 'vitest.config.mjs')
  await fs.writeFile(config, `export default { test: { include: [${JSON.stringify(test)}] } }\n`)
  const run = async name => {
    const result = spawnSync(process.execPath, [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', test, '-t', 'file upload via', '--root', isolated, '--config', config, '--maxWorkers=1'], { cwd: isolated, encoding: 'utf8', timeout: 60_000 })
    const log = `${result.stdout ?? ''}${result.stderr ?? ''}`
    await fs.writeFile(path.join(evidence, `${name}.log`), log)
    return { exit: result.status, log }
  }
  assert.equal((await run('baseline')).exit, 0, 'The unmodified source must pass.')
  for (const [name, file, before, after] of cases) {
    const source = originals.get(file).toString('utf8')
    assert.equal(source.split(before).length - 1, 1, `Unique source anchor: ${name}`)
    let mutated = source.replace(before, after)
    if (name === 'upload-issued-ref-proof-removed') {
      const secondary = 'current !== snapshot || !issued?.has(ref) || expired.has(ref) || context.pageInfo().navigationId !== snapshot.navigationId'
      assert.equal(source.split(secondary).length - 1, 1, 'Post-resolution issued proof must exist exactly once.')
      mutated = mutated.replace(secondary, 'current !== snapshot || expired.has(ref) || context.pageInfo().navigationId !== snapshot.navigationId')
    }
    if (name === 'human-takeover-permits-file-selection') {
      // Remove the authorization rule at every relevant read, including the asynchronous IO boundary.
      // Removing only the outer action gate is caught by the inner guard and cannot model unauthorized assignment.
      const secondary = "if (takeover.at !== null) throw new Error('Human took control before file assignment could be confirmed.')"
      assert.equal(source.split(secondary).length - 1, 1, 'Async upload takeover proof must exist exactly once.')
      mutated = mutated.replace(secondary, 'void takeover')
    }
    await fs.writeFile(path.join(isolated, file), mutated)
    try {
      const red = await run(name)
      assert.notEqual(red.exit, 0, `Mutation survived: ${name}`)
      assert.match(red.log, /AssertionError/, `Mutation must fail a behavioral assertion: ${name}`)
      receipt.cases.push({ name, file, redExit: red.exit, log: `${name}.log` })
    } finally { await fs.writeFile(path.join(isolated, file), originals.get(file)) }
  }
  assert.equal((await run('restored')).exit, 0, 'Restored source must pass.')
  receipt.copyAfter = Object.fromEntries(await Promise.all(inputs.map(async file => [file, hash(await fs.readFile(path.join(isolated, file)))])))
  assert.deepEqual(receipt.copyAfter, receipt.sourceHashes, 'Every mutated input must be restored.')
  receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
finally {
  receipt.ownSourceUnchanged = Object.fromEntries(await Promise.all(inputs.map(async file => [file, hash(await fs.readFile(path.join(root, file))) === receipt.sourceHashes[file]])))
  await fs.writeFile(path.join(evidence, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
  await fs.rm(isolated, { recursive: true, force: true })
  receipt.cleanup = {copyRemoved: true}
  await fs.writeFile(path.join(evidence, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
}
assert.equal(receipt.passed, true, receipt.failure?.message)
assert.equal(Object.keys(receipt.ownSourceUnchanged).length, inputs.length)
assert.equal(Object.values(receipt.ownSourceUnchanged).every(Boolean), true, 'Inspect concurrent edits before closing the slice.')
console.log(JSON.stringify({ passed: true, mutants: receipt.cases.length, evidence }))
