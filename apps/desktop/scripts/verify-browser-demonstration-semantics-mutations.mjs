import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const evidence = resolve(process.argv[2] ?? join(root, '.tmp', ("browser-demonstration-semantics-" + (globalThis.crypto.randomUUID()) + "")))
const selectedLabel = process.argv[3]
const projector = 'apps/desktop/src/main/browser-demonstration-interpretation.ts'
const semantics = 'apps/desktop/src/shared/browser-demonstration-semantics.ts'
const editor = 'apps/desktop/src/renderer/src/components/BrowserTaskAssetEditor.tsx'
const products = [projector, semantics, editor, 'apps/desktop/src/main/browser-demonstration-recorder.ts',
  'apps/desktop/src/main/browser-task-assets.ts', 'apps/desktop/src/shared/browser-task-assets.ts',
  'apps/desktop/src/renderer/src/components/BrowserDemonstrationSurface.tsx', 'apps/desktop/src/renderer/src/components/BrowserDemonstrationSuggestion.tsx']
const config = 'apps/desktop/scripts/fixtures/browser-demonstration-semantics/vitest.owning.config.mts'
const inputs = [...products, config, 'apps/desktop/test/browser-demonstration-semantics.test.tsx']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const original = new Map(await Promise.all(inputs.map(async path => [path, await readFile(join(root, path))])))
const copy = await mkdtemp(join(tmpdir(), 'amx-demonstration-semantics-'))
const receipt = { schema: 'agentmux.browser-demonstration-semantics-source-mutations.v1', taskComplete: false, nativePassed: false, passed: false,
  originalHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceBefore: Object.fromEntries([...original].map(([path, bytes]) => [path, hash(bytes)])), cases: [] }
function block(file, start, end) {
  const text = original.get(file).toString(), from = text.indexOf(start), to = text.indexOf(end, from)
  assert.ok(from >= 0 && to > from, 'Both actual Source anchors and their content are nonempty')
  return text.slice(from, to)
}
const mutations = [
  { label: 'actual-stop-cancellation-block-removed', file: projector, target: 'cancels preparation on actual stop',
    before: " ||\n      (previous.status === 'recording' && draft.status !== 'recording')", after: '' },
  { label: 'actual-async-fact-revision-guard-removed', file: projector, target: 'older changed-step explanation',
    before: block(projector, '        if (this.epoch !== epoch', '        this.entries.set(step.id, { ...result'), after: '' },
  { label: 'actual-private-args-sanitization-removed', file: projector, target: 'drops raw args before', before: 'url: step.url, args: [],', after: 'url: step.url, args: step.args,' },
  { label: 'actual-private-target-secret-guard-removed', file: semantics, target: 'drops raw args before', before: ' || /password/i.test(target.role)', after: '' },
  { label: 'actual-edit-reset-triggered-by-late-suggestion', file: editor, target: 'retains an edited title and deleted step',
    before: '[asset?.id, asset?.revision])', after: '[asset?.id, asset?.revision, suggestions])' },
  { label: 'actual-failure-state-hidden-as-interpreting', file: projector, target: 'preparation and publication failures',
    before: "{ ...candidate, status: 'failed', reason: 'Suggestion could not be prepared.", after: "{ ...candidate, status: 'interpreting', reason: 'Suggestion could not be prepared." },
  { label: 'actual-editor-suggestion-preview-removed', file: editor, target: 'previews the matching suggestion before explicit use',
    before: '            <DemonstrationSuggestion suggestion={asset.sourceRecordingId === recording?.id ? suggestions?.find(item => item.stepId === step.id) : undefined} />\n', after: '' }
]
async function run(label, target) {
  const result = await new Promise((yes, no) => {
    const child = spawn(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', join(copy, 'shadow.config.mts'), '--maxWorkers=1', ...(target ? ['-t', target] : [])],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; child.stdout.on('data', b => { output += b }); child.stderr.on('data', b => { output += b })
    child.on('error', no); child.on('close', (code, signal) => yes({ code, signal, output }))
  })
  await writeFile(join(evidence, `${label}.log`), result.output); return result
}
function green(result, count) {
  assert.equal(result.code, 0, result.output); assert.equal(result.signal, null)
  const tests = /Tests\s+(\d+) passed/.exec(result.output)
  assert.ok(tests, 'Actual cases were nonempty'); assert.equal(Number(tests[1]), count)
}
try {
  await mkdir(dirname(evidence), { recursive: true }); await mkdir(evidence)
  for (const [path, bytes] of original) { await mkdir(dirname(join(copy, path)), { recursive: true }); await writeFile(join(copy, path), bytes) }
  const shadow = `import config from ${JSON.stringify(join(root, config))}
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const projected=${JSON.stringify(Object.fromEntries(products.map(path => [join(root, path), join(copy, path)])))}
export default {...config, plugins:[{name:'actual-demonstration-source', enforce:'pre', load(id) {
const file=projected[id.split('?')[0]];if(!file)return null;const bytes=readFileSync(file);console.log('ACTUAL_DEMONSTRATION_SOURCE_LOAD',id,createHash('sha256').update(bytes).digest('hex'),bytes.length);return bytes.toString()
}}]}
`
  await writeFile(join(copy, 'shadow.config.mts'), shadow)
  execFileSync('tar', ['-czf', join(evidence, 'original-source.tar.gz'), '-C', copy, '.'])
  green(await run('baseline-green'), 13)
  const selected = selectedLabel ? mutations.filter(mutant => mutant.label === selectedLabel) : mutations
  assert.ok(selected.length > 0, 'Actual mutation selection is nonempty')
  if (selectedLabel) assert.equal(selected.length, 1)
  for (const mutant of selected) {
    const source = original.get(mutant.file).toString(); assert.equal(source.split(mutant.before).length - 1, 1, `Unique real block ${mutant.label}`)
    const changed = source.replace(mutant.before, mutant.after); await writeFile(join(copy, mutant.file), changed)
    await writeFile(join(evidence, `${mutant.label}-source.txt`), changed)
    try {
      const red = await run(`${mutant.label}-red`, mutant.target)
      assert.ok(red.code > 0 && red.signal === null, red.output); assert.match(red.output, /AssertionError/); assert.match(red.output, /Tests\s+[1-9]\d* failed/)
      assert.ok(red.output.includes(hash(changed)), 'Changed actual Source was loaded')
    } finally { await writeFile(join(copy, mutant.file), original.get(mutant.file)) }
    green(await run(`${mutant.label}-restored`, mutant.target), 1)
    receipt.cases.push({ label: mutant.label, file: mutant.file, target: mutant.target, mutantSha256: hash(changed), assertionRed: true, restoredTests: 1 })
    console.log(`Actual Assertion RED / restored GREEN: ${mutant.label}`)
  }
  green(await run('baseline-restored'), 13)
  receipt.sourceAfter = Object.fromEntries(await Promise.all(inputs.map(async path => [path, hash(await readFile(join(root, path)))])))
  assert.deepEqual(receipt.sourceAfter, receipt.sourceBefore, 'Original inputs stayed exact'); receipt.passed = true
} catch (error) { receipt.failure = error instanceof Error ? error.message : String(error); throw error }
finally { await rm(copy, { recursive: true, force: true }); receipt.privateProjectionRemoved = true; await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n') }
