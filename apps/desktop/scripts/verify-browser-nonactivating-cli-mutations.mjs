import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const config = 'apps/desktop/scripts/fixtures/browser-nonactivating-cli/vitest.owning.config.mts'
const evidence = resolve(process.argv[2] ?? join(root, 'docs/reviews/evidence/browser-nonactivating-cli-source-2026-10-04', `attempt-${Date.now()}`))
const inputPaths = [config, 'apps/desktop/scripts/fixtures/browser-nonactivating-cli/tsconfig.owning.json',
  'apps/desktop/scripts/verify-browser-nonactivating-cli-mutations.mjs', 'apps/desktop/test/browser-nonactivating-cli.test.ts',
  'apps/desktop/test/view-focus.test.ts', 'apps/desktop/src/renderer/src/lib/control.ts',
  'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/components/NewTabSurface.tsx',
  'packages/core/src/agentmux-cli-help.ts', 'packages/core/src/agentmux.ts']
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const identity = async paths => Object.fromEntries(await Promise.all(paths.map(async path => {
  const bytes = await readFile(join(root, path)); return [path, { sha256: digest(bytes), bytes: bytes.length }]
})))
const sourceBefore = await identity(inputPaths)
const configSource = await readFile(join(root, config), 'utf8')
const mutations = [...configSource.matchAll(/^  '([^']+)': \[/gm)].map(match => match[1])
assert.ok(mutations.length > 0, 'Source-owned mutation blocks must be nonempty')
assert.equal(new Set(mutations).size, mutations.length)
await mkdir(evidence, { recursive: false })
const receipt = { schema: 'agentmux.browser-nonactivating-cli-source.v1', taskId: 'T-025', author: '/root/browser_source_closeout',
  passed: false, scope: 'actual-source-cli-store-renderer-input', native: 'not-tested', desktopRecovery: 'not-tested',
  observedHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceBefore, sharedTreeMutations: 0, userRuntimeCalls: 0, cases: [] }
async function run(label, mutation) {
  const loaded = join(evidence, `${label}.loaded.jsonl`)
  const env = { ...process.env, AGENTMUX_BROWSER_NONACTIVATING_LOADED: loaded }
  delete env.AGENTMUX_BROWSER_NONACTIVATING_MUTATION
  if (mutation) env.AGENTMUX_BROWSER_NONACTIVATING_MUTATION = mutation
  const result = await new Promise((yes, no) => {
    const child = spawn(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, '--maxWorkers=1'],
      { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = [], stderr = []
    child.stdout.on('data', bytes => stdout.push(bytes)); child.stderr.on('data', bytes => stderr.push(bytes))
    child.on('error', no); child.on('close', (code, signal) => yes({ code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }))
  })
  await writeFile(join(evidence, `${label}.stdout.txt`), result.stdout)
  await writeFile(join(evidence, `${label}.stderr.txt`), result.stderr)
  const rows = (await readFile(loaded, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.ok(rows.length > 0, 'Actual loaded Source collection must be nonempty')
  assert.ok(rows.some(row => row.consumer === 'public-source-cli-ssr' && row.path === 'packages/core/src/agentmux.ts'), 'Actual public CLI Source must be compiled')
  for (const row of rows) {
    assert.match(row.sourceSha256, /^[0-9a-f]{64}$/); assert.match(row.loadedSha256, /^[0-9a-f]{64}$/)
    if (!row.mutation) assert.equal(row.sourceSha256, row.loadedSha256)
  }
  const output = result.stdout.toString() + result.stderr.toString()
  return { code: result.code, signal: result.signal, output, rows,
    stdout: `${label}.stdout.txt`, stderr: `${label}.stderr.txt`, loaded: `${label}.loaded.jsonl` }
}
function green(run, expected) {
  assert.equal(run.code, 0, run.output)
  const files = /Test Files\s+(\d+) passed \((\d+)\)/.exec(run.output)
  const tests = /Tests\s+(\d+) passed \((\d+)\)/.exec(run.output)
  assert.ok(files && tests, 'Both owning suites must actually run')
  assert.equal(Number(files[1]), 2); assert.equal(files[1], files[2]); assert.equal(tests[1], tests[2])
  assert.ok(Number(tests[1]) > 0)
  if (expected) assert.equal(Number(tests[1]), expected)
  return Number(tests[1])
}
function refs(run) { return { code: run.code, signal: run.signal, stdout: run.stdout, stderr: run.stderr, loaded: run.loaded } }
try {
  const baseline = await run('baseline')
  const testCount = green(baseline)
  receipt.baseline = { ...refs(baseline), testCount }
  const actualPaths = [...new Set(baseline.rows.map(row => row.path))].sort()
  assert.ok(actualPaths.includes('apps/desktop/src/renderer/src/components/NewTabSurface.tsx'))
  receipt.loadedInputs = await identity(actualPaths)
  for (const row of baseline.rows) assert.equal(row.sourceSha256, receipt.loadedInputs[row.path].sha256, `Actual loaded bytes: ${row.path}`)
  for (const mutation of mutations) {
    const red = await run(mutation, mutation)
    assert.notEqual(red.code, 0, `${mutation} must turn the actual consumer RED`)
    assert.match(red.output, /AssertionError:/, `${mutation} must be an assertion failure, not setup failure`)
    assert.match(red.output, /Tests\s+\d+ failed \| \d+ passed \(\d+\)/, 'Nonempty actual test results')
    const applied = red.rows.filter(row => row.mutation === mutation)
    assert.ok(applied.length > 0, `Actual ${mutation} Source block must be loaded`)
    for (const row of applied) assert.notEqual(row.sourceSha256, row.loadedSha256)
    const restored = await run(`${mutation}-restored`)
    green(restored, testCount)
    receipt.cases.push({ mutation, assertionRed: true, mutatedInputs: applied, red: refs(red), restored: refs(restored), restoredTestCount: testCount })
    process.stdout.write(`${mutation}: Assertion RED → restored ${testCount} GREEN\n`)
  }
  receipt.loadedInputsAfter = await identity(actualPaths)
  assert.deepEqual(receipt.loadedInputsAfter, receipt.loadedInputs, 'Actual loaded inputs must stay the same before/after')
  receipt.sourceAfter = await identity(inputPaths)
  assert.deepEqual(receipt.sourceAfter, sourceBefore, 'Own Source input bytes must stay the same before/after')
  receipt.passed = true
} catch (error) {
  receipt.error = { name: error.name, message: error.message, stack: error.stack }
  process.exitCode = 1
} finally {
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  process.stdout.write(JSON.stringify({ passed: receipt.passed, evidence, cases: receipt.cases.length }) + '\n')
}
