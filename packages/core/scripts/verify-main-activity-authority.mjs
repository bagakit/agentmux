import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
const root = resolve(import.meta.dirname, '../../..')
const evidence = resolve(root, process.env.AGENTMUX_MAIN_ACTIVITY_EVIDENCE ?? '.local/main-activity-authority')
mkdirSync(evidence, { recursive: true })
const cases = {
  order: 'a new main Hook replaces retained unknown',
  'semantic-stamp': 'a new main Hook replaces retained unknown',
  'child-stamp': 'child-only updates cannot refresh main evidence',
  'native-stamp': 'a real source gap supersedes',
  'cas-phase': 'a stale Core owner rechecks',
  'durable-phase': 'a final native main turn suppresses',
  'transcript-stamp': 'a Provider combining native turn activity',
  'read-stamp': 'a Provider combining native turn activity',
  'main-projection': 'a new main Hook replaces retained unknown'
}
const sourcePaths = ['packages/core/src/client.ts', 'packages/core/src/agent-semantic-state.ts',
  'packages/core/src/agent-status-freshness.ts', 'packages/core/src/types.ts', 'packages/core/src/rpc-native-codec.ts',
  'packages/core/src/agent-session-store.ts', 'packages/core/src/agent-session-recovery/interruption.ts',
  'packages/core/src/agent-session-recovery/continuity-activity.ts', 'packages/core/test/main-activity-authority.test.ts',
  'packages/core/test/main-activity-authority.config.mts', 'packages/core/test/fixtures/main-activity-owner.mjs',
  'packages/core/scripts/verify-main-activity-authority.mjs']
const digest = path => createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')
const originals = Object.fromEntries(sourcePaths.map(path => [path, digest(path)]))
const receipts = []
const run = (name, mutation, target) => {
  const report = resolve(evidence, `${name}.json`), loaded = resolve(evidence, `${name}-loaded.ndjson`)
  rmSync(report, { force: true }); rmSync(loaded, { force: true })
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_') && key !== 'NODE_OPTIONS'))
  if (mutation) { env.AGENTMUX_MAIN_ACTIVITY_MUTATION = mutation; env.AGENTMUX_MAIN_ACTIVITY_MUTATION_RECEIPT = loaded }
  const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'packages/core/test/main-activity-authority.config.mts',
    '--reporter=json', `--outputFile=${report}`, ...(target ? ['-t', target] : [])], { cwd: root, env, encoding: 'utf8', timeout: 180_000 })
  writeFileSync(resolve(evidence, `${name}.log`), result.stdout + result.stderr)
  if (result.error || result.signal) throw new Error(`${name}: runner did not complete`)
  const proof = JSON.parse(readFileSync(report, 'utf8'))
  if (!proof.numTotalTests || !proof.testResults.length) throw new Error(`${name}: empty test proof`)
  if (mutation) {
    const changes = readFileSync(loaded, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    const assertions = proof.testResults.flatMap(file => file.assertionResults).filter(item => item.status === 'failed')
    if (result.status === 0 || !assertions.length || !changes.length || changes.some(item => item.original === item.loaded) ||
        !assertions.some(item => item.failureMessages.some(message => /AssertionError/u.test(message)))) throw new Error(`${name}: production mutation did not produce assertion RED`)
    receipts.push({ name, result: 'assertion-red', sourceMutations: changes, failures: assertions.map(item => item.fullName) })
  } else {
    if (result.status !== 0 || proof.numFailedTests || !proof.numPassedTests) throw new Error(`${name}: candidate is not GREEN`)
    receipts.push({ name, result: 'green', passed: proof.numPassedTests })
  }
}
run('candidate', undefined)
for (const [mutation, target] of Object.entries(cases)) run(mutation, mutation, target)
for (const path of sourcePaths) if (digest(path) !== originals[path]) throw new Error('Production source changed during isolated mutation proof')
run('restored-candidate', undefined)
writeFileSync(resolve(evidence, 'receipt.json'), JSON.stringify({ schema: 'agentmux.main-activity-authority-proof.v1', sourceHashes: originals, receipts, userRuntimeTouched: false }, null, 2) + '\n')
console.log(`Main activity authority: ${Object.keys(cases).length} loaded production mutations RED; exact candidate GREEN.`)
