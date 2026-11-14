import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const directory = resolve(root, '.tmp/agent-locations', 'run-' + randomUUID())
mkdirSync(directory, { recursive: true })
const sourceFiles = ['store.ts', 'components/AgentLocationsButton.tsx', 'components/AgentRoster.tsx', 'components/FocusContextRow.tsx', 'components/WorkspaceAgentRow.tsx',
  'components/QuickSwitcher.tsx', 'components/GlobalFocusSurface.tsx', 'components/SurfaceToolDock.tsx', 'lib/desktop-focus-navigation.ts', 'lib/focus-context-identity.ts',
  'lib/quick-switch.ts', 'lib/desktop-spatial-state.ts', 'lib/workbench-navigation-catalog.ts'].map(file => 'apps/desktop/src/renderer/src/' + file)
sourceFiles.push('packages/core/src/spatial-state.ts', 'apps/desktop/test/agent-locations.test.tsx', 'apps/desktop/test/quick-switch.test.ts', 'apps/desktop/test/quick-switch-demand.test.tsx', 'apps/desktop/test/agent-locations.config.mts', 'apps/desktop/scripts/verify-agent-locations.mjs')
const sha = path => createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')
const original = Object.fromEntries(sourceFiles.map(path => [path, sha(path)]))
const receipt = { schema: 'agentmux.desktop-agent-locations.v1', passed: false, sourceSHA256: original, cases: [],
  boundary: 'Actual Desktop Roster/GlobalFocus/Space cards → existing Store/QuickSwitcher → original Core spatial file owner; native API transport leaves only. No live user Session or Run.' }
function unchanged() { for (const [file, digest] of Object.entries(original)) if (sha(file) !== digest) throw new Error('Source changed during Agent location verification: ' + file) }
function run(name, mutation, bearing) {
  unchanged()
  const loaded = resolve(directory, name + '-loaded.jsonl'), report = resolve(directory, name + '.json')
  const args = ['exec', 'vitest', 'run', '--config', 'apps/desktop/test/agent-locations.config.mts', '--reporter=json', '--outputFile', report, '--maxWorkers=2']
  if (bearing) args.push('test/agent-locations.test.tsx', '-t', bearing)
  const result = spawnSync('pnpm', args, { cwd: root, env: { ...process.env, VITEST_MAX_THREADS: '2', VITEST_MAX_FORKS: '2', AGENT_LOCATIONS_LOADED: loaded,
    ...(mutation ? { AGENT_LOCATIONS_MUTANT: mutation } : { AGENT_LOCATIONS_MUTANT: '' }) }, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  writeFileSync(resolve(directory, name + '.log'), (result.stdout ?? '') + (result.stderr ?? ''))
  const summary = JSON.parse(readFileSync(report, 'utf8')), proofs = readFileSync(loaded, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  for (const file of sourceFiles.filter(file => !file.includes('/test/') && !file.includes('/scripts/'))) {
    if (!proofs.some(proof => proof.file === file && proof.originalSHA256 === original[file])) throw new Error('Original owner was not evaluated: ' + file)
  }
  const failures = summary.testResults.flatMap(file => file.assertionResults.filter(test => test.status === 'failed'))
  if (mutation) {
    if (result.status === 0 || summary.numFailedTests !== 1 || failures.length !== 1 || !failures[0].fullName.includes(bearing) ||
      !failures[0].failureMessages.some(message => message.includes('AssertionError'))) throw new Error('Mutation did not fail its original behavior assertion: ' + name)
    if (!proofs.some(proof => proof.mutated && proof.originalSHA256 !== proof.loadedSHA256)) throw new Error('Mutated navigation owner was not evaluated: ' + name)
  } else {
    const owned = summary.testResults.find(file => file.name.endsWith('/test/agent-locations.test.tsx'))
    if (result.status !== 0 || !summary.success || summary.numFailedTests || !owned || owned.assertionResults.filter(test => test.status === 'passed').length < 15) throw new Error('Original location consumer gate failed: ' + name)
  }
  unchanged()
  receipt.cases.push({ name, mutation: mutation ?? null, passed: summary.numPassedTests, failed: summary.numFailedTests, bearing: failures.map(test => test.fullName), loaded: relative(root, loaded), report: relative(root, report) })
  writeFileSync(resolve(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
try {
  run('baseline')
  run('first-item', 'first-item', 'Focus explicitly reselects the second Region')
  run('lose-focus', 'lose-focus', 'Focus explicitly reselects the second Region')
  run('drop-membership', 'drop-membership', 'an unknown source stays unknown')
  run('unqualified-roster', 'unqualified-roster', 'actual Roster marks a partially unconfirmed Region unknown missing-execution')
  run('label-collisions', 'label-collisions', 'Focus explicitly reselects the second Region')
  run('restored')
  receipt.passed = true
  writeFileSync(resolve(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  process.stdout.write(JSON.stringify({ passed: true, receipt: relative(root, resolve(directory, 'receipt.json')) }) + '\n')
} catch (error) {
  receipt.error = String(error)
  writeFileSync(resolve(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  process.stderr.write(JSON.stringify({ passed: false, error: String(error), receipt: relative(root, resolve(directory, 'receipt.json')) }) + '\n')
  process.exitCode = 1
}
