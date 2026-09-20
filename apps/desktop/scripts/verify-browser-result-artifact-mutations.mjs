import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '../../..')
const evidence = path.resolve(process.argv[2] ?? path.join(root, '.tmp/browser-result-artifact-mutations'))
const privateRoot = await fs.mkdtemp(path.join(tmpdir(), 'amux-result-mutations-'))
const store = 'apps/desktop/src/main/browser-result-artifact.ts'
const runner = 'apps/desktop/src/main/browser-script-runner.ts'
const outcome = 'apps/desktop/src/main/browser-run-outcome.ts'
const test = 'apps/desktop/test/browser-result-artifact.test.ts'
const managerTest = 'apps/desktop/test/browser-run-script-wiring.test.ts'
const workspaceTest = 'apps/desktop/test/browser-workspace-binding.test.ts'
const nativeTest = 'apps/desktop/test/browser-result-artifact-native.test.ts'
const dispatch = 'apps/desktop/src/main/browser-page-dispatch.ts'
const manager = 'apps/desktop/src/main/browser-view-manager.ts'
const binding = 'apps/desktop/src/main/browser-workspace-binding.ts'
const cases = [
  ['large-result-back-on-stdout', runner, 'Buffer.byteLength(encoded) > ${BROWSER_RESULT_INLINE_BYTES}', 'Buffer.byteLength(encoded) > Infinity'],
  ['failed-save-as-empty-success', runner, "return { logs, completed: false, failure: { kind: 'result-unavailable', message: error instanceof Error ? error.message : String(error) } }", 'return { logs, completed: true, value: undefined }'],
  ['foreign-workspace-accepted', store, 'current.workspaceId !== reference.workspaceId', 'false'],
  ['original-operation-not-checked', store, 'a.browserId === b.browserId && a.operationId === b.operationId &&', 'a.browserId === b.browserId &&'],
  ['original-navigation-not-checked', store, 'a.navigationId === b.navigationId && a.format === b.format &&', 'a.format === b.format &&'],
  ['read-budget-disconnected', store, 'maxBytes > BROWSER_RESULT_MAX_READ_BYTES', 'false'],
  ['payload-integrity-disconnected', store, 'hash(payload.subarray(start, start + CHUNK_BYTES)) !== metadata.chunks[startChunk + start / CHUNK_BYTES]', 'false'],
  ['store-budget-disconnected', store, 'this.totalBytes + size <= MAX_STORE_BYTES', 'true'],
  ['source-context-rebound', store, 'const source = { ...context, workspaceId }', 'const source = context'],
  ['indeterminate-as-retryable-failure', outcome, "'result-unavailable': (failure) => ({ kind: 'indeterminate', message: describe(failure) })", "'result-unavailable': (failure) => ({ kind: 'script-failed', message: describe(failure) })"],
  ['continuation-replays-action', dispatch, 'return await readBrowserResultArtifact(context.resultArtifacts.store,', "await session.sendCommand('Runtime.evaluate', { expression: 'globalThis.actionCount += 1', returnByValue: true })\n        return await readBrowserResultArtifact(context.resultArtifacts.store,", nativeTest],
  ['manager-source-wrong-operation', manager, 'workspaceId: entry.workspaceId, browserId: entry.id, operationId: operation.id,', "workspaceId: entry.workspaceId, browserId: entry.id, operationId: 'another-operation',", managerTest],
  ['manager-capture-disconnected', manager, 'await this.resultArtifacts!.import(resultContext, sourcePath)', "Promise.reject(new Error('capture disconnected'))", managerTest],
  ['restore-rebinds-workspace', manager, 'viewport, released.workspaceId)', 'viewport, input?.workspaceId ?? null)', managerTest],
  ['main-guesses-first-workspace', binding, '? requested : null', '? requested : workspaces[0]?.id ?? null', workspaceTest]
]
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const inputs = [...new Set([...cases.map(([, file]) => file), test, managerTest, workspaceTest, nativeTest,
  'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/preload/index.ts', 'apps/desktop/src/shared/contracts.ts',
  'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/components/BrowserPane.tsx',
  'packages/core/src/browser-page-capability.ts', 'packages/core/src/agentmux-cli-help.ts',
  'apps/desktop/src/shared/browser-result-artifact.ts'])]
const original = new Map(await Promise.all(inputs.map(async file => [file, await fs.readFile(path.join(root, file))])))
const coreEntry = 'packages/core/dist/index.js'
const receipt = {
  passed: false, candidate: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceHashes: Object.fromEntries([...original].map(([file, bytes]) => [file, digest(bytes)])),
  coreRuntime: { entry: coreEntry, sha256: digest(await fs.readFile(path.join(root, coreEntry))) }, cases: []
}
await fs.mkdir(evidence, { recursive: true })
try {
  // Mutate an isolated production graph. Core is the verified, unmodified workspace dist;
  // the owning sources and shared worktree are never edited by this proof.
  for (const directory of ['apps/desktop/src/main', 'apps/desktop/src/shared']) {
    await fs.cp(path.join(root, directory), path.join(privateRoot, directory), { recursive: true })
  }
  await fs.mkdir(path.dirname(path.join(privateRoot, test)), { recursive: true })
  for (const file of [test, managerTest, workspaceTest, nativeTest,
    'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/components/BrowserPane.tsx']) {
    await fs.mkdir(path.dirname(path.join(privateRoot, file)), { recursive: true })
    await fs.writeFile(path.join(privateRoot, file), original.get(file))
  }
  await fs.symlink(path.join(root, 'node_modules'), path.join(privateRoot, 'node_modules'), 'dir')
  await fs.symlink(path.join(root, 'apps/desktop/node_modules'), path.join(privateRoot, 'apps/desktop/node_modules'), 'dir')
  await fs.writeFile(path.join(privateRoot, 'package.json'), '{"type":"module"}\n')
  const config = path.join(privateRoot, 'vitest.config.mjs')
  await fs.writeFile(config, `export default { define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, test: { include: ${JSON.stringify([test, managerTest, workspaceTest, nativeTest])} } }\n`)
  const run = async (name, onlyTest = test) => {
    const args = [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', onlyTest, '--root', privateRoot, '--config', config, '--maxWorkers=1']
    if (onlyTest === managerTest) args.push('-t', 'durable result via the actual Manager')
    const result = spawnSync(process.execPath, args, { cwd: privateRoot, encoding: 'utf8', timeout: 60_000 })
    const log = `${result.stdout ?? ''}${result.stderr ?? ''}`
    await fs.writeFile(path.join(evidence, `${name}.log`), log)
    return { exit: result.status, log, error: result.error?.message }
  }
  const baseline = await run('baseline-green')
  assert.equal(baseline.exit, 0, baseline.log)
  for (const oracle of [managerTest, workspaceTest, nativeTest]) {
    const baseline = await run(`baseline-${path.basename(oracle)}-green`, oracle)
    assert.equal(baseline.exit, 0, baseline.log)
  }
  for (const [name, file, before, after, onlyTest] of cases) {
    const source = original.get(file).toString('utf8')
    assert.equal(source.split(before).length - 1, 1, `Mutation anchor is not unique: ${name}`)
    await fs.writeFile(path.join(privateRoot, file), source.replace(before, after))
    try {
      const red = await run(name, onlyTest)
      assert.notEqual(red.exit, 0, `Mutation survived: ${name}`)
      assert.match(red.log, /AssertionError/, `Mutation failed before behavioral assertions: ${name}`)
      receipt.cases.push({ name, file, redExit: red.exit, log: `${name}.log` })
    } finally { await fs.writeFile(path.join(privateRoot, file), original.get(file)) }
  }
  const restored = await run('restored-green')
  assert.equal(restored.exit, 0, restored.log)
  receipt.restoredGreen = { exit: restored.exit, log: 'restored-green.log' }
  receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
finally {
  receipt.ownSourceUnchanged = Object.fromEntries(await Promise.all(inputs.map(async file => [file, digest(await fs.readFile(path.join(root, file))) === receipt.sourceHashes[file]])))
  await fs.writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  await fs.rm(privateRoot, { recursive: true, force: true })
}
assert.equal(receipt.passed, true, receipt.failure?.message)
assert.equal(Object.values(receipt.ownSourceUnchanged).every(Boolean), true, 'Owning sources changed during isolated proof; inspect receipt before closing the task')
console.log(JSON.stringify({ passed: true, mutants: receipt.cases.length, sourceUnchanged: true, evidence }))
