import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'

// Focus local content selection, not the whole T002 presentation/Native gate.
const root = resolve(import.meta.dirname, '../../..')
const args = process.argv.slice(2)
assert.ok(args[0] === '--evidence' && args[1] && args.length === 2, 'Use --evidence <new private evidence directory>')
const evidence = resolve(args[1])
await mkdir(evidence, { recursive: true })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const sources = [
  'apps/desktop/src/renderer/src/lib/agent-focus.ts', 'apps/desktop/src/renderer/src/store.ts',
  'apps/desktop/src/renderer/src/lib/focus-tab-projection.ts', 'apps/desktop/src/renderer/src/App.tsx',
  'apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx',
  'apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx',
  'apps/desktop/src/renderer/src/components/StableWorkbenchView.tsx',
  'apps/desktop/src/renderer/src/lib/workbench-presentation.ts',
  'apps/desktop/test/focus-local-workbench-selection.test.tsx',
  'apps/desktop/scripts/fixtures/shared-workbench-bindings/vitest.focus-local-selection.config.mts',
  'apps/desktop/scripts/fixtures/shared-workbench-bindings/tsconfig.focus-local-selection.json',
  'apps/desktop/src/renderer/src/styles/focus.css'
]
const hashes = async () => Object.fromEntries(await Promise.all(sources.map(async file => [file, hash(await readFile(join(root, file)))])))
const before = await hashes()
const run = async (label, executable, parameters, environment = {}) => {
  let result
  try {
    const output = await promisify(execFile)(executable, parameters, { cwd: root,
      env: { ...process.env, pnpm_config_verify_deps_before_run: 'false', NODE_OPTIONS: '--max-old-space-size=1536', ...environment },
      timeout: 120000, maxBuffer: 8 * 1024 * 1024 })
    result = { code: 0, signal: null, output: output.stdout + output.stderr }
  } catch (error) { result = { code: error.code, signal: error.signal, output: (error.stdout ?? '') + (error.stderr ?? '') } }
  await writeFile(join(evidence, `${label}.log`), result.output)
  return { code: result.code, signal: result.signal, log: `${label}.log` }
}
const receipt = { schema: 'agentmux.shared-workbench-focus-local-selection.v1', passed: false,
  sourceBefore: before, owning: null, mutations: [], types: [], callers: {},
  boundary: 'Actual mounted App/GlobalFocus/Store/original Workbench and installed browser Panel primary; typed preview API, only PTY painting isolated. Not full T002, Native simultaneous bindings, Runtime/Writer, ordinary GUI restart, user Run or installation.' }
try {
  const vitest = join(root, 'node_modules/.bin/vitest')
  const config = 'apps/desktop/scripts/fixtures/shared-workbench-bindings/vitest.focus-local-selection.config.mts'
  const test = async (label, mutation) => {
    const loaded = join(evidence, `${label}-loaded.jsonl`), report = join(evidence, `${label}-result.json`)
    const execution = await run(label, vitest, ['run', '--config', config, '--reporter=verbose', '--reporter=json', `--outputFile=${report}`], {
      AGENTMUX_FOCUS_LOCAL_LOADED: loaded,
      ...(mutation ? { AGENTMUX_FOCUS_LOCAL_MUTATION: mutation } : {})
    })
    const result = JSON.parse(await readFile(report, 'utf8'))
    assert.equal(result.numTotalTests, 7, 'Literal owning collection must be nonempty and exact')
    const modules = (await readFile(loaded, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.ok(modules.length > 0)
    for (const file of sources.slice(0, 8)) {
      const consumed = modules.filter(row => row.path === file)
      assert.ok(consumed.length > 0, `Actual caller loaded: ${file}`)
      for (const row of consumed) assert.equal(row.sourceSHA256, before[file])
    }
    if (mutation) {
      const changed = modules.filter(row => row.mutated)
      assert.equal(changed.length, 1, 'One actual loaded semantic mutation')
      assert.equal(changed[0].mutation, mutation)
      assert.notEqual(changed[0].loadedSHA256, changed[0].sourceSHA256)
      assert.ok(typeof execution.code === 'number' && execution.code > 0 && execution.signal === null)
      assert.ok(result.numFailedTests > 0)
      const failures = result.testResults.flatMap(file => file.assertionResults).flatMap(test => test.failureMessages)
      assert.ok(failures.some(message => /AssertionError/.test(message)), 'A loaded semantic AssertionRED, not collect/preparation error')
    } else {
      assert.equal(execution.code, 0)
      assert.equal(result.numPassedTests, 7)
      assert.equal(result.numFailedTests, 0)
      assert.equal(modules.filter(row => row.mutated).length, 0)
    }
    return { ...execution, collected: result.numTotalTests, passed: result.numPassedTests,
      failed: result.numFailedTests, loaded: relative(evidence, loaded), report: relative(evidence, report),
      actualLoadedCount: modules.length, changed: modules.filter(row => row.mutated) }
  }
  receipt.owning = await test('baseline')
  for (const mutation of ['session-only-local-selection', 'agent-only-held-occurrence', 'ignore-local-intent', 'drop-confirmed-display-group', 'false-display-recovery-notice']) {
    const red = await test(`${mutation}-red`, mutation)
    const green = await test(`${mutation}-restored`)
    receipt.mutations.push({ mutation, red, green })
  }
  const adjacentReport = join(evidence, 'adjacent-result.json')
  const adjacent = await run('adjacent', vitest, ['run', '--config',
    'apps/desktop/scripts/fixtures/shared-workbench-bindings/vitest.presentation.config.mts',
    '--reporter=verbose', '--reporter=json', `--outputFile=${adjacentReport}`])
  const adjacentResult = JSON.parse(await readFile(adjacentReport, 'utf8'))
  assert.equal(adjacent.code, 0)
  assert.equal(adjacentResult.numTotalTests, 9)
  assert.equal(adjacentResult.numPassedTests, 9)
  assert.equal(adjacentResult.numFailedTests, 0)
  receipt.adjacent = { ...adjacent, collected: 9, passed: 9, failed: 0 }
  for (const [label, config] of [['production', 'apps/desktop/tsconfig.json'], ['owning', 'apps/desktop/scripts/fixtures/shared-workbench-bindings/tsconfig.focus-local-selection.json']]) {
    const result = await run(`${label}-types`, join(root, 'node_modules/.bin/tsc'), ['--noEmit', '-p', config])
    assert.equal(result.code, 0, await readFile(join(evidence, result.log), 'utf8'))
    receipt.types.push({ label, ...result })
  }
  const filesIn = async directory => (await Promise.all((await readdir(directory, { withFileTypes: true })).map(entry =>
    entry.isDirectory() ? filesIn(join(directory, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(directory, entry.name)] : []))).flat()
  const files = await filesIn(join(root, 'apps/desktop/src/renderer/src'))
  assert.ok(files.length > 0)
  for (const [symbol, definition] of [['executionFocusPresentation', 'lib/focus-tab-projection.ts'],
    ['focusExecution', 'lib/agent-focus.ts'], ['selectExecutionFocusReference', 'store.ts']]) {
    const callers = []
    for (const file of files) if (file !== join(root, 'apps/desktop/src/renderer/src', definition) &&
      new RegExp(`\\b${symbol}\\b`).test(await readFile(file, 'utf8'))) callers.push(relative(root, file))
    assert.ok(callers.length > 0, `Non-definition product callers: ${symbol}`)
    receipt.callers[symbol] = callers
  }
  receipt.sourceAfter = await hashes()
  assert.deepEqual(receipt.sourceAfter, before)
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack } }
finally { await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n') }
assert.equal(receipt.passed, true, receipt.failure?.message)
console.log(JSON.stringify({ passed: true, receipt: join(evidence, 'receipt.json'), wholeTaskDone: false }))
