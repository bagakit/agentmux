import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '../../..')
const evidence = path.resolve(process.argv[2] ?? path.join(root, '.tmp/browser-scoped-snapshot-mutations'))
const privateRoot = await fs.mkdtemp(path.join(tmpdir(), 'amux-scoped-mutations-'))
const dispatch = 'apps/desktop/src/main/browser-page-dispatch.ts'
const engine = 'apps/desktop/src/main/browser-page-snapshot.ts'
const query = 'apps/desktop/src/main/browser-snapshot-query.ts'
const test = 'apps/desktop/test/browser-scoped-snapshot.test.ts'
const cases = [
  ['ref-reuse', dispatch, 'nextRef: () => `@e${(refCounter! += 1)}`', "nextRef: () => '@e1'"],
  ['scope-exclusion-as-failed-read', query, 'missingFrames: snapshot.missingFrames,', "missingFrames: [...snapshot.missingFrames, ...facts.omittedFrames.map(frameId => ({ frameId, reason: 'excluded by scope' }))],"],
  ['scoped-ordinal-replaces-full-ordinal', dispatch, 'const ledger = ledgerFromSnapshot(snapshot)', 'const ledger = ledgerFromSnapshot(projected)'],
  ['output-budget-disconnected', query, 'const nodes = matched.slice(0, query.maxNodes)', 'const nodes = matched'],
  ['partial-graph-replaces-owner', dispatch, 'const projected = projectBrowserSnapshot(snapshot, snapshot.scopeFacts, query)', 'const projected = projectBrowserSnapshot(snapshot, snapshot.scopeFacts, query)\n    current = projected'],
  ['frame-identity-disconnected', engine, "const scopedDocument = input.withinTarget?.sessionId ?? 'main'", "const scopedDocument = 'main'"],
  ['expired-ref-diagnostic-disconnected', dispatch, 'if (expired.has(ref)) throw new Error(`${ref} was superseded by a later snapshot in this run. Use a ref from the latest snapshot().`)', '']
]
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const inputs = [...new Set([...cases.map(([, file]) => file), test, 'apps/desktop/src/shared/browser-snapshot-query.ts'])]
const original = new Map(await Promise.all(inputs.map(async file => [file, await fs.readFile(path.join(root, file))])))
const receipt = { passed: false, candidate: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), sourceHashes: Object.fromEntries([...original].map(([file, bytes]) => [file, digest(bytes)])), cases: [] }
await fs.mkdir(evidence, { recursive: true })
try {
  // Copy only this production import graph and its behavioral oracle. The private
  // config has no Core dist guard because this graph has no Core runtime imports.
  // No production file or shared worktree is ever mutated.
  for (const directory of ['apps/desktop/src/main', 'apps/desktop/src/shared']) {
    await fs.cp(path.join(root, directory), path.join(privateRoot, directory), { recursive: true })
  }
  await fs.mkdir(path.dirname(path.join(privateRoot, test)), { recursive: true })
  await fs.writeFile(path.join(privateRoot, test), original.get(test))
  await fs.symlink(path.join(root, 'node_modules'), path.join(privateRoot, 'node_modules'), 'dir')
  await fs.writeFile(path.join(privateRoot, 'package.json'), '{"type":"module"}\n')
  const config = path.join(privateRoot, 'vitest.config.mjs')
  await fs.writeFile(config, `export default { test: { include: [${JSON.stringify(test)}] } }\n`)
  const run = async name => {
    const result = spawnSync(process.execPath, [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--root', privateRoot, '--config', config, '--maxWorkers=1'], { cwd: privateRoot, encoding: 'utf8', timeout: 30_000 })
    const log = `${result.stdout ?? ''}${result.stderr ?? ''}`
    await fs.writeFile(path.join(evidence, `${name}.log`), log)
    return { exit: result.status, log, error: result.error?.message }
  }
  const baseline = await run('baseline-green')
  assert.equal(baseline.exit, 0, baseline.log)
  for (const [name, file, before, after] of cases) {
    const source = original.get(file).toString('utf8')
    assert.equal(source.split(before).length - 1, 1, `Mutation anchor is not unique: ${name}`)
    await fs.writeFile(path.join(privateRoot, file), source.replace(before, after))
    try {
      const red = await run(name)
      assert.notEqual(red.exit, 0, `Mutation survived: ${name}`)
      assert.match(red.log, /AssertionError/, `Mutation failed before behavioral assertions: ${name}`)
      receipt.cases.push({ name, file, redExit: red.exit, log: `${name}.log` })
    } finally {
      await fs.writeFile(path.join(privateRoot, file), original.get(file))
    }
  }
  const restored = await run('restored-green')
  assert.equal(restored.exit, 0, restored.log)
  receipt.restoredGreen = { exit: restored.exit, log: 'restored-green.log' }
  receipt.passed = true
} catch (error) {
  receipt.failure = { message: error.message, stack: error.stack }
} finally {
  receipt.ownSourceUnchanged = Object.fromEntries(await Promise.all(inputs.map(async file => [file, digest(await fs.readFile(path.join(root, file))) === receipt.sourceHashes[file]])))
  await fs.writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  await fs.rm(privateRoot, { recursive: true, force: true })
}
assert.equal(receipt.passed, true, receipt.failure?.message)
assert.equal(Object.values(receipt.ownSourceUnchanged).every(Boolean), true, 'Owning sources changed during isolated proof; inspect receipt before closing the task')
console.log(JSON.stringify({ passed: true, mutants: receipt.cases.length, sourceUnchanged: true, evidence }))
