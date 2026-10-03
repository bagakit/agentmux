import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { verifyMotePersonaTask } from './verify-mote-persona-task.mjs'

const base = resolve(import.meta.dirname, '../../..'), args = process.argv.slice(2)
if (!args.length) {
  await verifyMotePersonaTask('cooperation')
} else {
  const inputs = {}
  for (let index = 0; index < args.length; index += 2) {
    assert.ok(['--capture', '--restart', '--review'].includes(args[index]), 'Use --capture, --restart and --review receipt paths')
    assert.ok(args[index + 1] && !args[index + 1].startsWith('--'), 'Each receipt flag needs its exact file')
    assert.ok(!inputs[args[index]], 'A receipt flag must be unique')
    inputs[args[index]] = resolve(base, args[index + 1])
  }
  assert.equal(Object.keys(inputs).length, 3, 'The complete Source, Renderer, original Save readback and independent review join is required')
  const directory = join(base, '.tmp/mote-behavior/acceptance-' + globalThis.crypto.randomUUID())
  await mkdir(directory, { recursive: true })
  const sha = bytes => createHash('sha256').update(bytes).digest('hex')
  const receipt = { passed: false, inputs: {}, source: {}, boundary: 'Consumes completed exact Source/mutation/caller, actual Renderer, original filesystem Save/restart and independent aesthetic review receipts. It never reruns captures or process qualification and makes no user App, Native, package or install claim.' }
  try {
    const last = JSON.parse(await readFile(join(base, '.tmp/mote-companion-cooperation/last.json'), 'utf8'))
    const files = { source: last.receipt, capture: inputs['--capture'], restart: inputs['--restart'], review: inputs['--review'] }
    const artifacts = {}
    for (const [name, file] of Object.entries(files)) {
      const bytes = await readFile(file); artifacts[name] = JSON.parse(bytes)
      receipt.inputs[name] = { path: relative(base, file), sha256: sha(bytes) }
    }
    const { source, capture, restart, review } = artifacts
    assert.equal(source.passed, true); assert.equal(source.task, 'cooperation')
    assert.ok(source.callers.length >= 7 && source.callers.every(caller => caller.definition !== caller.caller && !caller.caller.includes('/test/')))
    assert.ok(source.runs.length >= 35 && source.runs.every(run => run.collected && run.signal === null && (run.expected === 'GREEN' ? run.code === 0 : run.code !== 0 && run.assertion)))
    assert.equal(capture.passed, true); assert.equal(capture.captureSubset, 'behavior-only'); assert.equal(capture.renderer.passed, true)
    const frames = capture.renderer.operations
    for (const surface of ['profile', 'studio']) for (const width of ['wide', 'narrow']) {
      const dark = frames.find(frame => frame.name === surface + '-' + width + '-dark'), light = frames.find(frame => frame.name === surface + '-' + width + '-light')
      assert.ok(dark && light); assert.equal(dark.appearance, 'dark'); assert.equal(light.appearance, 'light'); assert.notEqual(dark.background, light.background)
    }
    assert.ok(Object.keys(capture.images).length >= 22)
    for (const [file, digest] of Object.entries(capture.images)) assert.equal(sha(await readFile(join(base, file))), digest)
    assert.equal(restart.passed, true); assert.equal(restart.rendererCaptureSha, receipt.inputs.capture.sha256)
    assert.deepEqual(restart.cases.map(item => item.name).sort(), ['behavior-saved-reopened', 'cooperation-later-input-kept', 'cooperation-new-launcher-no-executor'])
    assert.equal(new Set(restart.cases.flatMap(item => item.pids)).size, 9)
    assert.equal(review.status, 'approved'); assert.equal(review.taskId, 'T-002')
    assert.equal(review.captureReceipt.sha256, receipt.inputs.capture.sha256); assert.equal(review.restartReceipt.sha256, receipt.inputs.restart.sha256)
    assert.ok(review.aestheticJudgment.status === 'approved' || review.aestheticJudgment.result?.startsWith('approved-for-T-002'))
    let currentSource = source.source
    if (review.sourceRebinding) {
      const binding = review.sourceRebinding
      assert.equal(binding.mode, 'unchanged-mutations-fresh-baseline')
      assert.equal(binding.mutationReceiptSha256, receipt.inputs.source.sha256)
      const file = resolve(base, binding.freshBaselineReceipt.path), bytes = await readFile(file)
      assert.equal(sha(bytes), binding.freshBaselineReceipt.sha256)
      const baseline = JSON.parse(bytes)
      assert.equal(baseline.passed, true); assert.equal(baseline.fromBase, binding.fromBase); assert.equal(baseline.toBase, binding.toBase)
      assert.deepEqual(Object.keys(baseline.source).sort(), Object.keys(source.source).sort())
      const reportBytes = await readFile(resolve(base, baseline.vitestReport.path))
      assert.equal(sha(reportBytes), baseline.vitestReport.sha256)
      const report = JSON.parse(reportBytes)
      assert.equal(report.success, true); assert.equal(report.numTotalTests, 19); assert.equal(report.numPassedTests, 19)
      assert.equal(report.numFailedTests, 0); assert.equal(report.numPendingTests, 0)
      // Reuse the actual old runs only for unchanged definitions, counterexamples and callers.
      // Each reviewed external dependency change still needs this new, exact baseline.
      const external = new Set([
        'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/lib/api.ts',
        'apps/desktop/src/renderer/src/lib/desktop-spatial-state.ts', 'apps/desktop/src/renderer/src/lib/launcher-state.ts',
        'apps/desktop/src/renderer/src/lib/workbench-persistence.ts', 'apps/desktop/src/shared/contracts.ts',
        'apps/desktop/src/shared/space-addresses.ts', 'packages/core/src/toolkit.ts', 'packages/core/src/control.ts',
        'packages/core/src/spatial-state.ts', 'packages/core/src/spatial-graph.ts'
      ])
      const wrapper = 'apps/desktop/scripts/verify-mote-cooperation.mjs'
      const changes = Object.entries(source.source).filter(([path, digest]) => baseline.source[path] !== digest)
        .map(([path, digest]) => ({ path, mutationSource: digest, current: baseline.source[path] }))
      const dependencyChanges = changes.filter(change => change.path !== wrapper)
      assert.deepEqual(dependencyChanges, binding.changedInputs)
      assert.ok(dependencyChanges.every(change => external.has(change.path)), 'A changed T2 definition, counterexample or caller cannot reuse its old mutant proof')
      const verificationDelta = changes.find(change => change.path === wrapper)
      assert.deepEqual(verificationDelta ?? null, binding.verificationDelta ?? null)
      if (verificationDelta) assert.equal(review.source[wrapper], verificationDelta.current, 'The join-only verification delta needs its own exact independent review')
      currentSource = baseline.source
      receipt.sourceRebinding = { fromBase: binding.fromBase, toBase: binding.toBase,
        rawMutationReceipt: receipt.inputs.source, freshBaselineReceipt: { path: relative(base, file), sha256: sha(bytes) },
        changedInputs: dependencyChanges, verificationDelta: verificationDelta ?? null,
        boundary: 'The 35 recorded runs remain observations of the original mutation Source. Only the unchanged definitions, counterexamples and callers are reused; the 19-test baseline and captured Save/restart owners are observations of the new dependency Source.' }
    }
    for (const file of ['apps/desktop/src/renderer/src/components/MoteDetailsPanel.tsx', 'apps/desktop/src/renderer/src/components/MoteBehaviorDialog.tsx', 'apps/desktop/src/renderer/src/lib/mote-behavior.ts', 'apps/desktop/src/renderer/src/lib/mote-cooperation.ts', 'apps/desktop/src/renderer/src/lib/mote-materials-actions.ts', 'apps/desktop/src/renderer/src/styles/mote-workface.css']) {
      assert.ok(source.source[file] && capture.source[file] && review.source[file], 'Nonempty production Source inputs and review are required')
      assert.equal(source.source[file], capture.source[file]); assert.equal(source.source[file], review.source[file])
    }
    for (const [name, artifact] of Object.entries({ source: { source: currentSource }, capture, restart, review })) {
      assert.ok(Object.keys(artifact.source).length > 0, name + ' Source must be nonempty')
      for (const [file, digest] of Object.entries(artifact.source)) {
        if (name === 'capture' && !/^(apps\/desktop\/src|packages)\//.test(file)) continue
        assert.equal(sha(await readFile(join(base, file))), digest, name + ' must match the exact current candidate: ' + file)
        receipt.source[file] = digest
      }
    }
    receipt.passed = true
  } catch (error) { receipt.error = { message: error.message, stack: error.stack }; process.exitCode = 1 }
  await writeFile(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: receipt.passed, receipt: relative(base, join(directory, 'receipt.json')) }))
  if (!receipt.passed) console.error(receipt.error)
}
