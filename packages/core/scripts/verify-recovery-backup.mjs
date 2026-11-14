import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), mode = process.argv[2]
const expectedCount = mode === '--restore' ? 22 : 15, testConfig = mode === '--restore' ? 'storage-restore.config.mts' : 'storage-recovery-capture.config.mts'
assert.ok(['--capture', '--restore'].includes(mode), 'Select one exact backup owner gate')
if (process.argv.includes('--verify-existing-proof')) {
  const { readdir } = await import('node:fs/promises')
  const base = join(root, '.local/reliability-fixes/backup')
  let proof
  for (const name of (await readdir(base)).sort().reverse()) {
    try { const value = JSON.parse(await readFile(join(base, name, 'verification.private.json'), 'utf8')); if (value.verdict === 'pass' && value.scope === mode) { proof = value; break } } catch {}
  }
  assert.ok(proof && Object.keys(proof.sourceHashes ?? {}).length > 20 && Object.keys(proof.verificationHashes ?? {}).length >= 8, 'A complete actual-source proof is required')
  const digest = bytes => createHash('sha256').update(bytes).digest('hex')
  for (const [path, hash] of Object.entries({ ...proof.sourceHashes, ...proof.verificationHashes })) assert.equal(digest(await readFile(isAbsolutePath(path) ? path : join(root, path))), hash, 'Loaded bearing bytes changed: ' + path)
  assert.equal(proof.nodeVersion, process.version); console.log('Exact existing ' + mode + ' actual-source proof verified'); process.exit(0)
}
function isAbsolutePath(path) { return path.startsWith('/') }
process.umask(0o077)
const evidence = join(root, '.local/reliability-fixes/backup', new Date().toISOString().replaceAll(/[:.]/gu, '-') + '-' + process.pid)
await mkdir(evidence, { recursive: true, mode: 0o700 })
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_')))
const receipt = { verdict: 'running', scope: mode, startedAt: new Date().toISOString(), phases: [], sourceHashes: {}, verificationHashes: {}, nodeVersion: process.version }
function run(args, overrides = {}) {
  const result = spawnSync(process.execPath, args, { cwd: root, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 180_000, maxBuffer: 4 * 1024 * 1024 })
  assert.equal(result.error, undefined, 'The selected gate must actually finish')
  return result
}
async function tests(label, mutation, pattern) {
  const output = join(evidence, label + '.private.json'), loads = join(evidence, label + '.loads.private.ndjson'), dependencies = join(evidence, label + '.dependencies.private.ndjson'), cold = join(evidence, label + '.cold.private.ndjson')
  for (const path of [loads, dependencies, cold]) await writeFile(path, '', { mode: 0o600 })
  const result = run(['node_modules/vitest/vitest.mjs', 'run', '--config', 'packages/core/test/' + testConfig,
    '--reporter=json', '--outputFile', output, ...(pattern ? ['-t', pattern] : [])], { AGENTMUX_BACKUP_MUTATION: mutation ?? '', AGENTMUX_BACKUP_SOURCE_LOADS: loads, AGENTMUX_TEST_RECEIPT_SOURCE_LOADS: cold, AGENTMUX_BACKUP_DEPENDENCY_LOADS: dependencies, NODE_OPTIONS: [env.NODE_OPTIONS ?? '', '--import=' + pathToFileURL(join(root, 'packages/core/scripts/helpers/recovery-dependency-proof.mjs')).href].join(' ').trim() })
  await writeFile(join(evidence, label + '.log'), result.stdout + result.stderr, { mode: 0o600 })
  const report = JSON.parse(await readFile(output, 'utf8')), failures = report.testResults.flatMap(suite => suite.assertionResults ?? []).filter(test => test.status === 'failed')
  const sources = (await readFile(loads, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  for (const source of sources) {
    assert.ok(source.path.startsWith(join(root, 'packages/core/src/')), 'Actual current owner source only')
    assert.equal(sha(await readFile(source.path)), source.diskSHA256, 'A loaded owner must not change under the proof')
    receipt.sourceHashes[source.path.slice(root.length + 1)] = source.diskSHA256
  }
  for (const path of [dependencies, cold]) for (const row of (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))) {
    if (!row.path.startsWith(root + '/') || row.path.includes('/.vite-temp/')) continue
    assert.equal(sha(await readFile(row.path)), row.sha256, 'An actual cold/dependency source changed under the proof')
    receipt.sourceHashes[row.path.slice(root.length + 1)] = row.sha256
  }
  for (const name of ['agent-session-store.ts', 'storage-recovery.ts', 'storage-recovery-sources.ts']) assert.ok(sources.some(source => source.path === join(root, 'packages/core/src', name)), 'The actual owner must be consumed: ' + name)
  if (mutation) {
    assert.equal(result.status, 1)
    assert.ok(failures.length > 0 && !(report.numRuntimeErrorTestSuites ?? 0), 'A nonempty business assertion kills the mutant')
    assert.ok(failures.every(failure => failure.failureMessages.some(message => /AssertionError|promise resolved|expected /isu.test(message)) &&
      !failure.failureMessages.some(message => /timed out|Failed to resolve|mutation anchor changed/isu.test(message))), 'No setup failure may masquerade as a causal rejection')
    assert.ok(sources.some(source => source.mutation === mutation), 'The bearing source mutation actually executed')
  } else {
    assert.equal(result.status, 0, result.stdout + result.stderr); assert.equal(report.numTotalTests, expectedCount); assert.equal(report.numPassedTests, expectedCount)
    assert.equal(report.numFailedTests, 0); assert.equal(report.success, true)
  }
  receipt.phases.push({ label, mutation: mutation ?? null, exitCode: result.status, passed: report.numPassedTests, failed: report.numFailedTests, output, loads, dependencies, cold })
  console.log(label + ': ' + (mutation ? 'business mutation rejected' : expectedCount + '/' + expectedCount + ' passed'))
}
try {
  await tests('baseline')
  const variants = mode === '--restore' ? [
    ['reorder-original-receipt', 'imports exact offline SQLite'],
    ['restore-trust-preflight', 'keeps historical source grants inert'], ['restore-trust-publication', 'keeps historical source grants inert'],
    ['republish-lost-point', 'keeps a lost publication ACK unknown'], ['spatial-default-after-loss', 'missing primary topology unknown'],
    ['spatial-ignore-newer-point', 'refuses an old topology point'], ['spatial-owner-unenrolled', 'two cold SDK Unix CLI'], ['headless-empty-after-recovery', 'refuses Headless empty initialization'],
    ['read-unrelated-artifacts', 'without reading an unrelated native artifact'], ['same-path-no-sync', 'lost target directory ACK'], ['operation-rebind', 'rejects another generation'],
    ['discard-input-hold', 'restores only prepared held bytes'], ['omit-operation-pin', 'pins an admitted operation'],
    ['skip-input-settlement', 'imports exact offline SQLite'], ['accept-changed-manifest', 'pins an admitted operation'],
    ['restore-permission-bypass', 'serves real typed Unix SDK'], ['operation-without-lock', 'serializes two original owners']
  ] : [
    ['partial-database', 'full original physical database'], ['hold-save-lock', 'ordinary saving continues'],
    ['recopy-unrelated', 'only changed owners'], ['expire-only-member', 'unrelated permanent gap'],
    ['weak-manifest-ack', 'strict manifest directory'], ['accept-corrupt-object', 'never becomes a verified member'],
    ['format-rebind', 'cannot select file-format'], ['native-subject-rebind', 'native backup qualification'],
    ['forget-cohort-frontier', 'Grok retains the whole'], ['scan-application-data', 'scan only the composing owner']
  ]
  for (const [mutation, pattern] of variants) await tests('mutation-' + mutation, mutation, pattern)
  await tests('restored')
  const paths = ['storage-recovery.ts', 'storage-recovery-sources.ts', 'agent-session-store.ts', 'agent-creation-authority.ts',
    'headless-runtime.ts', 'client.ts', 'agent-provider.ts', 'native-creation-admission.ts',
    'providers/grok-history.ts']
  for (const path of paths) receipt.sourceHashes['packages/core/src/' + path] = sha(await readFile(join(root, 'packages/core/src', path)))
  for (const path of ['packages/providers/src/claude/native-catalog.ts', 'packages/providers/src/codex/native-catalog.ts', 'packages/providers/src/grok/native-history.ts']) {
    receipt.sourceHashes[path] = sha(await readFile(join(root, path)))
  }
  const verificationPaths = ['packages/core/scripts/helpers/recovery-dependency-proof.mjs','packages/core/scripts/verify-recovery-backup.mjs', 'packages/core/test/storage-recovery-capture.config.mts', 'packages/core/test/storage-restore.config.mts', 'packages/core/test/storage-recovery-capture.test.ts', 'packages/core/test/storage-restore.test.ts', 'packages/core/test/helpers/prompt-receipt-source-loader.mjs', 'packages/core/test/helpers/storage-recovery-source-cli.ts', 'packages/core/test/helpers/prompt-receipt-reader.mjs', 'packages/core/test/helpers/prompt-receipt-process.ts', 'packages/core/test/helpers/storage-spatial-reader.mjs', process.execPath]
  for (const path of verificationPaths) receipt.verificationHashes[path] = sha(await readFile(isAbsolutePath(path) ? path : join(root, path)))
  receipt.verdict = 'pass'
} catch (error) { receipt.verdict = 'fail'; receipt.failure = error.stack ?? String(error); process.exitCode = 1 }
finally {
  receipt.endedAt = new Date().toISOString()
  const output = join(evidence, 'verification.private.json'); await writeFile(output, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 })
  console.log('evidence: ' + output)
  if (receipt.failure) console.error(receipt.failure)
}
