import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const output = resolve(root, process.env.AGENTMUX_FOCUS_NAME_WIDTH_OUTPUT ?? `.tmp/focus-timeline-name-width-qualification-${Date.now()}`)
mkdirSync(output, { recursive: true })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const productPaths = ['apps/desktop/src/renderer/src/components/RecentFocusTimeline.tsx', 'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/styles/focus.css', 'apps/desktop/src/renderer/src/lib/focus-timeline-name-width.ts', 'apps/desktop/src/renderer/src/hooks/useSidebarResize.ts', 'apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx']
const config = 'apps/desktop/scripts/fixtures/focus-timeline-name-width/vitest.owning.config.mts'
const sourcePaths = [...productPaths, 'apps/desktop/test/focus-timeline-name-width.test.tsx', config, 'apps/desktop/scripts/fixtures/focus-timeline-name-width/tsconfig.owning.json', 'apps/desktop/scripts/verify-focus-timeline-name-width.mjs']
const binding = () => Object.fromEntries(sourcePaths.map(file => [file, hash(readFileSync(resolve(root, file)))]))
const receipt = { schema: 'agentmux.focus-timeline-name-width-qualification.v1', sourcePass: false, passed: false, taskDone: false, before: binding(), stages: [], output: relative(root, output), boundary: 'Source qualification is distinct from normal Desktop build, actual compiled geometry and two ordinary private GUI processes with real Run/PID/ACK. No user App, shared Runtime, installation or lifecycle control.' }
function run(label, command, mutation) {
  const report = resolve(output, `${label}.json`), loaded = resolve(output, `${label}.loaded.jsonl`)
  const env = { ...process.env, AGENTMUX_FOCUS_NAME_WIDTH_LOADED_SOURCE: loaded }
  delete env.AGENTMUX_FOCUS_NAME_WIDTH_MUTATION
  if (mutation) env.AGENTMUX_FOCUS_NAME_WIDTH_MUTATION = mutation
  const args = command ?? [process.execPath, 'node_modules/vitest/vitest.mjs', 'run', '--config', config, '--maxWorkers=1', '--reporter=json', `--outputFile=${report}`]
  const result = spawnSync(args[0], args.slice(1), { cwd: root, env, encoding: 'utf8', timeout: 180_000, maxBuffer: 4 * 1024 * 1024 })
  writeFileSync(resolve(output, `${label}.log`), (result.stdout ?? '') + (result.stderr ?? ''))
  const stage = { label, command: args, exitCode: result.status, error: result.error?.message, mutation: mutation ?? null }; receipt.stages.push(stage)
  if (!command) {
    assert.ok(existsSync(report) && existsSync(loaded), `${label}: Source collection did not complete; inspect the retained stage log (freshness/setup is not semantic RED)` )
    const tests = JSON.parse(readFileSync(report)), modules = readFileSync(loaded, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    const assertions = tests.testResults.flatMap(file => file.assertionResults), failed = assertions.filter(item => item.status === 'failed')
    assert.ok(assertions.length > 0); assert.ok(modules.length > 0)
    const ownerPath = mutation === 'persistence-disconnected' ? productPaths[1] : productPaths[0]
    const owner = modules.find(item => item.path === ownerPath); assert.ok(owner); assert.equal(owner.originalSHA256, receipt.before[ownerPath])
    Object.assign(stage, { tests: tests.numTotalTests, passed: tests.numPassedTests, failed: tests.numFailedTests, reportSHA256: hash(readFileSync(report)), loadedSHA256: hash(readFileSync(loaded)), loadedOwner: owner })
    if (mutation) {
      assert.notEqual(result.status, 0); assert.ok(failed.length > 0)
      assert.ok(failed.every(item => item.failureMessages.some(message => message.includes('AssertionError'))), 'Loaded semantic assertions must fail, rather than setup or timeout')
      assert.equal(owner.mutation, mutation); assert.notEqual(owner.sha256, owner.originalSHA256)
    } else { assert.equal(result.status, 0); assert.equal(tests.success, true); assert.equal(owner.sha256, owner.originalSHA256) }
  } else assert.equal(result.status, 0, `${label} failed; original output retained`)
  writeFileSync(resolve(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(`${label}: actual exit ${result.status}`)
  return stage
}
function input(file) { const absolute = resolve(root, file), bytes = readFileSync(absolute); return { file, sha256: hash(bytes), value: JSON.parse(bytes), absolute } }
try {
  const baseline = run('baseline')
  for (const mutation of ['resize-disconnected', 'persistence-disconnected', 'geometry-saves-preference', 'draft-rereads']) {
    assert.equal(run(mutation, undefined, mutation).tests, baseline.tests)
    assert.equal(run(`${mutation}-exact-restore`).tests, baseline.tests)
  }
  run('adjacent-resize-and-reading', [process.execPath, 'node_modules/vitest/vitest.mjs', 'run', 'apps/desktop/test/project-rail-resize.test.tsx', 'apps/desktop/test/focus-timeline-navigation.test.tsx', 'apps/desktop/test/recent-focus-timeline.test.tsx', '--maxWorkers=1'])
  run('production-types', [process.execPath, 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'apps/desktop/tsconfig.json'])
  run('owning-types', [process.execPath, 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'apps/desktop/scripts/fixtures/focus-timeline-name-width/tsconfig.owning.json'])
  const callers = { RecentFocusTimeline: [productPaths[5], '<RecentFocusTimeline '], useSidebarResize: [productPaths[0], 'useSidebarResize<HTMLDivElement>({'], setFocusTimelineNameWidth: [productPaths[0], 'state.setFocusTimelineNameWidth'], clampFocusTimelineNameWidth: [productPaths[1], 'clampFocusTimelineNameWidth(persisted.focusTimelineNameWidth)'] }
  receipt.callers = Object.fromEntries(Object.entries(callers).map(([symbol, [file, needle]]) => { const source = readFileSync(resolve(root, file), 'utf8'), index = source.indexOf(needle); assert.ok(index >= 0, `${symbol}: non-definition product caller`); return [symbol, { file, line: source.slice(0, index).split('\n').length, needle }] }))
  receipt.after = binding(); assert.deepEqual(receipt.after, receipt.before); receipt.sourcePass = true
  if (!process.argv.includes('--source-only')) {
    const delivered = input(process.env.AGENTMUX_FOCUS_NAME_WIDTH_DELIVERY_RECEIPT ?? 'docs/reviews/evidence/focus-timeline-name-width-2026-10-04/qualification/receipt.json')
    const proof = delivered.value
    assert.equal(proof.schema, 'agentmux.focus-timeline-name-width-delivery.v1'); assert.equal(proof.passed, true)
    for (const file of productPaths) assert.equal(proof.inputs[file], receipt.before[file])
    assert.ok(proof.candidate?.length === 40); assert.equal(proof.productionBuild.exitCode, 0)
    assert.ok(Object.keys(proof.productionBuild.compiled).length > 0); assert.ok(proof.productionBuild.command?.length > 0)
    assert.equal(proof.compiledGeometry.passed, true); assert.ok(proof.compiledGeometry.frames.length >= 2)
    for (const variant of ['shared-column-removed', 'collapsed-left-fixed']) {
      const red = proof.compiledGeometry.mutations.find(item => item.mutation === variant)
      assert.ok(red); assert.equal(red.failureName, 'AssertionError'); assert.ok(red.failedAssertions > 0); assert.equal(red.exactRestored, true)
    }
    const restart = proof.ordinaryRestart
    assert.equal(restart.passed, true); assert.equal(restart.processes.length, 2); assert.notEqual(restart.processes[0].pid, restart.processes[1].pid)
    assert.equal(restart.processes[1].seedWrites, 0); assert.ok(restart.runs.length > 0)
    for (const run of restart.runs) { assert.equal(run.before.runId, run.after.runId); assert.equal(run.before.pid, run.after.pid); assert.ok(run.before.pid > 0); assert.equal(run.ack.passed, true) }
    assert.deepEqual(restart.controls, []); assert.equal(restart.widthRestored, true); assert.equal(restart.workbenchPreserved, true); assert.equal(restart.sameProcessXtermPreserved, true)
    const visual = input(proof.visualReview.file)
    assert.equal(visual.value.verdict, 'pass'); assert.ok(visual.value.reviewerAgentId?.length > 0); assert.equal(visual.value.sceneReceiptSHA256, proof.compiledGeometry.receiptSHA256)
    assert.ok(proof.images.length >= 2)
    for (const image of proof.images) { assert.equal(hash(readFileSync(resolve(dirname(delivered.absolute), image.path))), image.sha256); assert.ok(visual.value.viewedImages.some(viewed => viewed.path === image.path && viewed.sha256 === image.sha256 && viewed.observation?.trim().length > 0)) }
    assert.equal(proof.cleanup.ownedPrivateRootsRemoved, true); assert.deepEqual(proof.cleanup.remainingOwnedProcesses, [])
    receipt.delivery = { file: delivered.file, sha256: delivered.sha256, candidate: proof.candidate }; receipt.visualReview = { file: visual.file, sha256: visual.sha256 }; receipt.taskDone = true
  }
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1 }
finally { writeFileSync(resolve(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); console.log(JSON.stringify({ sourcePass: receipt.sourcePass, passed: receipt.passed, taskDone: receipt.taskDone, receipt: relative(root, resolve(output, 'receipt.json')) })) }
