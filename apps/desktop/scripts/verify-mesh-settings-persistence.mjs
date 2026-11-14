import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const output = process.env.MESH_EDIT_VERIFY_EVIDENCE ?? resolve(root, '.local/state/mesh-network-access/mesh-edit-persistence')
const attempt = resolve(output, 'attempt-' + Date.now()); mkdirSync(attempt, { recursive: true })
const hash = path => createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')
const inputs = ['apps/desktop/test/mesh-settings-persistence.test.tsx', 'apps/desktop/test/mesh-settings-persistence.config.mts',
  'apps/desktop/scripts/verify-mesh-settings-persistence.mjs', 'apps/desktop/test/vitest.mote-context.config.mts', 'vitest.config.ts', 'vitest.setup.ts',
  'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/lib/desktop-user-state.ts',
  'apps/desktop/src/renderer/src/lib/workbench-user-storage.ts', 'apps/desktop/src/main/workbench-user-state.ts',
  'apps/desktop/src/renderer/src/lib/mesh-settings-draft.ts', 'apps/desktop/src/renderer/src/components/settings/MeshNetworkSettings.tsx',
  'packages/core/src/durable-write.ts', 'apps/desktop/test/helpers/client-ui-render.tsx',
  'apps/desktop/test/helpers/composer-dom-fixture.tsx', 'apps/desktop/test/helpers/startup-observation-api-fixture.ts']
const sourceHashes = Object.fromEntries(inputs.map(path => [path, hash(path)]))
writeFileSync(resolve(attempt, 'input-hashes.json'), JSON.stringify({ frozenAt: Date.now(), root, sourceHashes }, null, 2) + '\n')
const rows = [], assert = (condition, message) => { if (!condition) throw Error(message) }
for (const [name, mutation] of [['green-before', ''], ['drop-mesh-partialize', 'drop-mesh-partialize'], ['retain-inflight', 'retain-inflight'], ['green-restored', '']]) {
  const directory = resolve(attempt, name); mkdirSync(directory)
  const reportPath = resolve(directory, 'report.json')
  const env = { ...process.env, MESH_EDIT_EVIDENCE: directory }
  delete env.MESH_EDIT_PHASE; delete env.MESH_EDIT_ROOT; delete env.MESH_EDIT_MUTATION
  if (mutation) env.MESH_EDIT_MUTATION = mutation
  const run = spawnSync(process.execPath, [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', resolve(root, 'apps/desktop/test/mesh-settings-persistence.config.mts'), '--reporter=json', '--outputFile', reportPath], { cwd: root, env, encoding: 'utf8' })
  writeFileSync(resolve(directory, 'launcher.log'), run.stdout + run.stderr)
  const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null
  const failed = report?.testResults.flatMap(suite => suite.assertionResults).filter(test => test.status === 'failed') ?? []
  const loaded = ['parent', 'write', 'read'].flatMap(phase => {
    const path = resolve(directory, phase + '-loaded.jsonl')
    return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
  })
  for (const row of loaded) assert(sourceHashes[row.path] === row.originalSHA256, 'Executed original source differs: ' + row.path)
  const mutated = loaded.filter(row => row.mutated)
  const testLoaded = loaded.some(row => row.path === 'apps/desktop/test/mesh-settings-persistence.test.tsx')
  const expectedPhase = mutation === 'drop-mesh-partialize' ? 'write' : 'read'
  const actualMutant = !mutation || mutated.some(row => row.phase === expectedPhase && row.originalSHA256 !== row.servedSHA256)
  const semanticRed = failed.some(test => test.failureMessages.some(message => /AssertionError/.test(message) && !/Test timed out|Failed to resolve import|SyntaxError/.test(message)))
  const cleanup = existsSync(resolve(directory, 'cleanup.json')) ? JSON.parse(readFileSync(resolve(directory, 'cleanup.json'), 'utf8')) : null
  const cleanupPassed = cleanup?.passed === true && cleanup.root.absent && cleanup.processes.length >= 2 && cleanup.processes.every(value => value.exited)
  const green = run.status === 0 && report?.success === true && report.numPassedTests === 1 && report.numFailedTests === 0 && report.numTotalTests === 1
  const result = { name, mutation: mutation || null, exitCode: run.status, actualLoadedRows: loaded.length, testLoaded, actualMutant, semanticRed, cleanupPassed,
    report: relative(root, reportPath), artifacts: relative(root, directory), passed: testLoaded && actualMutant && cleanupPassed && (mutation ? run.status !== 0 && semanticRed : green) }
  if (!mutation && result.passed) {
    const behavior = JSON.parse(readFileSync(resolve(directory, 'behavior.json'), 'utf8'))
    const writer = JSON.parse(readFileSync(resolve(directory, 'writer-ready.json'), 'utf8')), reader = JSON.parse(readFileSync(resolve(directory, 'reader-result.json'), 'utf8'))
    result.passed = behavior.behaviorAssertionsPassed && behavior.writerKilledWithoutExitFlush && behavior.readerIsNewProcess && behavior.nullOperationRetainsUnknown
      && reader.draft.pending.phase === 'unknown' && reader.draft.pending.operationId === writer.operationId && reader.pid !== writer.pid
      && reader.noConfigureReplay && reader.noStop && writer.writer.lastConfirmedWrite.diskDurability === 'confirmed' && cleanup.processes.length === 4
    for (const path of ['apps/desktop/src/main/workbench-user-state.ts', 'apps/desktop/src/renderer/src/store.ts',
      'apps/desktop/src/renderer/src/lib/workbench-user-storage.ts', 'apps/desktop/src/renderer/src/components/settings/MeshNetworkSettings.tsx']) {
      assert(loaded.some(row => row.path === path && row.phase === 'write') && loaded.some(row => row.path === path && row.phase === 'read'), 'Original shipping consumer not executed by both processes: ' + path)
    }
  }
  rows.push(result); console.log(JSON.stringify(result))
  if (!result.passed) break
}
const sourcesUnchanged = Object.entries(sourceHashes).every(([path, sha]) => hash(path) === sha)
const passed = rows.length === 4 && rows.every(row => row.passed) && sourcesUnchanged
const evidenceHashes = {}
for (const row of rows) {
  const directory = resolve(root, row.artifacts)
  for (const name of ['report.json', 'launcher.log', 'parent-loaded.jsonl', 'write-loaded.jsonl', 'read-loaded.jsonl', 'writer-ready.json', 'reader-result.json', 'behavior.json', 'cleanup.json', 'process-logs.txt']) {
    const path = resolve(directory, name)
    if (existsSync(path)) evidenceHashes[relative(root, path)] = hash(path)
  }
}
const receipt = { schema: 'agentmux.mesh-editor-native-persistence.v1', passed, sourcesUnchanged, sourceHashes, rows, evidenceHashes, attempt: relative(root, attempt),
  scope: 'Original Mesh React editor and AppStore initialize/partialize through shipping native WorkbenchUserStateStore file/ACK, precise writer-worker SIGKILL and new reader process. RPC/session observations controlled; no Core execution/actual Native Agent-health claim, no user home or original Session touched.' }
writeFileSync(resolve(attempt, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
writeFileSync(resolve(output, 'latest.json'), JSON.stringify({ passed, receipt: relative(root, resolve(attempt, 'receipt.json')), sha256: hash(resolve(attempt, 'receipt.json')) }, null, 2) + '\n')
if (!passed) process.exitCode = 1
