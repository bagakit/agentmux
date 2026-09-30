import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const root = resolve(new URL('../../../../..', import.meta.url).pathname), hash = bytes => createHash('sha256').update(bytes).digest('hex')
const entryPath = join(root, 'apps/desktop/scripts/verify-browser-input-history-native-receipt.mjs')
const helperPath = join(root, 'apps/desktop/scripts/browser-input-history-component-evidence.mjs')
const testPath = join(root, 'apps/desktop/scripts/fixtures/browser-input-history/component-native-consumer.test.mjs')
const entry = await readFile(entryPath, 'utf8'), helper = await readFile(helperPath, 'utf8')
const scratch = await mkdtemp(join(tmpdir(), 'agentmux-history-component-consumer-mutants-'))
assert.ok(process.argv.length <= 4 && (!process.argv[3] || process.argv[3] === '--visual-only'), 'Only an output directory and --visual-only are accepted')
const output = resolve(process.argv[2] ?? `docs/reviews/evidence/browser-input-history-component-native-2026-10-04/consumer-source/attempt-${Date.now()}`)
await mkdir(output, { recursive: true })
const blocks = [
  ['source-collection', 'empty actual Source collection', 'helper', "nonempty(receipt.source.inputs, 'Actual emitted Source originals')", '/* Nonempty actual Source collection guard removed. */'],
  ['original-hash', 'corrupted actual Source identity', 'helper', "assert.equal(hash(bytes), row.sha256, 'Original hash matches: ' + row.path)", '/* Actual original byte hash guard removed. */'],
  ['loaded-binding', 'actual loaded artifact binding', 'helper', "assert.equal(loaded.sha256, artifact.sha256, 'Actual loaded hash matches compiled original')", '/* Actual loaded-to-compiled identity guard removed. */'],
  ['different-native-pids', 'actual Native recovery requires', 'helper', "assert.notEqual(phases[0].pid, phases[1].pid, 'Durable recovery has two different actual Native PIDs')", '/* Different actual Native PID guard removed. */'],
  ['ipc-actor', 'actual history IPC actor', 'helper', "assert.equal(call.senderWebContentsId, phase.owner.rendererWebContentsId, 'History IPC uses the actual Renderer owner')", '/* Actual history IPC owner guard removed. */'],
  ['native-durable-recovery', 'actual second-process recovery', 'helper', "assert.deepEqual(first.durable.saved, second.durable?.recovered, 'Second actual Native process recovered the original history')", '/* Actual two-process Native recovery comparison removed. */'],
  ['late-selection', 'actual late response selection', 'helper', "assert.deepEqual(late.after.selection, late.before.selection, 'Late response preserved selection')", '/* Actual late-response selection comparison removed. */'],
  ['composing-submit', 'actual composing Enter submission', 'helper', "assert.ok(!ime.during.submissions.some(submission => submission.at >= composingEnter[0].at), 'Actual composing Enter did not submit')", '/* Actual composing Enter submission result guard removed. */'],
  ['independent-false-visual', 'actual independent false visual', 'helper', 'passed: review.passed, originalPageComposedVisibilityPassed: review.originalPageComposedVisibilityPassed,', 'passed: true, originalPageComposedVisibilityPassed: review.originalPageComposedVisibilityPassed,'],
  ['formal-exit', 'actual partial component behavior', 'entry', 'process.exitCode = 2', 'process.exitCode = 0'],
  ['visual-author', 'actual visual review rejects', 'helper', "assert.equal(review.author, receipt.author, 'Visual review binds the actual producer author')", '/* Actual visual producer author guard removed. */'],
  ['visual-unique-paths', 'actual visual review rejects', 'helper', "assert.equal(new Set(review.images.map(row => row.path)).size, review.images.length, 'Reviewed original paths are unique')", '/* Actual reviewed path uniqueness guard removed. */'],
  ['visual-case-identity', 'actual visual review rejects', 'helper', "assert.deepEqual(['phase', 'label', 'kind', 'path', 'sha256', 'bytes'].map(key => row[key]),\n        ['phase', 'label', 'kind', 'path', 'sha256', 'bytes'].map(key => captured[key]), 'Reviewed image binds the actual case/phase/kind original')", '/* Actual reviewed case/phase/kind original comparison removed. */'],
  ['visual-current-os-cases', 'actual receipt with no OS originals', 'helper', "assert.deepEqual([...new Set(osImages.map(image => image.label))].sort(), ['narrow', 'normal', 'short'], 'Three current cases have actual OS composed-window originals')", '/* Actual current OS case coverage removed. */']
].filter(row => process.argv[3] !== '--visual-only' || row[0].startsWith('visual-'))
assert.ok(blocks.length > 0)
const receipt = { schema: 'agentmux.browser-input-history-component-consumer-source-mutations.v1', passed: false, nativePassed: false, taskComplete: false,
  source: { entry: { path: entryPath, sha256: hash(Buffer.from(entry)) }, helper: { path: helperPath, sha256: hash(Buffer.from(helper)) } }, blocks: [], temporaryRemoved: false }
function execute(label, modulePath, pattern) {
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...(pattern ? ['--test-name-pattern', pattern] : []), testPath],
    { cwd: root, env: { ...process.env, AGENTMUX_HISTORY_COMPONENT_CONSUMER_MODULE: modulePath }, encoding: 'utf8', timeout: 15000, maxBuffer: 3 * 1024 * 1024 })
  return { label, status: run.status, signal: run.signal, error: run.error?.message, stdout: run.stdout, stderr: run.stderr }
}
try {
  await writeFile(join(output, 'entry-original.mjs'), entry)
  await writeFile(join(output, 'helper-original.mjs'), helper)
  await writeFile(join(output, 'test-original.mjs'), await readFile(testPath))
  const baseline = execute('baseline', entryPath); await writeFile(join(output, 'baseline.json'), JSON.stringify(baseline))
  assert.equal(baseline.status, 0); assert.equal(baseline.error, undefined)
  for (const [id, pattern, leaf, before, after] of blocks) {
    const original = leaf === 'helper' ? helper : entry
    assert.equal(original.split(before).length - 1, 1, 'Actual Source mutation anchor occurs exactly once: ' + id)
    const changed = original.replace(before, after), directory = join(scratch, id); await mkdir(directory)
    await writeFile(join(output, id + '-changed-source.mjs'), changed)
    const candidateEntry = leaf === 'entry' ? changed : entry, candidateHelper = leaf === 'helper' ? changed : helper
    await writeFile(join(directory, 'verify-browser-input-history-native-receipt.mjs'), candidateEntry)
    await writeFile(join(directory, 'browser-input-history-component-evidence.mjs'), candidateHelper)
    const red = execute(id, join(directory, 'verify-browser-input-history-native-receipt.mjs'), pattern)
    await writeFile(join(output, id + '.json'), JSON.stringify(red))
    assert.equal(red.status, 1, 'Actual changed Source must reach a failing assertion: ' + id)
    assert.equal(red.error, undefined); assert.equal(red.signal, null)
    assert.match(red.stdout + red.stderr, /ERR_ASSERTION|AssertionError/)
    assert.doesNotMatch(red.stdout + red.stderr, /SyntaxError|ERR_MODULE_NOT_FOUND|Cannot find module/)
    receipt.blocks.push({ id, sourcePath: leaf === 'entry' ? entryPath : helperPath, before, after, changedSourceSha256: hash(Buffer.from(changed)), assertionRed: true, log: id + '.json' })
  }
  const restored = execute('restored', entryPath); await writeFile(join(output, 'restored.json'), JSON.stringify(restored))
  assert.equal(restored.status, 0); assert.equal(restored.error, undefined)
  receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
finally {
  assert.equal(await readFile(entryPath, 'utf8'), entry); assert.equal(await readFile(helperPath, 'utf8'), helper)
  await rm(scratch, { recursive: true }); receipt.temporaryRemoved = true
  await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2))
}
process.stdout.write(JSON.stringify({ passed: receipt.passed, sourceBlocks: receipt.blocks.length, nativePassed: false, taskComplete: false, output }) + '\n')
process.exitCode = receipt.passed ? 0 : 1
