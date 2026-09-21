import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '../../..')
const evidence = path.resolve(process.argv[2] ?? path.join(root, `.tmp/browser-download-glue-mutations-${Date.now()}`))
const isolated = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'amux-download-glue-')))
const manager = 'apps/desktop/src/main/browser-view-manager.ts'
const dispatch = 'apps/desktop/src/main/browser-page-dispatch.ts'
const test = 'apps/desktop/test/browser-run-script-wiring.test.ts'
const cases = [
  ['download-owner-disconnected', manager, 'this.downloads && signal ? { downloads:', 'false && signal ? { downloads:'],
  ['download-stop-signal-disconnected', manager, 'store: this.downloads, signal, context:', 'store: this.downloads, signal: new AbortController().signal, context:'],
  ['foreign-browser-can-read-reference', dispatch, '{ workspaceId: owner.workspaceId, browserId: owner.browserId }, options as BrowserDownloadReadOptions', '{ workspaceId: (args[0]).workspaceId, browserId: (args[0]).browserId }, options as BrowserDownloadReadOptions'],
  ['continuation-replays-download-action', dispatch, 'const owner = context.downloads.context()', 'await callOn("@e1", "function () { this.click() }"); const owner = context.downloads.context()'],
  ['download-warning-not-projected', dispatch, 'if (warning) context.note(warning)', 'void warning'],
  ['download-options-guard-removed', dispatch, "Object.keys(options).some(key => !['path', 'timeoutMs', 'maxBytes'].includes(key))", 'false'],
  ['human-takeover-permits-download', manager, 'takeover.at !== null && BROWSER_ACTION_PAGE_CALLS.has(name)', "takeover.at !== null && name !== 'download' && BROWSER_ACTION_PAGE_CALLS.has(name)"],
  ['native-download-trigger-disconnected', dispatch, "async () => await callOn(ref, 'function () { this.scrollIntoView({block: \"center\"}); this.click() }')", 'async () => undefined']
]
const inputs = [manager, dispatch, test]
const originals = new Map(await Promise.all(inputs.map(async file => [file, await fs.readFile(path.join(root, file))])))
assert.equal(originals.size, inputs.length, 'Source input collection must be nonempty and exact.')
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
    const result = spawnSync(process.execPath, [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', test, '-t', 'native downloads via', '--root', isolated, '--config', config, '--maxWorkers=1'], { cwd: isolated, encoding: 'utf8', timeout: 60_000 })
    const log = `${result.stdout ?? ''}${result.stderr ?? ''}`
    await fs.writeFile(path.join(evidence, `${name}.log`), log)
    return { exit: result.status, log }
  }
  assert.equal((await run('baseline')).exit, 0, 'The unmodified source must pass.')
  for (const [name, file, before, after] of cases) {
    const source = originals.get(file).toString('utf8')
    assert.equal(source.split(before).length - 1, 1, `Unique source anchor: ${name}`)
    await fs.writeFile(path.join(isolated, file), source.replace(before, after))
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
