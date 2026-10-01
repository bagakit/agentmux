import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const evidence = resolve(process.argv[2] ?? join(root, '.tmp', ("browser-task-reliability-mutations-" + (globalThis.crypto.randomUUID()) + "")))
const selectedLabel = process.argv[3]
const helper = 'apps/desktop/src/shared/browser-task-reliability.ts'
const owner = 'apps/desktop/src/main/browser-task-assets.ts'
const view = 'apps/desktop/src/renderer/src/components/BrowserTaskReliability.tsx'
const status = 'apps/desktop/src/renderer/src/components/BrowserOperationSurface.tsx'
const test = 'apps/desktop/test/browser-task-reliability.test.tsx'
const config = 'apps/desktop/scripts/fixtures/browser-task-reliability/vitest.owning.config.mts'
const pane = 'apps/desktop/src/renderer/src/components/BrowserPane.tsx'
const paneConfig = 'apps/desktop/scripts/fixtures/browser-task-reliability/vitest.pane.config.mts'
const paneTarget = 'real Pane Verify refreshes the selected older run read'
const products = [helper, owner, view, status, 'apps/desktop/src/shared/browser-task-assets.ts', 'apps/desktop/src/renderer/src/components/BrowserTaskAssetEditor.tsx', pane]
const files = [...products, test, config, paneConfig, 'apps/desktop/test/browser-task-reliability-pane.test.tsx']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const source = new Map(await Promise.all(files.map(async path => [path, await readFile(join(root, path))])))
const copy = await mkdtemp(join(tmpdir(), 'amx-reliability-source-'))
const receipt = { schema: 'agentmux.browser-task-reliability-source-mutations.v1', taskComplete: false, nativePassed: false, passed: false,
  originalHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceBefore: Object.fromEntries([...source].map(([path, bytes]) => [path, hash(bytes)])), cases: [] }
function block(path, start, end) {
  const text = source.get(path).toString(), from = text.indexOf(start), to = text.indexOf(end, from)
  assert.ok(from >= 0 && to > from, 'Both real Source block anchors must be nonempty')
  return text.slice(from, to)
}
const joinBlock = block(helper, '  if (!evaluation ||', '  const status = evaluation.conditions')
const mutations = [
  { label: 'actual-version-filter-removed', file: helper, target: 'separates versions',
    before: ' || run.version !== version', after: '' },
  { label: 'actual-run-dedup-removed', file: helper, target: 'deduplicates repeated run',
    before: 'else runs.set(run.id, run)', after: "else runs.set(`${run.id}:${runs.size}`, run)" },
  { label: 'actual-complete-outcome-join-removed', file: helper, target: 'refuses empty, partial', before: joinBlock, after: '' },
  { label: 'actual-zero-sample-rate-fabricated', file: helper, target: 'gives zero samples no rate',
    before: 'passRate: samples.length ? counts.passed / samples.length : null', after: 'passRate: samples.length ? counts.passed / samples.length : 1' },
  { label: 'actual-main-selected-projection-removed', file: owner, target: 'actual durable Main state',
    before: '      ...(browserId ? { selectedRunId: this.document.selectedRuns?.find(item => item.browserId === browserId)?.runId ?? null } : {}),\n', after: '' },
  { label: 'actual-control-selected-replaced-by-last', file: status, target: 'older Main-selected ready run',
    before: '  const latestRun = taskAssets?.runs.find(run => run.browserId === browserId && run.id === taskAssets.selectedRunId)',
    after: '  const latestRun = taskAssets?.runs.at(-1)' },
  { label: 'actual-async-result-owner-guard-removed', file: view, target: 'rejects a late earlier version result',
    before: '      if (!current) return\n', after: '' },
  { label: 'actual-public-result-tuple-guard-removed', file: view, target: 'another requested version',
    before: block(view, '      if (result.browserId !== browserId', '      setState({ key, result })'), after: '' },
  { label: 'actual-declared-producer-identity-removed', file: helper, target: 'original declared producing step and navigation',
    before: '      !registration.context.workspaceId || !registration.context.navigationId || producerIndex < 0 || producerOperationId !== operation.id ||\n', after: '' },
  { label: 'actual-selected-version-scope-removed', file: helper, target: 'separates versions',
    before: ' && run.assetId === assetId && run.version === version) : undefined', after: ') : undefined' },
  { label: 'actual-invalid-date-display-guard-removed', file: view, target: 'timestamps exceed the Date range',
    before: "  return Number.isFinite(date.getTime()) ? date.toISOString() : 'unavailable'", after: '  return date.toISOString()' },
  { label: 'actual-verified-version-read-refresh-removed', file: view, target: 'exact older version public read after Verify',
    before: '    setRevisions(current => ({ ...current, [key]: (current[key] ?? 0) + 1 }))', after: '    void key' },
  { label: 'actual-pane-verified-read-refresh-removed', file: pane, target: paneTarget,
    before: '                taskReliabilityRefresh.markVerified(result)\n', after: '' }
]
async function run(label, target) {
  const result = await new Promise((yes, no) => {
    const child = spawn(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', join(copy, target === paneTarget ? 'shadow-pane.config.mts' : 'shadow.config.mts'), '--maxWorkers=1', ...(target ? ['-t', target] : [])],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; child.stdout.on('data', b => { output += b }); child.stderr.on('data', b => { output += b })
    child.on('error', no); child.on('close', (code, signal) => yes({ code, signal, output }))
  })
  await writeFile(join(evidence, `${label}.log`), result.output)
  return result
}
function green(result, count) {
  assert.equal(result.code, 0, result.output); assert.equal(result.signal, null)
  const tests = /Tests\s+(\d+) passed/.exec(result.output)
  assert.ok(tests, 'The actual test set is nonempty'); assert.equal(Number(tests[1]), count)
}
try {
  await mkdir(dirname(evidence), { recursive: true }); await mkdir(evidence)
  for (const [path, bytes] of source) { await mkdir(dirname(join(copy, path)), { recursive: true }); await writeFile(join(copy, path), bytes) }
  const shadow = `import config from ${JSON.stringify(join(root, config))}
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const projected=${JSON.stringify(Object.fromEntries(products.map(path => [join(root, path), join(copy, path)])))}
export default {...config, plugins:[{name:'actual-reliability-source', enforce:'pre', load(id) {
  const file=projected[id.split('?')[0]]; if(!file)return null
  const bytes=readFileSync(file); console.log('ACTUAL_RELIABILITY_SOURCE_LOAD',id,createHash('sha256').update(bytes).digest('hex'),bytes.length);return bytes.toString()
}}]}
`
  await writeFile(join(copy, 'shadow.config.mts'), shadow)
  await writeFile(join(copy, 'shadow-pane.config.mts'), shadow.replace(JSON.stringify(join(root, config)), JSON.stringify(join(root, paneConfig))))
  execFileSync('tar', ['-czf', join(evidence, 'original-source.tar.gz'), '-C', copy, '.'])
  green(await run('baseline-green'), 19)
  const selected = selectedLabel ? mutations.filter(mutant => mutant.label === selectedLabel) : mutations
  assert.ok(selected.length > 0, 'Actual mutation selection is nonempty')
  if (selectedLabel) assert.equal(selected.length, 1)
  for (const mutant of selected) {
    const original = source.get(mutant.file).toString()
    assert.equal(original.split(mutant.before).length - 1, 1, `Exact nonempty block: ${mutant.label}`)
    const changed = original.replace(mutant.before, mutant.after)
    await writeFile(join(copy, mutant.file), changed)
    await writeFile(join(evidence, `${mutant.label}-source.txt`), changed)
    let red
    try {
      red = await run(`${mutant.label}-red`, mutant.target)
      assert.ok(red.code > 0 && red.signal === null, red.output)
      assert.match(red.output, /AssertionError/); assert.match(red.output, /Tests\s+[1-9]\d* failed/)
      assert.ok(red.output.includes(hash(changed)), 'The actual changed module was loaded')
    } finally { await writeFile(join(copy, mutant.file), source.get(mutant.file)) }
    green(await run(`${mutant.label}-restored`, mutant.target), 1)
    receipt.cases.push({ label: mutant.label, file: mutant.file, target: mutant.target, mutantSha256: hash(changed), assertionRed: true, restoredTests: 1 })
    console.log(`Actual Assertion RED / restored GREEN: ${mutant.label}`)
  }
  green(await run('baseline-restored'), 19)
  receipt.sourceAfter = Object.fromEntries(await Promise.all(files.map(async path => [path, hash(await readFile(join(root, path)))])))
  assert.deepEqual(receipt.sourceAfter, receipt.sourceBefore, 'Original product and test input stayed exact')
  receipt.passed = true
} catch (error) { receipt.failure = error instanceof Error ? error.message : String(error); throw error }
finally { await rm(copy, { recursive: true, force: true }); receipt.privateProjectionRemoved = true; await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n') }
