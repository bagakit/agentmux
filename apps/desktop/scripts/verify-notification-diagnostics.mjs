import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, statfs, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

const root = resolve(import.meta.dirname, '../../..'), exec = promisify(execFile)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const parent = join(root, '.tmp/notification-diagnostics'); await mkdir(parent, { recursive: true })
const evidence = await mkdtemp(join(parent, 'run-'))
const own = ['apps/desktop/test/notification-diagnostics.test.tsx', 'apps/desktop/test/vitest.notification-diagnostics.config.mts',
  'apps/desktop/test/helpers/mote-diagnostics-cli.ts', 'apps/desktop/scripts/verify-notification-diagnostics.mjs',
  'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/main/notification-observation.ts',
  'apps/desktop/src/renderer/src/components/GlobalSystemNotices.tsx', 'apps/desktop/src/renderer/src/lib/control-api.ts', 'apps/desktop/src/renderer/src/store.ts',
  'apps/desktop/src/renderer/src/lib/notification-observation.ts', 'packages/core/src/client-notifications.ts',
  'packages/core/src/diagnostic-evidence-service.ts', 'packages/core/src/diagnostic-evidence-codec.ts',
  'packages/core/src/agentmux-cli-commands.ts', 'packages/core/src/agentmux-cli-help.ts']
const pin = async paths => Object.fromEntries(await Promise.all(paths.map(async path => [path, digest(await readFile(join(root, path)))])))
const space = await statfs(root)
const receipt = { schema: 'agentmux.notification-diagnostics-qualification.v1', passed: false,
  sourceCommit: (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim(),
  boundary: 'Actual source CLI / unix RPC / registered Desktop Main / Control IPC / committed closed Renderer owner. Electron transport alone is simulated; no user App, Runtime or Run operations.',
  freeDiskBytes: space.bavail * space.bsize, sourceBefore: await pin(own), cases: [], userRuntimeCalls: 0, productionWritten: false }
console.log('notification-diagnostics-evidence=' + relative(root, evidence))
async function run(label, config, changes = {}) {
  const inputs = join(evidence, label + '-inputs.json'), loaded = join(evidence, label + '-loaded.jsonl'), report = join(evidence, label + '.json')
  await writeFile(inputs, JSON.stringify(changes))
  let result
  try {
    const value = await exec(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', config, '--reporter=json', '--outputFile=' + report],
      { cwd: root, timeout: 120000, maxBuffer: 20 * 1024 * 1024, env: { ...process.env,
        AGENTMUX_NOTIFICATION_DIAGNOSTICS_SOURCES: inputs, AGENTMUX_NOTIFICATION_DIAGNOSTICS_LOADED: loaded,
        AGENTMUX_NOTIFICATION_DIAGNOSTICS_RECEIPT: join(evidence, label + '-product.json') } })
    result = { code: 0, signal: null, output: value.stdout + value.stderr }
  } catch (error) { result = { code: error.code, signal: error.signal ?? null, output: (error.stdout ?? '') + (error.stderr ?? '') } }
  await writeFile(join(evidence, label + '.log'), result.output)
  assert.equal(result.signal, null, 'Terminated/timeout fixture cannot certify behavior')
  const parsed = JSON.parse(await readFile(report, 'utf8'))
  const assertions = parsed.testResults.flatMap(file => file.assertionResults).filter(item => !['pending', 'skipped'].includes(item.status))
  assert.ok(assertions.length > 0, 'The actual product assertions must run')
  let loads = []
  if (config.includes('notification-diagnostics')) {
    loads = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
    assert.ok(loads.length > 0, 'Actual production inputs must be loaded')
    for (const path of ['apps/desktop/src/main/ipc.ts', 'apps/desktop/src/main/notification-observation.ts',
      'apps/desktop/src/renderer/src/lib/control-api.ts', 'apps/desktop/src/renderer/src/components/GlobalSystemNotices.tsx',
      'apps/desktop/src/renderer/src/lib/notification-observation.ts', 'packages/core/src/public-rpc-service.ts',
      'packages/core/src/diagnostic-evidence-service.ts', 'packages/core/src/client-notifications.ts'])
      assert.ok(loads.some(row => row.path === path), 'Actual production consumer: ' + path)
    for (const row of loads) {
      const original = await readFile(join(root, row.path))
      assert.equal(row.originalSha256, digest(original), 'Exact original loaded input: ' + row.path)
      assert.equal(row.sha256, digest(changes[row.path] ?? original), 'Exact effective input: ' + row.path)
    }
  }
  return { code: result.code, assertions: assertions.length, passed: assertions.filter(item => item.status === 'passed').length,
    failed: assertions.filter(item => item.status === 'failed' && item.failureMessages.some(message => /AssertionError|expected .* to /su.test(message))).map(item => item.fullName),
    loads, report: relative(evidence, report), log: label + '.log' }
}
async function coreEvidence(rebuild = true) {
  const base = join(root, '.tmp/client-notifications-core')
  let paths = []
  if (process.env.AGENTMUX_NOTIFICATION_CORE_RECEIPT) paths = [resolve(root, process.env.AGENTMUX_NOTIFICATION_CORE_RECEIPT)]
  else { try { paths = (await readdir(base)).map(name => join(base, name, 'receipt.json')) } catch {} }
  for (const path of paths) {
    try {
      const value = JSON.parse(await readFile(path, 'utf8'))
      assert.equal(value.passed, true); assert.equal(value.sourceUnchanged, true)
      assert.ok(Object.keys(value.inputs).length > 0)
      assert.deepEqual(await pin(Object.keys(value.inputs)), value.inputs)
      assert.deepEqual(value.results.map(item => item.mutation), [null, 'control-target-unchecked', 'cli-unread-filter-disconnected'])
      const logs = []
      for (const item of value.results) {
        assert.equal(item.passed, true)
        const text = await readFile(join(resolve(path, '..'), item.log), 'utf8')
        if (item.mutation) {
          assert.notEqual(item.exitCode, 0); assert.ok(text.includes('AssertionError'))
          assert.ok(text.includes('NOTIFICATION_CORE_MUTATION_APPLIED:' + item.mutation))
        } else { assert.equal(item.exitCode, 0); assert.match(text, /5 passed/u) }
        const name = 'core-' + item.log; await writeFile(join(evidence, name), text)
        logs.push({ name, sha256: digest(text) })
      }
      await writeFile(join(evidence, 'reused-core-receipt.json'), JSON.stringify(value, null, 2))
      return { original: relative(root, path), inputs: value.inputs, logs, reused: true }
    } catch {}
  }
  assert.ok(rebuild, 'No valid same-source Core mutation receipt after qualification')
  const outcome = await exec(process.execPath, ['packages/core/scripts/verify-client-notifications.mjs'],
    { cwd: root, timeout: 120000, maxBuffer: 8 * 1024 * 1024 })
  const result = JSON.parse(outcome.stdout.trim().split('\n').at(-1))
  assert.equal(result.passed, true)
  process.env.AGENTMUX_NOTIFICATION_CORE_RECEIPT = result.receipt
  return await coreEvidence(false)
}
const config = 'apps/desktop/test/vitest.notification-diagnostics.config.mts'
try {
  const baseline = await run('candidate', config)
  assert.equal(baseline.code, 0, 'Candidate CLI vertical must pass before mutation'); assert.equal(baseline.passed, baseline.assertions)
  assert.ok(baseline.loads.some(row => row.consumer === 'actual-source-cli' && row.path === 'packages/core/src/agentmux-cli-commands.ts'), 'Child CLI compiled the actual registered commands')
  receipt.baseline = baseline
  receipt.coreMutations = await coreEvidence()
  receipt.coreBaseline = await run('core-baseline', 'packages/core/test/client-notifications.config.mts')
  assert.equal(receipt.coreBaseline.code, 0); assert.equal(receipt.coreBaseline.passed, 5)
  receipt.loadedInputs = await pin([...new Set(baseline.loads.map(row => row.path))])
  const behavior = await run('notification-behavior', 'apps/desktop/test/vitest.notification-center.config.mts')
  assert.equal(behavior.code, 0); assert.equal(behavior.passed, behavior.assertions); receipt.behavior = behavior
  const mutations = [
    { name: 'main-port-disconnected', path: 'apps/desktop/src/main/ipc.ts',
      from: '    clientNotifications: clientNotificationsPort(deliveryAttempts.hostId, (request, signal) => executeControl(request, undefined, signal)),', to: '', expected: 'reads the closed original panel' },
    { name: 'core-reader-disconnected', path: 'packages/core/src/diagnostic-evidence-service.ts',
      from: 'const port = ports.clientNotifications', to: 'const port = undefined', expected: 'reads the closed original panel' },
    { name: 'closed-owner-disconnected', path: 'apps/desktop/src/renderer/src/components/GlobalSystemNotices.tsx',
      from: 'useLayoutEffect(() => registerNotificationReader(buildEntries))',
      to: 'useLayoutEffect(() => open ? registerNotificationReader(buildEntries) : undefined)', expected: 'reads the closed original panel' },
    { name: 'query-acknowledges-original', path: 'apps/desktop/src/renderer/src/lib/notification-observation.ts',
      from: '  const projection = readers.values().next().value!()', to: '  const projection = readers.values().next().value!(); for (const entry of [...projection.current, ...projection.activity]) entry.onRead?.()', expected: 'reads the closed original panel' },
    { name: 'safe-query-exposes-original', path: 'apps/desktop/src/renderer/src/lib/notification-observation.ts',
      from: '    if (request.includeRaw) {', to: '    if (true) {', expected: 'reads the closed original panel' }
  ]
  for (const mutation of mutations) {
    const original = await readFile(join(root, mutation.path), 'utf8')
    assert.equal(original.split(mutation.from).length, 2, 'One actual mutation anchor: ' + mutation.name)
    const changed = original.replace(mutation.from, mutation.to), red = await run(mutation.name, config, { [mutation.path]: changed })
    assert.notEqual(red.code, 0, 'Actual production mutation must fail')
    assert.ok(red.failed.some(name => name.includes(mutation.expected)), 'Corresponding semantic assertion must kill ' + mutation.name)
    assert.ok(red.loads.some(row => row.path === mutation.path && row.sha256 !== row.originalSha256), 'Mutated implementation must actually execute')
    receipt.cases.push({ name: mutation.name, path: mutation.path, red })
    console.log('PASS private mutation: ' + mutation.name)
  }
  receipt.restored = await run('restored', config)
  assert.equal(receipt.restored.code, 0); assert.equal(receipt.restored.passed, baseline.assertions)
  assert.deepEqual(await pin(Object.keys(receipt.loadedInputs)), receipt.loadedInputs, 'Every actually consumed input remains unchanged')
  assert.deepEqual(await pin(Object.keys(receipt.coreMutations.inputs)), receipt.coreMutations.inputs)
  receipt.sourceAfter = await pin(own); assert.deepEqual(receipt.sourceAfter, receipt.sourceBefore)
  receipt.passed = true
} catch (error) {
  receipt.error = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1
  console.error(error.stack)
} finally {
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
