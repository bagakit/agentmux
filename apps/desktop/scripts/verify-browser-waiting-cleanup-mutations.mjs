import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '../../..')
const evidence = path.resolve(process.argv[2] ?? path.join(root, '.tmp/browser-waiting-cleanup-mutations'))
const isolated = await fs.mkdtemp(path.join(tmpdir(), 'amux-wait-cleanup-'))
const manager = 'apps/desktop/src/main/browser-view-manager.ts'
const session = 'apps/desktop/src/main/browser-cdp-session.ts'
const unit = 'apps/desktop/test/browser-cdp-session.test.ts'
const wiring = 'apps/desktop/test/browser-run-script-wiring.test.ts'
const native = 'apps/desktop/test/browser-ownership.test.ts'
const cases = [
  ['destroyed-debugger-still-accessed', session, 'if (this.contents.isDestroyed()) return null', 'if (false) return null', native],
  ['frame-owners-retained', session, 'this.frameSenders.clear()', '// frame ownership intentionally retained', unit],
  ['cleanup-warning-silent', session, 'return failures.length > 0', 'return false', unit],
  ['waiting-projection-disconnected', manager, 'BROWSER_WAIT_PAGE_CALLS.has(name)', 'false', wiring],
  ['wait-completion-does-not-restore', manager, "operation.phase === 'waiting' && beforeWaiting", 'false && beforeWaiting', wiring],
  ['wait-overwrites-human', manager, "operation.phase === 'waiting' && beforeWaiting", 'beforeWaiting', wiring],
  ['manager-discards-cleanup-warning', manager, 'if (cleanupWarning) {', 'if (false && cleanupWarning) {', wiring],
  ['run-injects-page-decoration', manager, 'this.emit(entry)\n    try {\n      const resultContext', "this.emit(entry)\n    void entry.view.webContents.executeJavaScriptInIsolatedWorld(1208, [{ code: 'document.createElement(\"div\")' }])\n    try {\n      const resultContext", wiring]
]
const inputs = [manager, session, unit, wiring, native, 'packages/core/src/browser-page-capability.ts']
const original = new Map(await Promise.all(inputs.map(async file => [file, await fs.readFile(path.join(root, file))])))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const receipt = { passed: false, candidate: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceHashes: Object.fromEntries([...original].map(([file, bytes]) => [file, hash(bytes)])), cases: [] }
await fs.mkdir(evidence, { recursive: true })
try {
  for (const directory of ['apps/desktop/src/main', 'apps/desktop/src/shared']) {
    await fs.cp(path.join(root, directory), path.join(isolated, directory), { recursive: true })
  }
  await fs.mkdir(path.join(isolated, 'apps/desktop/test'), { recursive: true })
  for (const file of [unit, wiring, native]) await fs.writeFile(path.join(isolated, file), original.get(file))
  await fs.symlink(path.join(root, 'node_modules'), path.join(isolated, 'node_modules'), 'dir')
  await fs.symlink(path.join(root, 'apps/desktop/node_modules'), path.join(isolated, 'apps/desktop/node_modules'), 'dir')
  await fs.writeFile(path.join(isolated, 'package.json'), '{"type":"module"}\n')
  const config = path.join(isolated, 'vitest.config.mjs')
  await fs.writeFile(config, `export default { define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, test: { include: ${JSON.stringify([unit, wiring, native])} } }\n`)
  const run = async (name, test) => {
    const args = [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', test, '--root', isolated, '--config', config, '--maxWorkers=1']
    if (test === wiring) args.push('-t', 'runScript waiting follows')
    const result = spawnSync(process.execPath, args, { cwd: isolated, encoding: 'utf8', timeout: 60_000 })
    const log = `${result.stdout ?? ''}${result.stderr ?? ''}`
    await fs.writeFile(path.join(evidence, `${name}.log`), log)
    return { exit: result.status, log }
  }
  for (const test of [unit, wiring, native]) assert.equal((await run(`baseline-${path.basename(test)}`, test)).exit, 0, `Baseline must pass: ${test}`)
  for (const [name, file, before, after, test] of cases) {
    const source = original.get(file).toString('utf8')
    assert.equal(source.split(before).length - 1, 1, `Unique source anchor: ${name}`)
    await fs.writeFile(path.join(isolated, file), source.replace(before, after))
    try {
      const red = await run(name, test)
      assert.notEqual(red.exit, 0, `Mutation survived: ${name}`)
      assert.match(red.log, /AssertionError/, `Must fail at behavioral assertions: ${name}`)
      receipt.cases.push({ name, file, redExit: red.exit, log: `${name}.log` })
    } finally { await fs.writeFile(path.join(isolated, file), original.get(file)) }
  }
  for (const test of [unit, wiring, native]) assert.equal((await run(`restored-${path.basename(test)}`, test)).exit, 0, `Restored source must pass: ${test}`)
  receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
finally {
  receipt.ownSourceUnchanged = Object.fromEntries(await Promise.all(inputs.map(async file => [file, hash(await fs.readFile(path.join(root, file))) === receipt.sourceHashes[file]])))
  await fs.writeFile(path.join(evidence, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
  await fs.rm(isolated, { recursive: true, force: true })
}
assert.equal(receipt.passed, true, receipt.failure?.message)
assert.equal(Object.values(receipt.ownSourceUnchanged).every(Boolean), true, 'Inspect source identity before closing the task')
console.log(JSON.stringify({ passed: true, mutants: receipt.cases.length, evidence }))
