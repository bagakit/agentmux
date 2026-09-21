import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '../../..')
const evidence = path.resolve(process.argv[2] ?? path.join(root, '.tmp/browser-task-glue-mutations'))
const isolated = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'amux-task-glue-')))
const manager = 'apps/desktop/src/main/browser-view-manager.ts'
const pane = 'apps/desktop/src/renderer/src/components/BrowserPane.tsx'
const managerTest = 'apps/desktop/test/browser-run-script-wiring.test.ts'
const paneTest = 'apps/desktop/test/browser-demonstration-wiring.test.tsx'
const trustTest = 'apps/desktop/test/ipc-sender-trust.test.ts'
const selection = 'apps/desktop/src/main/browser-selection-script.ts'
const selectionTest = 'apps/desktop/test/browser-selection-script.test.ts'
const assets = 'apps/desktop/src/main/browser-task-assets.ts'
const assetsTest = 'apps/desktop/test/browser-task-assets.test.tsx'
const cases = [
  ['live-cursor-listener-disconnected', manager, 'if (!this.entries.has(browserId)) return', 'if (true) return', managerTest],
  ['task-snapshot-projection-disconnected', manager, '...(entry.taskAssets ? { taskAssets: entry.taskAssets } : {}),', '...{},', managerTest],
  ['checkpoint-does-not-yield-control', manager, "private yieldControl(id: string): void {\n    const entry = this.require(id)\n    entry.humanControl = true", "private yieldControl(id: string): void {\n    const entry = this.require(id)\n    entry.humanControl = false", managerTest],
  ['stop-loses-real-operation-association', manager, 'execution.operationId = operation.id', 'execution.operationId = undefined', managerTest],
  ['preparation-stop-intent-lost', manager, 'execution.stopRequested = true', 'execution.stopRequested = false', managerTest],
  ['preparation-stop-not-handed-to-operation', manager, 'if (execution.stopRequested) void this.stopOperationById(operation.id)', 'void operation.id', managerTest],
  ['late-operation-rebounds-to-running', manager, "if (!stopRequested) {\n      operation.phase = 'running'", "if (true) {\n      operation.phase = 'running'", managerTest],
  ['actual-cursor-not-bound-before-publication', manager, 'onRunPrepared: runId => { execution.runId = runId }', 'onRunPrepared: runId => { void runId }', managerTest],
  ['history-stop-cancels-fresh-execution', manager, 'execution?.entry === entry && execution.runId === runId', 'execution?.entry === entry', managerTest],
  ['write-ahead-revives-stopped-cursor', assets, "if (run!.status === 'stopped') return false", 'if (false) return false', assetsTest],
  ['call-proceeds-after-stop', assets, "if (!started || (run as BrowserTaskAssetRun).status === 'stopped') break", 'void started', assetsTest],
  ['checkpoint-advances-stopped-cursor', assets, "if (run!.status === 'stopped') return\n", 'if (false) return\n', assetsTest],
  ['unknown-call-overwrites-stopped-cursor', assets, "if (run!.status !== 'stopped') {", 'if (true) {', assetsTest],
  ['foreign-browser-can-edit-asset', manager, 'if (!asset || asset.browserId !== id)', 'if (!asset)', managerTest],
  ['task-parameter-privacy-disconnected', manager, 'const privateTaskParameters = Boolean(asset.versions.find(version => version.version === input.version)?.parameters.length)', 'const privateTaskParameters = false', managerTest],
  ['task-raw-error-stack-persisted', manager, "privateTaskParameters && 'message' in failureOutcome", "false && 'message' in failureOutcome", managerTest],
  ['private-page-evidence-persisted', manager, "content.kind === 'page' && privateTaskParameters", "content.kind === 'page' && false", managerTest],
  ['private-ref-ledger-persisted', manager, 'if (privateTaskParameters) return', 'if (false) return', managerTest],
  ['selection-target-not-inspected', manager, 'if (inspectTarget) await inspectTarget(operation)', 'void inspectTarget', managerTest],
  ['synthetic-task-actions-accepted', pane, "async function taskAction(event: MouseEvent<HTMLButtonElement>, action: () => Promise<unknown>): Promise<void> {\n    if (event.nativeEvent.isTrusted !== true) return", "async function taskAction(event: MouseEvent<HTMLButtonElement>, action: () => Promise<unknown>): Promise<void> {\n    if (false) return", paneTest],
  ['renderer-task-asset-disconnected', pane, 'asset={taskAsset}', 'asset={null}', paneTest],
  ['untrusted-ipc-can-run-task', 'apps/desktop/src/main/ipc.ts', "    requireTrustedSender('browser:runTaskAsset', event)", '    void event', trustTest],
  ['selection-does-not-retain-actual-node', selection, 'if (retainTarget) state.selectedTarget = selected', 'if (false) state.selectedTarget = selected', selectionTest],
  ['selection-revision-proof-removed', selection, 'state?.revision === ${revision} && state.selectedTarget instanceof Element', 'state.selectedTarget instanceof Element', selectionTest],
  ['selection-retained-node-not-released', selection, 'state.selectedTarget = null; if (settled)', 'if (settled)', selectionTest]
]
const tests = [managerTest, paneTest, trustTest, selectionTest, assetsTest]
const inputs = [...new Set([manager, pane, selection, selectionTest, ...cases.map(([, file]) => file), ...tests,
  'apps/desktop/src/main/browser-demonstration-capture.ts', 'apps/desktop/src/main/browser-demonstration-recorder.ts',
  'apps/desktop/src/shared/browser-demonstration.ts', 'apps/desktop/src/shared/contracts.ts', 'apps/desktop/src/preload/index.ts'])]
const original = new Map(await Promise.all(inputs.map(async file => [file, await fs.readFile(path.join(root, file))])))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const receipt = { passed: false, candidate: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceHashes: Object.fromEntries([...original].map(([file, bytes]) => [file, hash(bytes)])), cases: [] }
await fs.mkdir(evidence, { recursive: true })
try {
  for (const directory of ['apps/desktop/src/main', 'apps/desktop/src/shared', 'apps/desktop/src/renderer/src', 'apps/desktop/src/preload']) {
    await fs.cp(path.join(root, directory), path.join(isolated, directory), { recursive: true })
  }
  await fs.symlink(path.join(root, 'apps/desktop/resources'), path.join(isolated, 'apps/desktop/resources'), 'dir')
  await fs.mkdir(path.join(isolated, 'apps/desktop/test'), { recursive: true })
  for (const file of tests) await fs.writeFile(path.join(isolated, file), original.get(file))
  await fs.symlink(path.join(root, 'node_modules'), path.join(isolated, 'node_modules'), 'dir')
  await fs.symlink(path.join(root, 'apps/desktop/node_modules'), path.join(isolated, 'apps/desktop/node_modules'), 'dir')
  await fs.writeFile(path.join(isolated, 'package.json'), '{"type":"module"}\n')
  const config = path.join(isolated, 'vitest.config.mjs')
  await fs.writeFile(config, `export default { esbuild: { jsx: 'automatic' }, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, server: { fs: { allow: ${JSON.stringify([isolated, path.join(root, 'packages/core/bin')])} } }, test: { include: ${JSON.stringify(tests)} } }\n`)
  const run = async (name, test) => {
    const args = [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', test, '--root', isolated, '--config', config, '--maxWorkers=1']
    if (test === managerTest) args.push('-t', 'versioned task assets via')
    const result = spawnSync(process.execPath, args, { cwd: isolated, encoding: 'utf8', timeout: 60_000 })
    const log = `${result.stdout ?? ''}${result.stderr ?? ''}`
    await fs.writeFile(path.join(evidence, `${name}.log`), log)
    return { exit: result.status, log }
  }
  for (const test of tests) assert.equal((await run(`baseline-${path.basename(test)}`, test)).exit, 0, `Baseline must pass: ${test}`)
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
  for (const test of tests) assert.equal((await run(`restored-${path.basename(test)}`, test)).exit, 0, `Restored source must pass: ${test}`)
  receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
finally {
  receipt.ownSourceUnchanged = Object.fromEntries(await Promise.all(inputs.map(async file => [file, hash(await fs.readFile(path.join(root, file))) === receipt.sourceHashes[file]])))
  await fs.writeFile(path.join(evidence, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
  await fs.rm(isolated, { recursive: true, force: true })
}
assert.equal(receipt.passed, true, receipt.failure?.message)
assert.equal(Object.values(receipt.ownSourceUnchanged).every(Boolean), true, 'Inspect concurrent edits before closing the task')
console.log(JSON.stringify({ passed: true, mutants: receipt.cases.length, evidence }))
