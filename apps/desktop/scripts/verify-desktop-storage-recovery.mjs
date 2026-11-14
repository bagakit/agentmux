import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim()
const evidence = process.env.AGENTMUX_SOURCE_EXPORT_EVIDENCE ?? join(dirname(common), '.local/reliability-fixes/desktop/source-exports')
mkdirSync(evidence, { recursive: true, mode: 0o700 })
const hash = value => createHash('sha256').update(value).digest('hex')
// The original server forks this exact package asset. Compile only its current
// 1.5KB source, rather than copying dependencies or reusing another tree's dist.
const { transform } = createRequire(join(root, 'packages/core/package.json'))('esbuild')
const workerSource = readFileSync(join(root, 'packages/core/src/control-endpoint-listener-worker.ts'), 'utf8')
const worker = await transform(workerSource, { loader: 'ts', format: 'esm', target: 'node24' })
mkdirSync(join(root, 'packages/core/dist'), { recursive: true })
writeFileSync(join(root, 'packages/core/dist/control-endpoint-listener-worker.js'), worker.code)
const phases = []
function run(label, { mode = 'owner', mutation, test, expected } = {}) {
  const output = join(evidence, label + '.json'), sources = join(evidence, label + '.sources.ndjson')
  writeFileSync(sources, '', { mode: 0o600 })
  const args = [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'apps/desktop/test/vitest.storage-recovery-exports.config.mts',
    '--reporter=json', '--outputFile=' + output, ...(test ? ['-t', test] : [])]
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, AGENTMUX_SOURCE_EXPORT_MODE: mode, AGENTMUX_SOURCE_EXPORT_MUTATION: mutation ?? '', AGENTMUX_SOURCE_EXPORT_LOADED: sources } })
  writeFileSync(join(evidence, label + '.log'), result.stdout + result.stderr, { mode: 0o600 })
  assert.equal(result.error, undefined, label + ': no setup timeout')
  const report = JSON.parse(readFileSync(output, 'utf8'))
  const assertions = report.testResults.flatMap(file => file.assertionResults ?? []).filter(item => ['passed', 'failed'].includes(item.status))
  assert.ok(assertions.length, label + ': nonempty real collection')
  const failed = assertions.filter(item => item.status === 'failed')
  if (mutation) {
    assert.equal(result.status, 1)
    assert.ok(failed.some(item => item.fullName.includes(expected) && item.failureMessages.some(message =>
      /AssertionError|promise resolved .*instead of rejecting/u.test(message) && !/timed out|Missing source-export mutation|Failed to resolve/u.test(message))), label + ': target behavior kills mutation')
  } else { assert.equal(result.status, 0, result.stdout + result.stderr); assert.equal(report.success, true); assert.equal(failed.length, 0) }
  const loaded = readFileSync(sources, 'utf8').trim().split('\n').filter(Boolean).map(value => JSON.parse(value))
  for (const path of ['apps/desktop/src/main/storage-recovery-exports.ts', 'apps/desktop/src/main/workbench-user-state.ts'])
    assert.ok(loaded.some(item => item.absolutePath === join(root, path)), label + ': exact Main owner source')
  if (mode === 'native') for (const path of ['apps/host/src/desktop-storage-recovery.ts', 'packages/core/src/public-rpc-client.ts'])
    assert.ok(loaded.some(item => item.absolutePath === join(root, path) && item.secondProcessSource), label + ': real second-process source ' + path)
  if (mutation) assert.ok(loaded.some(item => item.mutation === mutation), label + ': exact original mutation owner loaded')
  phases.push({ label, mode, mutation: mutation ?? null, passed: assertions.length - failed.length, failed: failed.length, exitCode: result.status })
  console.log(label + ': ' + (mutation ? 'target mutation killed' : 'passed'))
}
run('baseline')
run('native-main-host', { mode: 'native' })
run('copy-in-writer', { mutation: 'copy-in-writer', test: 'held read-only clone', expected: 'held read-only clone' })
run('leave-export', { mutation: 'leave-export', test: 'exports exact original Main members', expected: 'exports exact original Main members' })
run('repeated-copy', { mutation: 'repeated-copy', test: 'Host polling inspects', expected: 'Host polling inspects' })
run('disconnect-main-source', { mode: 'native', mutation: 'disconnect-main-source', expected: 'registered Main source export' })
run('child-gap-unscoped', { mutation: 'child-gap-unscoped', test: 'child owner gap', expected: 'child owner gap' })
run('restored')
run('native-restored', { mode: 'native' })
writeFileSync(join(evidence, 'verification.json'), JSON.stringify({ schema: 'agentmux.desktop-source-exports.v1', passed: true, root, phases,
  controlListenerWorker: { sourceSHA256: hash(workerSource), compiledSHA256: hash(worker.code) },
  storageRecoveryOwnerSHA256: hash(readFileSync(join(root, 'packages/core/src/storage-recovery.ts'))),
  boundary: 'Real registered Main port, original queues and exact filesystem members, real Unix RPC and a second Node Host-adapter/SDK process. No production or user Runtime. Full startHost/Headless integration remains the Root composition gate.' }, null, 2) + '\n', { mode: 0o600 })
