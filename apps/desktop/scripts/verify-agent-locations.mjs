import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync, execFileSync } from 'node:child_process'

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const directory = resolve(root, '.tmp/agent-locations', 'run-' + randomUUID())
mkdirSync(directory, { recursive: true })
const sourceFiles = ['store.ts', 'components/AgentLocationsButton.tsx', 'components/AgentInformationPreview.tsx', 'components/AgentInformationReader.tsx', 'components/AgentInformationDetails.tsx', 'components/AgentRoster.tsx', 'components/FocusContextRow.tsx', 'components/WorkspaceAgentRow.tsx',
  'components/QuickSwitcher.tsx', 'components/GlobalFocusSurface.tsx', 'components/SurfaceToolDock.tsx', 'lib/desktop-focus-navigation.ts', 'lib/focus-context-identity.ts',
  'lib/quick-switch.ts', 'lib/desktop-spatial-state.ts', 'lib/workbench-navigation-catalog.ts'].map(file => 'apps/desktop/src/renderer/src/' + file)
sourceFiles.push('packages/core/src/spatial-state.ts', 'packages/client-ui/src/patterns/agent-work-location.tsx', 'packages/client-ui/test/agent-work-location.test.tsx', 'apps/desktop/test/agent-locations.test.tsx', 'apps/desktop/test/quick-switch.test.ts', 'apps/desktop/test/quick-switch-demand.test.tsx', 'apps/desktop/test/agent-locations.config.mts', 'apps/desktop/scripts/verify-agent-locations.mjs')
const sha = path => createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')
const original = Object.fromEntries(sourceFiles.map(path => [path, sha(path)]))
const receipt = { sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), schema: 'agentmux.desktop-agent-locations.v1', passed: false, sourceSHA256: original, cases: [],
  boundary: 'Actual Desktop Focus/Space cards → original AgentInformationPreviewHost/Reader footer/Source → existing Store/QuickSwitcher → original Core spatial file owner. Roster/cards retain no persistent count work. Native API transport leaves only; no live user Session or Run.' }
function unchanged() { for (const [file, digest] of Object.entries(original)) if (sha(file) !== digest) throw new Error('Source changed during Agent location verification: ' + file) }
function run(name, mutation, bearing) {
  unchanged()
  const loaded = resolve(directory, name + '-loaded.jsonl'), report = resolve(directory, name + '.json')
  const args = ['exec', 'vitest', 'run', '--config', 'apps/desktop/test/agent-locations.config.mts', '--reporter=json', '--outputFile', report, '--maxWorkers=2']
  if (bearing) args.push('agent-locations.test.tsx', '-t', bearing)
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
    const neutral = summary.testResults.find(file => file.name.endsWith('/client-ui/test/agent-work-location.test.tsx'))
    if (!neutral || neutral.assertionResults.filter(test => test.status === 'passed').length < 2) throw new Error('Independent location pattern consumer was not verified')
    const owned = summary.testResults.find(file => file.name.endsWith('/test/agent-locations.test.tsx'))
    if (result.status !== 0 || !summary.success || summary.numFailedTests || !owned || owned.assertionResults.filter(test => test.status === 'passed').length < 23) throw new Error('Original location consumer gate failed: ' + name)
  }
  unchanged()
  receipt.cases.push({ name, mutation: mutation ?? null, passed: summary.numPassedTests, failed: summary.numFailedTests, bearing: failures.map(test => test.fullName), discovered: summary.numTotalTests, files: summary.testResults.map(file => ({ file: relative(root, file.name), discovered: file.assertionResults.length, passed: file.assertionResults.filter(test => test.status === 'passed').length, failed: file.assertionResults.filter(test => test.status === 'failed').length, skipped: file.assertionResults.filter(test => test.status === 'pending').length })), loaded: relative(root, loaded), report: relative(root, report) })
  writeFileSync(resolve(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
try {
  run('baseline')
  run('first-item', 'first-item', 'Focus explicitly reselects the second Region')
  run('lose-focus', 'lose-focus', 'Focus explicitly reselects the second Region')
  run('drop-membership', 'drop-membership', 'an unknown source stays unknown')
  run('unqualified-details', 'unqualified-details', 'actual details mark a partially unconfirmed Region unknown missing-execution')
  run('label-collisions', 'label-collisions', 'Focus explicitly reselects the second Region')
  run('persistent-card-action', 'persistent-card-action', 'Focus explicitly reselects the second Region')
  run('missing-details-action', 'missing-details-action', 'Focus explicitly reselects the second Region')
  run('admission-bypass', 'admission-bypass', 'held Source refuses a changed host under the same Renderer id')
  run('merge-aliases', 'merge-aliases', 'Space aliases count one physical occurrence')
  run('unknown-as-zero', 'unknown-as-zero', 'an unknown source stays unknown')
  run('drop-runtime', 'drop-runtime', 'Source keeps its original Runtime and request')
  run('drop-zone', 'drop-zone', 'a changed Zone cannot be ignored')
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
