import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const directory = resolve(root, `.tmp/focus-history-retention-${Date.now()}`)
mkdirSync(directory, { recursive: true })
const paths = [
  'apps/desktop/src/renderer/src/lib/agent-focus.ts',
  'apps/desktop/src/renderer/src/lib/focus-history-identity.ts',
  'apps/desktop/src/renderer/src/store.ts',
  'apps/desktop/src/renderer/src/components/RecentFocusTimeline.tsx',
  'apps/desktop/test/focus-history-retention.test.tsx',
  'apps/desktop/scripts/fixtures/focus-project-history/vitest.retention.config.mts',
  'apps/desktop/scripts/fixtures/focus-project-history/vitest.retention-mutation.config.mts'
]
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const binding = () => Object.fromEntries(paths.map(path => [path, sha(readFileSync(resolve(root, path)))]))
const phases = [], receipt = { task: 'T-004', scope: 'One retained Focus history writer/restoration/material budget; no GUI or installation sign-off.', before: binding(), phases }
function run(name, command, options = {}) {
  const result = spawnSync(command[0], command.slice(1), { cwd: root, encoding: 'utf8', env: { ...process.env, ...options.env }, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
  writeFileSync(resolve(directory, `${name}.stdout.log`), result.stdout ?? '')
  writeFileSync(resolve(directory, `${name}.stderr.log`), result.stderr ?? '')
  phases.push({ name, command, exit: result.status, signal: result.signal, error: result.error?.message })
  console.log(`${name}: exit ${result.status}`)
  if (result.error || result.signal || (options.red ? result.status === 0 : result.status !== 0)) throw new Error(`${name} failed; original logs retained at ${directory}`)
  return result
}
function tests(name, config, options = {}) {
  const reportPath = resolve(directory, `${name}.json`)
  run(name, ['node', 'node_modules/vitest/vitest.mjs', 'run', '--config', config, '--maxWorkers=1', '--reporter=json', `--outputFile=${reportPath}`], options)
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  if (!(report.numTotalTests > 0)) throw new Error(`${name} collected no tests.`)
  if (options.red && !(report.numFailedTests > 0 && report.testResults.some(file => file.assertionResults.some(test => test.failureMessages.some(message => message.includes('AssertionError')))))) throw new Error(`${name} has no actual loaded AssertionRED.`)
  return { total: report.numTotalTests, passed: report.numPassedTests, failed: report.numFailedTests }
}
try {
  // The canonical Vitest setup requires fresh normal Core artifacts.
  // Consume that shared producer; this Renderer-only proof must not clear its concurrent dist.
  receipt.owning = tests('owning', 'apps/desktop/scripts/fixtures/focus-project-history/vitest.retention.config.mts', { env: { AGENTMUX_FOCUS_RETENTION_COST_OUTPUT: resolve(directory, 'related-writer-cost.json') } })
  receipt.mutations = []
  for (const mutation of ['writer', 'restore']) {
    const result = tests(`mutation-${mutation}`, 'apps/desktop/scripts/fixtures/focus-project-history/vitest.retention-mutation.config.mts', { red: true, env: { AGENTMUX_FOCUS_RETENTION_MUTATION: mutation } })
    if (result.total !== receipt.owning.total) throw new Error(`${mutation} changed the owning test population.`)
    receipt.mutations.push({ mutation, ...result })
  }
  receipt.restored = tests('restored', 'apps/desktop/scripts/fixtures/focus-project-history/vitest.retention.config.mts')
  run('production-types', ['pnpm', '--filter', '@agentmux/desktop', 'typecheck'])
  run('owning-types', ['node', 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'apps/desktop/scripts/fixtures/focus-project-history/tsconfig.retention.json'])
  receipt.cost = JSON.parse(readFileSync(resolve(directory, 'related-writer-cost.json'), 'utf8'))
  const callers = { focusExecution: ['apps/desktop/src/renderer/src/store.ts', ': focusExecution(state.agentFocus, sessionId, Date.now(), session'], restoreAgentFocus: ['apps/desktop/src/renderer/src/store.ts', 'restoreAgentFocus('] }
  receipt.callers = Object.fromEntries(Object.entries(callers).map(([symbol, [file, invocation]]) => {
    const content = readFileSync(resolve(root, file), 'utf8'), start = content.indexOf(invocation)
    if (start < 0) throw new Error(`${symbol} has zero non-definition production callers.`)
    return [symbol, { file, line: content.slice(0, start).split('\n').length, invocation }]
  }))
  receipt.after = binding()
  for (const path of paths) if (receipt.before[path] !== receipt.after[path]) throw new Error(`${path} changed during qualification; retain original proof and rerun exact stable Source.`)
  receipt.pass = true
} catch (error) {
  receipt.pass = false
  receipt.error = error instanceof Error ? error.message : String(error)
  console.error(receipt.error)
  process.exitCode = 1
} finally {
  writeFileSync(resolve(directory, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
  console.log(`Retention receipt: ${relative(root, resolve(directory, 'receipt.json'))}`)
}
