import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..'), require = createRequire(join(root, 'package.json'))
const hash = value => createHash('sha256').update(value).digest('hex')
const directory = join(root, '.local/state/runtime-notification-provenance'); await mkdir(directory, { recursive: true })
const attempt = await mkdtemp(join(directory, 'attempt-'))
const owners = ['packages/core/src/client.ts', 'packages/core/src/types.ts', 'packages/core/src/lifecycle-diagnostic.ts', 'packages/core/src/renderer-performance.ts',
  'packages/core/src/agent-session-recovery/lifecycle.ts', 'packages/core/src/hosted-client.ts', 'packages/core/src/hosted-runtime-service.ts',
  'packages/core/src/public-rpc-server.ts', 'packages/core/src/public-rpc-client.ts',
  'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/lib/session-state.ts',
  'apps/desktop/src/renderer/src/components/GlobalSystemNotices.tsx', 'apps/desktop/src/main/ipc.ts',
  'apps/desktop/src/main/notification-observation.ts', 'apps/desktop/src/renderer/src/lib/control-api.ts',
  'apps/desktop/src/renderer/src/lib/notification-observation.ts', 'packages/core/src/client-notifications.ts',
  'apps/desktop/test/notification-diagnostics.test.tsx', 'apps/desktop/test/runtime-notification-provenance.config.mts',
  'apps/desktop/test/vitest.notification-diagnostics.config.mts', 'apps/desktop/test/helpers/mote-diagnostics-cli.ts',
  'packages/identity/scripts/build.mjs', 'packages/identity/src/runtime-entry.ts',
  'apps/desktop/scripts/verify-runtime-notification-provenance.mjs']
const original = new Map(await Promise.all(owners.map(async file => [file, await readFile(join(root, file), 'utf8')])))
const sourceSHA256 = Object.fromEntries([...original].map(([file, source]) => [file, hash(source)]))
const receipt = { schema: 'agentmux.runtime-notification-provenance.v1', passed: false, userRuntimeTouched: false,
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), sourceSHA256,
  boundary: 'Private real ctxmux/Run; original Core prepared reservation → Unix public RPC/Hosted event → actual Renderer notification owner → registered Main/Control IPC → actual diagnostic CLI. Electron transport only is a fixture.',
  results: [], sourceStable: false }
const save = () => writeFile(join(attempt, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
function mutation(file, from, to, count = 1) {
  const source = original.get(file); assert.ok(source)
  assert.equal(source.split(from).length - 1, count, 'Exact actual source anchor: ' + file)
  return { [file]: source.replaceAll(from, to) }
}
const variants = [
  ['candidate', {}],
  ['core-original-producer-withdrawn', mutation('packages/core/src/client.ts',
    'lifecycle: lifecycleDiagnosticSource(reservation), failure: deliveryFailure(error),', 'failure: deliveryFailure(error),', 3)],
  ['core-confirmation-withdrawn', mutation('packages/core/src/client.ts',
    '    this.publisher.publish(lifecycleObserved(reservation, ready.run))', '    /* Original confirmation was not delivered. */')],
  ['consumer-original-producer-withdrawn', mutation('apps/desktop/src/renderer/src/store.ts',
    '...(diagnostic.runtimeOperation ? { runtimeOperation: diagnostic.runtimeOperation } : {}),', '')],
  ['damaged-auxiliary-identity-admitted', mutation('packages/core/src/hosted-client.ts',
    'try { parseLifecycleDiagnosticEvent(received.event) }', 'try { /* Damaged auxiliary identity was admitted. */ }')],
  ['projection-replay-counted-twice', mutation('apps/desktop/src/renderer/src/store.ts',
    'if (reportedRuntimeOperations.has(event)) return', '/* Projection replay incorrectly counts as a new observation. */')],
  ['unknown-failures-merged', mutation('apps/desktop/src/renderer/src/store.ts',
    "event: { source: 'operation', key: mintObjectId() }", "event: { source: 'operation', key: 'same-unknown' }")],
  ['other-operation-settles-original', mutation('apps/desktop/src/renderer/src/store.ts',
    'runtimeOperationOwner(original) !== resolved', 'false')]
]
console.log('runtime-notification-evidence=' + relative(root, attempt))
try {
  // This public package deliberately generates the Provider string asset; stage
  // its exact current owner once, like the existing Source listener worker.
  execFileSync('pnpm', ['--filter', '@agentmux/identity', 'build'], { cwd: root, stdio: 'pipe' })
  receipt.generatedIdentityAsset = hash(await readFile(join(root, 'packages/identity/dist/runtime-source.js')))
  for (const [name, changes] of process.argv.includes('--mutations') ? variants : variants.slice(0, 1)) {
    const sources = join(attempt, name + '-sources.json'), loaded = join(attempt, name + '-loaded.jsonl')
    const report = join(attempt, name + '.json'), product = join(attempt, name + '-product.json')
    await writeFile(sources, JSON.stringify(changes))
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [require.resolve('vitest/vitest.mjs'), 'run', '--config',
        'apps/desktop/test/runtime-notification-provenance.config.mts', '--reporter=json', '--outputFile=' + report],
      { cwd: root, env: { ...process.env, AGENTMUX_NOTIFICATION_DIAGNOSTICS_SOURCES: sources,
        AGENTMUX_NOTIFICATION_DIAGNOSTICS_LOADED: loaded, AGENTMUX_NOTIFICATION_DIAGNOSTICS_RECEIPT: product }, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''; child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
      child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal, output }))
    })
    await writeFile(join(attempt, name + '.log'), result.output)
    const parsed = JSON.parse(await readFile(report, 'utf8'))
    const assertions = parsed.testResults.flatMap(file => file.assertionResults).filter(test => !['pending', 'skipped', 'todo'].includes(test.status))
    assert.equal(assertions.length, 1, 'Exact nonempty original vertical slice inventory')
    assert.ok(assertions[0].fullName.includes('runtime lifecycle provenance:'))
    const failures = assertions.filter(test => test.status === 'failed')
    const semanticRed = result.code === 1 && result.signal === null && failures.length === 1 &&
      failures.every(test => !test.failureMessages.some(message => /All private owners must close|timed out/iu.test(message)) &&
        test.failureMessages.some(message => /AssertionError|expected .* to /su.test(message)))
    const loads = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
    assert.ok(loads.length > 0, 'Actual source load closure is nonempty')
    for (const row of loads) {
      const source = await readFile(join(root, row.path), 'utf8')
      assert.equal(row.originalSha256, hash(source), 'Exact original loaded input: ' + row.path)
      assert.equal(row.sha256, hash(changes[row.path] ?? source), 'Exact effective loaded input: ' + row.path)
    }
    receipt.results.push({ name, code: result.code, signal: result.signal, assertions: assertions.length, semanticRed,
      loaded: Object.fromEntries(loads.map(row => [row.path, row.sha256])), failures: failures.map(test => ({ name: test.fullName, messages: test.failureMessages })) })
    await save()
    if (name === 'candidate') {
      assert.equal(result.code, 0, 'Original Native/Core/notification/CLI consumer failed: ' + report)
      const facts = JSON.parse(await readFile(product, 'utf8'))
      assert.equal(facts.originalCoreDiagnostics, 100); assert.ok(facts.realNative.instanceId && facts.realNative.healthyRun && facts.realNative.healthyPid)
      assert.equal(facts.cli, 0); assert.equal(facts.userRuntimeTouched, false)
      receipt.product = facts
      for (const file of owners.filter(file => !file.includes('/test/') && !file.includes('/scripts/') && !file.startsWith('packages/identity/') && !file.endsWith('/types.ts'))) {
        assert.ok(loads.some(row => row.path === file), 'Actual product consumer/source was consumed: ' + file)
      }
      assert.ok(loads.some(row => row.consumer === 'actual-source-cli'), 'Actual source CLI was invoked')
    } else assert.ok(semanticRed, 'Mutation must fail a behavioral assertion, never collection/timeout/cleanup only: ' + name)
  }
  for (const [file, digest] of Object.entries(sourceSHA256)) assert.equal(hash(await readFile(join(root, file))), digest, 'Source stable: ' + file)
  assert.equal(hash(await readFile(join(root, 'packages/identity/dist/runtime-source.js'))), receipt.generatedIdentityAsset)
  receipt.sourceStable = true; receipt.passed = true
} finally { await save() }
console.log(JSON.stringify({ passed: true, receipt: join(attempt, 'receipt.json') }))
