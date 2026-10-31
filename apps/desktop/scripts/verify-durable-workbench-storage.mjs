import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const mode = process.argv[2]
if (!['--owner', '--checkpoint', '--auxiliary', '--restart'].includes(mode)) throw Error('Choose --owner, --checkpoint, --auxiliary or --restart')
const evidence = resolve(root, '.local/durable-workbench-user-state', mode.slice(2))
mkdirSync(evidence, { recursive: true })
const receipts = []
function suite(label, config, { env = {}, file, test, failure } = {}) {
  const report = resolve(evidence, label + '.json')
  const args = ['node_modules/vitest/vitest.mjs', 'run', '--config', config, '--reporter=json', '--outputFile=' + report]
  if (file) args.push(file)
  if (test) args.push('-t', test)
  const result = spawnSync(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  writeFileSync(resolve(evidence, label + '.log'), result.stdout + result.stderr)
  if (result.error) throw result.error
  const data = JSON.parse(readFileSync(report, 'utf8'))
  if (data.numTotalTests < 1 || data.numTotalTestSuites < 1 || !failure && data.numPassedTests < 1) throw Error('Empty verification collection: ' + label)
  const failed = data.testResults.flatMap(item => item.assertionResults ?? []).filter(item => item.status === 'failed')
  if (failure ? result.status === 0 || !failed.some(item => item.fullName.includes(failure)) : result.status !== 0 || !data.success) {
    throw Error('Unexpected verification result: ' + label + '; inspect ' + report)
  }
  receipts.push({ label, tests: data.numTotalTests, passed: data.numPassedTests, failed: data.numFailedTests,
    mutation: failure ?? null, status: result.status })
  process.stdout.write(label + ': ' + (failure ? 'expected behavior failure' : 'passed') + '\n')
}

if (mode === '--owner') {
  suite('native-owner', 'apps/desktop/test/vitest.workbench-user-state.config.mts')
  suite('mutant-diagnostic-gate', 'apps/desktop/test/vitest.workbench-user-state.config.mts', {
    env: { AGENTMUX_USER_OWNER_MUTATION: 'await-diagnostic' }, test: 'stalled historical diagnostic', failure: 'stalled historical diagnostic' })
  suite('native-consumers', 'apps/desktop/test/vitest.workbench-user-storage.config.mts')
  suite('native-ipc', 'apps/desktop/test/vitest.workbench-user-ipc.config.mts')
  suite('batch-regression', 'apps/desktop/test/vitest.draft-persistence.config.mts')
  suite('public-save-receipts', 'apps/desktop/test/vitest.storage-receipts.config.mts')
  suite('mutant-late-ack', 'apps/desktop/test/vitest.workbench-user-storage.config.mts', {
    env: { AGENTMUX_USER_STORAGE_MUTATION: 'drop-newer-input' }, file: 'apps/desktop/test/workbench-user-storage.test.ts',
    test: 'late native write acknowledgement', failure: 'late native write acknowledgement' })
  suite('mutant-native-consumer', 'apps/desktop/test/vitest.workbench-user-storage.config.mts', {
    env: { AGENTMUX_USER_STORAGE_MUTATION: 'disconnect-native' }, file: 'apps/desktop/test/workbench-user-state-consumer.test.ts',
    test: 'actual Desktop hydration', failure: 'actual Desktop hydration' })
  suite('mutant-import-race', 'apps/desktop/test/vitest.workbench-user-storage.config.mts', {
    env: { AGENTMUX_USER_STORAGE_MUTATION: 'bypass-atomic-import' }, file: 'apps/desktop/test/workbench-user-storage.test.ts',
    test: 'native queue winner', failure: 'native queue winner' })
  suite('mutant-clear-order', 'apps/desktop/test/vitest.workbench-user-storage.config.mts', {
    env: { AGENTMUX_USER_STORAGE_MUTATION: 'drop-clear-barrier' }, file: 'apps/desktop/test/workbench-user-storage.test.ts',
    test: 'clearing waits|overlapping clears', failure: 'clearing waits' })
  suite('mutant-public-producer', 'apps/desktop/test/vitest.workbench-user-storage.config.mts', {
    env: { AGENTMUX_USER_STORAGE_MUTATION: 'omit-client-save' }, file: 'apps/desktop/test/workbench-user-state-consumer.test.ts',
    test: 'public spatial mutation', failure: 'public spatial mutation' })
} else if (mode === '--checkpoint') {
  const config = 'apps/desktop/test/vitest.spatial-workbench-checkpoint.config.mts'
  suite('spatial-checkpoint', config)
  const failures = { 'drop-checkpoint-capture': 'captures', 'drop-catch-observer': 'initialization fails',
    'cross-owner-dispose': 'disposer', 'omit-owner-fence': 'owner replacement' }
  for (const [mutation, failure] of Object.entries(failures)) suite('mutant-' + mutation, config, {
    env: { AGENTMUX_SPATIAL_CHECKPOINT_MUTATION: mutation }, file: 'apps/desktop/test/spatial-workbench-checkpoint.test.ts', failure })
} else if (mode === '--auxiliary') {
  const config = 'apps/desktop/test/vitest.workbench-auxiliary.config.mts'
  suite('native-auxiliary', config)
  suite('independent-document-review', 'apps/desktop/test/vitest.workbench-user-document-review.config.mts')
  const cases = {
    'disconnect-native': 'actual root and all five',
    'ignore-native-ack': 'native missing acknowledgement',
    'omit-action-ack': 'actual schedule controller waits',
    'omit-avatar-ack': 'actual avatar keep awaits',
    'omit-patrol-ack': 'actual global patrol waits',
    'omit-note-read': 'delayed Launcher read cannot replace or dispatch an original Note',
    'omit-schedule-read': 'delayed Launcher read cannot overwrite or dispatch the original schedule',
    'omit-progress-read': 'delayed Launcher read restores progress identity',
    'unknown-is-absent': 'unknown fragment read never becomes absence',
    'drop-fragments': 'main projection writes preserve all private fragments'
  }
  for (const [mutation, failure] of Object.entries(cases)) suite('mutant-' + mutation, config, {
    env: { AGENTMUX_AUXILIARY_MUTATION: mutation }, test: failure, failure })
} else {
  const config = 'apps/desktop/test/vitest.workbench-storage-observation.config.mts'
  suite('native-save-observation', config, { test: 'storage inspection|old-producer|actual installation keeps required storage strict' })
  const cases = {
    'bypass-installer-storage': 'does not let missing or externally replaced',
    'trust-equal-spatial': 'equal current graph aligned',
    'hide-main-metadata': 'exposes safe owner receipts',
    'hide-renderer-pending': 'reports pending current user input'
  }
  for (const [mutation, failure] of Object.entries(cases)) suite('mutant-' + mutation, config, {
    env: { AGENTMUX_STORAGE_OBSERVATION_MUTATION: mutation }, test: failure, failure })
  const { verifyWorkbenchRestart } = await import('./verify-workbench-restart.mjs')
  receipts.push(await verifyWorkbenchRestart({ root, evidence }))
}
writeFileSync(resolve(evidence, 'verification.json'), JSON.stringify({ mode, receipts }, null, 2) + '\n')
