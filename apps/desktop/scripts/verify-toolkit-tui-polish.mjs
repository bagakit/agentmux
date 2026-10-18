import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import { readToolkitNativeProof } from './fixtures/toolkit-tui/verify-capture.mjs'

const root = resolve(import.meta.dirname, '../../..'), mode = process.argv[2]
assert.ok(['--editor', '--popover', '--integration'].includes(mode), 'Choose a TUI polish verification boundary')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const evidenceRoot = resolve(root, '.local/toolkit-tui-polish')
const read = async file => JSON.parse(await readFile(resolve(root, file), 'utf8'))
async function current(inputs) {
  assert.ok(inputs && Object.keys(inputs).length > 0, 'Nonempty source bindings required')
  for (const [file, digest] of Object.entries(inputs)) assert.equal(hash(await readFile(resolve(root, file))),
    typeof digest === 'string' ? digest : digest.sha256, 'Proof source changed: ' + file)
}
// Generate popover proof with --popover --run, editor proof with verify-toolkit-tui-editor.mjs.
// Task gates consume these exact source-bound results without another Native build.
async function run(args, env = {}) {
  let log = ''
  const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', bytes => { log += bytes }); child.stderr.on('data', bytes => { log += bytes })
  const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('close', accept) })
  return { code, log }
}
async function consumers(boundary) {
  const receipt = await read(`.local/toolkit-tui-polish/${boundary}/receipt.json`)
  assert.equal(receipt.status, 'passed'); await current(receipt.inputs)
  assert.equal(receipt.results.length, 5, 'One baseline and four targeted mutants required')
  assert.deepEqual(receipt.results.map(result => result.name).sort(), (boundary === 'editor'
    ? ['baseline', 'icon-edit', 'icon-label', 'display-presence', 'variable-colors']
    : ['baseline', 'wrong-anchor', 'wrong-direction', 'leak-gesture', 'hide-unknown']).sort())
  for (const result of receipt.results) {
    assert.ok(result.passed + result.failed > 0, 'Nonempty consumers required')
    if (result.mutation) assert.ok(result.failed > 0, 'Every mutant must fail a consumer assertion')
    else assert.ok(result.passed > 0 && result.failed === 0, 'Baseline must pass')
  }
  if (boundary === 'editor') {
    assert.equal(receipt.native.length, 2, 'Native baseline and language mutation required')
    for (const item of receipt.native) {
      const bytes = await readFile(resolve(root, item.path, 'receipt.json')), native = JSON.parse(bytes)
      assert.equal(hash(bytes), item.sha256); assert.equal(native.passed, true); await current(native.inputs)
      assert.deepEqual(native.remaining, []); assert.equal(native.privateRootRemoved, true)
      if (native.mutation) {
        assert.equal(native.native.failure.name, 'AssertionError')
        assert.ok(native.loaded.some(source => source.sourceSHA256 !== source.loadedSHA256))
      } else { assert.equal(native.native.passed, true); assert.ok(native.native.samples.length > 0) }
    }
  }
  process.stdout.write(boundary + ': existing consumer evidence verified against current source\n')
}
if (mode === '--editor') {
  await consumers('editor')
} else if (mode === '--popover' && !process.argv.includes('--run')) {
  await consumers('popover')
} else if (mode === '--popover') {
  const evidence = resolve(evidenceRoot, 'popover')
  await mkdir(evidence, { recursive: true })
  const sources = ['apps/desktop/scripts/verify-toolkit-tui-polish.mjs',
    'apps/desktop/scripts/fixtures/toolkit-tui/verify-capture.mjs',
    'apps/desktop/src/renderer/src/components/performance/PerformancePopover.tsx',
    'apps/desktop/src/renderer/src/components/performance/ToolkitPopoverResizeHandle.tsx',
    'apps/desktop/src/renderer/src/components/toolkit/TuiToolkitResult.tsx',
    'apps/desktop/src/renderer/src/components/toolkit/UserToolkitResult.tsx',
    'apps/desktop/src/renderer/src/styles/toolkit-tui.css',
    'apps/desktop/test/toolkit-tui-popover.test.tsx', 'apps/desktop/test/toolkit-tui-popover.config.mts',
    'apps/desktop/test/toolkit-tui-ui.test.tsx', 'apps/desktop/test/toolkit-tui-ui.config.mts',
    'apps/desktop/scripts/fixtures/settings-overview/vitest.config.mts',
    'apps/desktop/test/helpers/composer-dom-fixture.tsx',
    'apps/desktop/src/renderer/src/components/toolkit/use-toolkit-script-observation.ts']
  const inputs = Object.fromEntries(await Promise.all(sources.map(async file => [file, hash(await readFile(resolve(root, file)))])))
  const results = []
  for (const mutation of [null, 'wrong-anchor', 'wrong-direction', 'leak-gesture', 'hide-unknown']) {
    const name = mutation ?? 'baseline', output = resolve(evidence, name + '.json'), loaded = resolve(evidence, name + '.jsonl')
    await writeFile(loaded, '')
    const { code, log } = await run([resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config',
      'apps/desktop/test/toolkit-tui-popover.config.mts', '--reporter=json', '--outputFile=' + output],
    { AGENTMUX_TUI_POPOVER_MUTATION: mutation ?? '', AGENTMUX_TUI_POPOVER_RECEIPT: loaded })
    await writeFile(resolve(evidence, name + '.log'), log)
    const result = JSON.parse(await readFile(output, 'utf8'))
    assert.ok(result.numTotalTests > 0 && result.testResults.length > 0, 'Nonempty product consumers required')
    const consumed = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    assert.ok(consumed.length > 0, 'Production modules must actually load')
    if (mutation) {
      assert.notEqual(code, 0, name + ': mutant survived')
      assert.ok(result.testResults.flatMap(file => file.assertionResults ?? []).some(test => test.status === 'failed' &&
        test.failureMessages.some(message => /AssertionError|expected/iu.test(message))), name + ': consumer assertion must kill the mutant')
      assert.ok(consumed.some(item => item.mutation === mutation && item.sourceSHA256 !== item.loadedSHA256), 'Changed production source must load')
    } else { assert.equal(code, 0, 'Popover baseline failed'); assert.equal(result.success, true) }
    results.push({ name, mutation, passed: result.numPassedTests, failed: result.numFailedTests, result: relative(root, output) })
    process.stdout.write(name + ': ' + (mutation ? 'mutant killed' : 'passed') + '\n')
  }
  await current(inputs)
  await writeFile(resolve(evidence, 'receipt.json'), JSON.stringify({ status: 'passed', inputs, results }, null, 2) + '\n')
} else {
  // Native interaction and independent image review are performed once before this cheap receipt gate.
  for (const boundary of ['editor', 'popover']) await consumers(boundary)
  const review = JSON.parse(await readFile(resolve(evidenceRoot, 'visual-review.json'), 'utf8'))
  assert.equal(review.status, 'approved'); assert.ok(review.reviewer && review.images.length >= 4)
  await current(review.sourceHashes)
  for (const image of review.images) assert.equal(hash(await readFile(resolve(root, image.path))), image.sha256, 'Reviewed image changed')
  const { native, raw, directory: nativeDirectory } = await readToolkitNativeProof(root)
  const proof = raw.polish
  assert.equal(proof.completed, true); assert.equal(proof.hoverFocusRetained, true)
  assert.deepEqual(proof.persisted, proof.saved)
  for (const field of ['icon', 'script', 'mode', 'enabled', 'statusBar', 'workspacePath'])
    assert.deepEqual(proof.inspected.definition[field], proof.saved[field], 'Public Toolkit readback: ' + field)
  assert.ok(proof.cli.length > 0 && proof.cli.every(item => item.code === 0))
  assert.deepEqual(proof.final.admission.run, proof.original.admission.run)
  assert.equal(proof.reopen.sameRun, true); assert.equal(proof.reopen.historyRetained, true); assert.equal(proof.reopen.inputAfterReopen, true)
  for (const name of ['hover', 'pointer-enlarge', 'pointer-viewport-edge', 'pointer-shrink-from-edge', 'keyboard-shrink', 'narrow'])
    assert.ok(proof.geometry.some(item => item.name === name), 'Native geometry consumer missing: ' + name)
  assert.ok(native.frames.length >= 6, 'Final full-App frames required')
  for (const frame of native.frames) assert.equal(hash(await readFile(resolve(nativeDirectory, frame.file))), frame.sha256)
  const cleanup = JSON.parse(await readFile(resolve(evidenceRoot, 'cleanup.json'), 'utf8'))
  assert.equal(cleanup.passed, true); assert.deepEqual(cleanup.remainingProcesses, [])
  await writeFile(resolve(evidenceRoot, 'integration.json'), JSON.stringify({ status: 'passed',
    editor: 'editor/receipt.json', popover: 'popover/receipt.json', native: 'native-final/receipt.json',
    visualReview: 'visual-review.json', cleanup: 'cleanup.json' }, null, 2) + '\n')
  process.stdout.write('TUI polish integration evidence: passed\n')
}
