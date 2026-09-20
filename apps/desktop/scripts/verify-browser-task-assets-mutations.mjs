import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const root = path.resolve(import.meta.dirname, '../../..')
const require = createRequire(path.join(root, 'package.json'))
const main = 'apps/desktop/src/main/browser-task-assets.ts'
const compiler = 'apps/desktop/src/main/browser-replay-compiler.ts'
const editor = 'apps/desktop/src/renderer/src/components/BrowserTaskAssetEditor.tsx'
const test = 'apps/desktop/test/browser-task-assets.test.tsx'
const files = [main, compiler, editor, test, 'apps/desktop/src/shared/browser-task-assets.ts',
  'apps/desktop/src/shared/browser-demonstration.ts', 'apps/desktop/src/shared/browser-operation.ts',
  'apps/desktop/src/shared/browser-step-evidence.ts', 'packages/core/src/durable-write.ts', 'packages/core/src/browser-page-capability.ts']
const originals = new Map(await Promise.all(files.map(async file => [file, await fs.readFile(path.join(root, file), 'utf8')])))
const digest = value => createHash('sha256').update(value).digest('hex')
const isolated = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentmux-task-assets-mutations-')))
const evidence = path.join(root, 'docs/reviews/evidence/browser-task-capabilities-2026-10-03/t011-source')
const cases = [
  [main, 'deleted-steps-resurrected', 'asset.draft = content(replacement)', 'asset.draft = content({ ...replacement, steps: replacement.steps.length ? replacement.steps : asset.draft.steps })'],
  [main, 'version-ignores-selection', 'asset.versions.find(item => item.version === input.version)', 'asset.versions.at(-1)'],
  [main, 'edit-overwrites-immutable-version', 'asset.draft = content(replacement)', 'asset.draft = content(replacement); asset.versions.forEach(version => Object.assign(version, content(replacement)))'],
  [main, 'continuation-restarts-first-step', "next.status = 'ready'", "next.status = 'ready'; next.nextStep = 0"],
  [main, 'checkpoint-does-not-yield-control', 'host.yieldControl(browserId)', 'void 0'],
  [main, 'human-control-guard-removed', "host.control(browserId) !== 'agent'", 'false'],
  [main, 'continuation-version-binding-removed', 'existing.version !== version.version', 'false'],
  [main, 'parameter-value-retained', 'delete next.pendingCheckpointId; delete next.warning', 'delete next.pendingCheckpointId; delete next.warning; next.parameters = parameters'],
  [main, 'parameter-values-drift-mid-run', 'const parameters = { ...input.parameters }', 'const parameters = input.parameters'],
  [main, 'unreviewed-step-runs', '!step.reviewed', 'false'],
  [main, 'unknown-target-runs', "step.kind !== 'navigate' && (!step.target || step.target.count !== 1 || step.target.ordinal !== 1)", 'false'],
  [main, 'restart-cursor-resumes', "run.status = 'interrupted'; run.warning = 'Restart", "run.status = 'ready'; run.warning = 'Restart"],
  [main, 'completed-action-cursor-does-not-advance', "if (report.outcome.kind === 'completed') run!.nextStep += 1", "if (report.outcome.kind === 'completed') run!.nextStep = version.steps.length"],
  [main, 'stop-progress-ignored', "run.status = 'stopped'; run.warning = 'Task stopped", "run.status = 'ready'; run.warning = 'Task stopped"],
  [main, 'wrong-operation-identity-accepted', "!report.runOperation.id || report.runOperation.browserId !== browserId", 'false'],
  [main, 'storage-failure-silent', 'throw new Error(this.warning)', 'return'],
  [main, 'cursor-projection-not-notified', 'if (browserId) for (const listener of [...this.listeners])', 'if (false) for (const listener of [...this.listeners])'],
  [main, 'unrelated-browser-projection-updated', 'listener(browserId)', "listener('browser-other')"],
  [main, 'async-projection-rejection-unhandled', 'Promise.resolve(listener(browserId)).catch(() => {})', 'Promise.resolve(listener(browserId))'],
  [compiler, 'partial-observation-claimed-complete', "if (!observed || observed.scope.kind !== 'page' || observed.scope.document !== null ||\n            observed.truncated || observed.omittedFrames.length || (page.missingFrames && page.missingFrames.length))", 'if (false)'],
  [editor, 'editor-delete-does-nothing', 'draft.steps.filter(item => item.id !== step.id)', 'draft.steps'],
  [editor, 'unresolved-review-enabled', "step.kind !== 'navigate' && (!step.target || step.target.count !== 1)", 'false'],
  [editor, 'checkpoint-appended-after-all-actions', '...draft.steps.slice(0, index + 1), { id: crypto.randomUUID(), kind: \'checkpoint\', url: step.url, label: \'Human checkpoint\', reviewed: true }, ...draft.steps.slice(index + 1)', "...draft.steps, { id: crypto.randomUUID(), kind: 'checkpoint', url: step.url, label: 'Human checkpoint', reviewed: true }"],
  [editor, 'waiting-state-hidden', "{continuing ? 'Return control and continue' : 'Run version'}", "{'Run version'}"]
]
const receipt = { passed: false, boundary: 'Actual asset store, shared replay compiler, Editor and behavioral regressions in a private source copy. Product Main/IPC/BrowserPane callers, native input, ordinary workbench restart and independent visual review are separate acceptance gates.', inputs: Object.fromEntries([...originals].map(([file, source]) => [file, digest(source)])), cases: [] }
async function run(name) {
  const result = spawnSync(process.execPath, [require.resolve('vitest/vitest.mjs'), 'run', test, '--root', isolated, '--maxWorkers=1'], { cwd: isolated, encoding: 'utf8', timeout: 30_000 })
  const log = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const file = path.join(evidence, `${name}.log`)
  await fs.writeFile(file, log)
  return { result, log, file: path.relative(root, file), sha256: digest(log) }
}
try {
  await fs.mkdir(evidence, { recursive: true })
  await fs.writeFile(path.join(isolated, 'package.json'), '{"type":"module"}\n')
  // Import the actual two Core implementations used by this slice. Avoid unrelated barrel ?url
  // assets crossing Vite's private root; this adapter contains exports only, no substitute logic.
  await fs.writeFile(path.join(isolated, 'core-proof.ts'), "export { durableWriteFile } from './packages/core/src/durable-write.ts'; export { BROWSER_PAGE_CAPABILITY_NAMES } from './packages/core/src/browser-page-capability.ts'\n")
  await fs.writeFile(path.join(isolated, 'vitest.config.mjs'), `export default { esbuild: { jsx: 'automatic' }, resolve: { alias: { '@agentmux/core': ${JSON.stringify(path.join(isolated, 'core-proof.ts'))} } } }\n`)
  await fs.symlink(path.join(root, 'node_modules'), path.join(isolated, 'node_modules'), 'dir')
  await fs.mkdir(path.join(isolated, 'apps/desktop'), { recursive: true })
  await fs.symlink(path.join(root, 'apps/desktop/node_modules'), path.join(isolated, 'apps/desktop/node_modules'), 'dir')
  for (const [file, source] of originals) {
    await fs.mkdir(path.dirname(path.join(isolated, file)), { recursive: true })
    await fs.writeFile(path.join(isolated, file), source)
  }
  const baseline = await run('baseline-green')
  assert.equal(baseline.result.status, 0, baseline.log)
  assert.match(baseline.log, /Tests\s+18 passed/, 'All real asset and Editor regression tests must run')
  for (const [file, name, before, after] of cases) {
    const source = originals.get(file), occurrences = source.split(before).length - 1
    assert.ok(occurrences > 0, `Mutation anchor missing: ${name}`)
    const mutated = source.replaceAll(before, after)
    await fs.writeFile(path.join(isolated, file), mutated)
    const red = await run(name)
    assert.ok(Number.isInteger(red.result.status) && red.result.status !== 0, `Mutation survived: ${name}`)
    assert.match(red.log, /AssertionError/, `Actual behavioral assertion must fail: ${name}`)
    assert.match(red.log, /Tests\s+[1-9]\d* failed/, `Failing tests must execute: ${name}`)
    receipt.cases.push({ file, name, occurrences, mutatedSha256: digest(mutated), redExit: red.result.status, log: red.file, sha256: red.sha256 })
    await fs.writeFile(path.join(isolated, file), source)
  }
  const green = await run('restored-green')
  assert.equal(green.result.status, 0, green.log)
  assert.match(green.log, /Tests\s+18 passed/)
  receipt.green = { exit: green.result.status, log: green.file, sha256: green.sha256 }
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message } }
finally {
  receipt.sourceAfter = Object.fromEntries(await Promise.all(files.map(async file => [file, digest(await fs.readFile(path.join(root, file), 'utf8'))])))
  await fs.rm(isolated, { recursive: true, force: true }); receipt.privateSourceRemoved = true
  await fs.mkdir(evidence, { recursive: true })
  await fs.writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
assert.deepEqual(receipt.sourceAfter, receipt.inputs, 'Source and test inputs changed during the proof; this receipt cannot sign the new candidate')
assert.equal(receipt.passed, true, receipt.failure?.message)
console.log(JSON.stringify({ passed: true, cases: receipt.cases.length, originalSourceUnchanged: true, receipt: path.relative(root, path.join(evidence, 'receipt.json')) }))
