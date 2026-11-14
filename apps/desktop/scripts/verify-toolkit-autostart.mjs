import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'

const root = resolve(import.meta.dirname, '../../..'), evidence = join(root, '.local/state/toolkit-autostart')
await mkdir(evidence, { recursive: true })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
// Tracker can consume an already accepted, unchanged proof after an unrelated workspace edit.
// Every loaded production source, test, command, image and review remains hash-bound.
try {
  const accepted = JSON.parse(await readFile(join(evidence, 'proof.json'), 'utf8'))
  if (accepted.passed && Object.keys(accepted.inputs).length > 16 &&
      (await Promise.all(Object.entries(accepted.inputs).map(async ([file, sha]) => hash(await readFile(resolve(root, file))) === sha))).every(Boolean)) {
    console.log('Accepted autostart proof is current; reusing its product, restart, mutation and visual evidence.')
    process.exit(0)
  }
} catch { /* Absent or changed evidence needs a new qualification. */ }
const sources = ['packages/core/src/toolkit.ts', 'apps/desktop/src/main/toolkit-config.ts', 'apps/desktop/src/main/toolkit-custom-owner.ts',
  'apps/desktop/src/main/toolkit-owner.ts', 'apps/desktop/src/main/toolkit-package.ts',
  'apps/desktop/src/renderer/src/components/settings/use-toolkit-drafts.ts',
  'apps/desktop/src/renderer/src/components/settings/ToolkitToolEditor.tsx', 'apps/desktop/src/renderer/src/components/settings/ToolkitPackageEditor.tsx',
  'apps/desktop/test/toolkit-autostart-main.test.ts', 'apps/desktop/test/helpers/toolkit-autostart-main-fixture.ts',
  'apps/desktop/test/toolkit-autostart.config.mts', 'apps/desktop/test/toolkit-tui-owner.test.ts',
  'apps/desktop/test/toolkit-custom-ui.test.tsx', 'apps/desktop/test/toolkit-custom-drafts.test.tsx',
  'apps/desktop/test/toolkit-tui-process.test.ts', 'apps/desktop/test/helpers/toolkit-tui-process.ts',
  'apps/desktop/scripts/verify-toolkit-autostart.mjs', 'apps/desktop/scripts/fixtures/toolkit-custom/vitest.config.mts',
  'vitest.setup.ts', 'packages/core/dist/toolkit.js', 'packages/core/dist/agentmux.js']
const inputs = Object.fromEntries(await Promise.all(sources.map(async file => [file, hash(await readFile(join(root, file)))])))
const results = []
await writeFile(join(evidence, 'loaded-source.jsonl'), '')
await writeFile(join(evidence, 'consumed-inputs.jsonl'), '')
async function suite(name, files, pattern, mutation) {
  const report = join(evidence, name + '.json'), loaded = join(evidence, name + '-loaded.jsonl')
  await writeFile(loaded, '')
  const args = [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'apps/desktop/test/toolkit-autostart.config.mts', ...files,
    ...(pattern ? ['-t', pattern] : []), '--reporter=json', '--outputFile=' + report]
  const outcome = await new Promise((accept, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, AGENTMUX_TOOLKIT_EVIDENCE: evidence,
      AGENTMUX_AUTOSTART_MUTATION: mutation ?? '', AGENTMUX_AUTOSTART_MUTATION_RECEIPT: loaded,
      AGENTMUX_AUTOSTART_INPUT_RECEIPT: join(evidence, 'consumed-inputs.jsonl') }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; child.stdout.on('data', value => { output += value }); child.stderr.on('data', value => { output += value })
    child.once('error', reject); child.once('close', (code, signal) => accept({ code, signal, output }))
  })
  await writeFile(join(evidence, name + '.log'), outcome.output)
  const result = JSON.parse(await readFile(report, 'utf8'))
  const assertions = result.testResults.flatMap(file => file.assertionResults), failures = assertions.filter(value => value.status === 'failed')
  assert.ok(assertions.some(value => value.status !== 'skipped'), name + ': nonempty actual consumer tests')
  if (mutation) {
    assert.equal(outcome.code, 1, outcome.output); assert.equal(outcome.signal, null)
    assert.ok(failures.some(value => value.failureMessages.some(message => /AssertionError|expected .*to/isu.test(message))), name + ': assertion RED')
    assert.ok((await readFile(loaded, 'utf8')).includes(mutation), name + ': mutated production source actually loaded')
  } else assert.equal(outcome.code, 0, outcome.output)
  results.push({ name, mutation, passed: result.numPassedTests, failed: result.numFailedTests })
  console.log(name + ': ' + (mutation ? 'assertion RED' : 'GREEN'))
}
await suite('public-main-and-drafts', ['apps/desktop/test/toolkit-autostart-main.test.ts', 'apps/desktop/test/toolkit-custom-drafts.test.tsx'])
const lifecycle = 'automatically execute an enabled bundled|unchecked startup choice|new execution at owner startup|loads once|reconnects the same running execution|retains unknown creation when|isolates a failed tool load|Runtime-confirmed Stop|keeps a confirmed terminal readable'
await suite('tui-lifecycle', ['apps/desktop/test/toolkit-tui-owner.test.ts'], lifecycle)
await suite('visible-controls', ['apps/desktop/test/toolkit-custom-ui.test.tsx'], 'startup checkbox')
await suite('physical-owner-restart', ['apps/desktop/test/toolkit-tui-process.test.ts'])
for (const [mutation, pattern] of [['choice', 'unchecked startup choice'], ['once', 'keeps a confirmed terminal readable'],
  ['terminal', 'new execution at owner startup'], ['bundled', 'automatically execute an enabled bundled']]) {
  await suite('mutant-' + mutation, ['apps/desktop/test/toolkit-tui-owner.test.ts'], pattern, mutation)
}
await suite('mutant-types', ['apps/desktop/test/toolkit-autostart-main.test.ts'], undefined, 'types')
const visual = JSON.parse(await readFile(join(evidence, 'visual/receipt.json'), 'utf8'))
const rendered = JSON.parse(await readFile(join(evidence, 'visual/toolkit-render.json'), 'utf8'))
assert.equal(rendered.qualified, true); assert.equal(visual.actualApp, true); assert.equal(visual.actualSettings, true)
assert.equal(visual.nativeCleanupConfirmed, true); assert.deepEqual(visual.remainingPrivateProcesses, [])
assert.ok(visual.frames.length >= 4); assert.equal(visual.failure, undefined)
const review = JSON.parse(await readFile(join(evidence, 'visual-review.json'), 'utf8'))
assert.equal(review.status, 'approved'); assert.ok(review.reviewer && review.images.length >= 4)
// Independent review qualifies these actual controls. Concurrent edits to a hidden, unrelated
// surface do not certify the entire App snapshot and do not invalidate unchanged reviewed UI.
for (const [file, sha] of Object.entries(review.inputs)) {
  assert.equal(visual.inputs[file]?.sha256, sha, 'Review must bind the captured product input: ' + file)
  assert.equal(hash(await readFile(resolve(root, file))), sha, 'Reviewed input changed: ' + file)
}
for (const file of review.images) assert.equal(hash(await readFile(resolve(root, file.path))), file.sha256, 'Reviewed image changed')
for (const [file, before] of Object.entries(inputs)) assert.equal(hash(await readFile(join(root, file))), before, 'Proof source changed: ' + file)
const consumed = new Map()
for (const line of (await readFile(join(evidence, 'consumed-inputs.jsonl'), 'utf8')).trim().split('\n')) {
  if (!line) continue
  const item = JSON.parse(line), hashes = consumed.get(item.file) ?? new Set()
  hashes.add(item.sha256); consumed.set(item.file, hashes)
}
for (const [file, hashes] of consumed) {
  const current = hash(await readFile(join(root, file)))
  assert.equal(hashes.size, 1, 'Consumed source changed during qualification: ' + file)
  assert.ok(hashes.has(current), 'Consumed source changed: ' + file)
  inputs[file] = current
}
for (const file of ['visual/receipt.json', 'visual-review.json']) inputs[join('.local/state/toolkit-autostart', file)] = hash(await readFile(join(evidence, file)))
for (const file of review.images) inputs[file.path] = file.sha256
Object.assign(inputs, review.inputs)
await writeFile(join(evidence, 'proof.json'), JSON.stringify({ passed: true, inputs, results, visual: review }, null, 2) + '\n')
