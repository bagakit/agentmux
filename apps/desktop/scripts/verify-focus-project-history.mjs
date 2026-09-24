import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const args = process.argv.slice(2), slice = args[args.indexOf('--slice') + 1]
if (slice !== 'retained-focus') throw new Error('This verifier currently owns only retained-focus; complete-history is a separate Task.')
const directory = resolve(root, `.tmp/focus-project-history-source-${Date.now()}`)
mkdirSync(directory, { recursive: true })
const sourcePaths = [
  'apps/desktop/src/renderer/src/lib/agent-focus.ts',
  'apps/desktop/src/renderer/src/lib/focus-history-identity.ts',
  'apps/desktop/src/renderer/src/lib/focus-history-timeline.ts',
  'apps/desktop/src/renderer/src/components/RecentFocusTimeline.tsx',
  'apps/desktop/src/renderer/src/styles/focus.css',
  'apps/desktop/src/renderer/src/store.ts'
]
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const binding = () => Object.fromEntries(sourcePaths.map(path => [path, sha(readFileSync(resolve(root, path)))]))
const before = binding()
const phases = []
function run(name, command, options = {}) {
  const result = spawnSync(command[0], command.slice(1), { cwd: root, encoding: 'utf8', env: { ...process.env, ...options.env }, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
  writeFileSync(resolve(directory, `${name}.stdout.log`), result.stdout ?? '')
  writeFileSync(resolve(directory, `${name}.stderr.log`), result.stderr ?? '')
  phases.push({ name, command, exit: result.status, signal: result.signal, error: result.error?.message })
  console.log(`${name}: exit ${result.status}`)
  if (result.error || result.signal || (options.red ? result.status === 0 : result.status !== 0)) throw new Error(`${name} failed its ${options.red ? 'loaded AssertionRED' : 'GREEN'} requirement; original logs retained at ${directory}`)
  return result
}
function tests(name, config, options = {}) {
  const output = resolve(directory, `${name}.json`)
  run(name, ['node', 'node_modules/vitest/vitest.mjs', 'run', '--config', config, '--maxWorkers=1', '--reporter=json', `--outputFile=${output}`], options)
  const report = JSON.parse(readFileSync(output, 'utf8'))
  if (!(report.numTotalTests > 0)) throw new Error(`${name} collected no tests.`)
  if (options.red && !(report.numFailedTests > 0 && report.testResults.some(file => file.assertionResults.some(test => test.failureMessages.some(message => message.includes('AssertionError')))))) throw new Error(`${name} did not produce an actual loaded semantic AssertionError.`)
  return { total: report.numTotalTests, passed: report.numPassedTests, failed: report.numFailedTests }
}
const receipt = { slice, scope: 'Source qualification only; GUI restart and independent visual review remain required.', before, directory: relative(root, directory), phases }
try {
  // The canonical Vitest setup requires fresh normal Core artifacts.
  // Consume that shared producer; this Renderer-only proof must not clear its concurrent dist.
  receipt.owning = tests('owning', 'apps/desktop/scripts/fixtures/focus-project-history/vitest.owning.config.mts')
  receipt.mutations = []
  for (const mutation of ['window-filter', 'current-members', 'historical-owner', 'presence-cost']) {
    const result = tests(`mutation-${mutation}`, 'apps/desktop/scripts/fixtures/focus-project-history/vitest.mutation.config.mts', { red: true, env: { AGENTMUX_FOCUS_HISTORY_MUTATION: mutation } })
    if (result.total !== receipt.owning.total) throw new Error(`${mutation} changed the test population.`)
    receipt.mutations.push({ mutation, ...result })
  }
  receipt.restored = tests('restored', 'apps/desktop/scripts/fixtures/focus-project-history/vitest.owning.config.mts')
  receipt.adjacent = tests('adjacent', 'apps/desktop/scripts/fixtures/focus-project-history/vitest.adjacent.config.mts')
  run('production-types', ['pnpm', '--filter', '@agentmux/desktop', 'typecheck'])
  run('owning-types', ['node', 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'apps/desktop/scripts/fixtures/focus-project-history/tsconfig.owning.json'])
  const callers = {
    observeFocusHistoryIdentity: ['apps/desktop/src/renderer/src/store.ts', 'observeFocusHistoryIdentity(session,'],
    groupFocusTimeline: ['apps/desktop/src/renderer/src/components/RecentFocusTimeline.tsx', 'groupFocusTimeline(contexts,'],
    RecentFocusTimeline: ['apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx', '<RecentFocusTimeline ']
  }
  receipt.callers = Object.fromEntries(Object.entries(callers).map(([symbol, [file, invocation]]) => {
    const content = readFileSync(resolve(root, file), 'utf8'), start = content.indexOf(invocation)
    if (start < 0) throw new Error(`${symbol} has no non-definition production caller.`)
    return [symbol, { file, line: content.slice(0, start).split('\n').length, invocation }]
  }))
  receipt.after = binding()
  for (const path of sourcePaths) if (before[path] !== receipt.after[path]) throw new Error(`${path} changed during qualification; original evidence retained, rerun on a stable own Source slice.`)
  receipt.sourcePass = true
  receipt.taskDone = false
  receipt.pending = ['ordinary private GUI restart with exact delivery binding', 'actual wide/narrow interaction and independent visual review']
  writeFileSync(resolve(directory, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
  console.log(`Source qualification: ${relative(root, resolve(directory, 'receipt.json'))}`)
  if (!args.includes('--source-only')) throw new Error('Source qualified; final GUI/review qualification is still pending. This Task remains active.')
} catch (error) {
  receipt.error = error instanceof Error ? error.message : String(error)
  writeFileSync(resolve(directory, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
  console.error(receipt.error)
  process.exitCode = 1
}
