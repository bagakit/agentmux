import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const repository = fileURLToPath(new URL('../../../', import.meta.url))
const store = resolve(repository, 'apps/desktop/src/renderer/src/store.ts')
const test = resolve(repository, 'apps/desktop/test/startup-snapshot-notice-resolution.test.tsx')
const output = resolve(repository, '.tmp/startup-snapshot-notice-proof', `attempt-${Date.now()}`)
await mkdir(output, { recursive: true })
const green = await readFile(store, 'utf8')
const digest = value => createHash('sha256').update(value).digest('hex')
const bindings = Object.fromEntries(await Promise.all([store, test,
  fileURLToPath(import.meta.url),
  resolve(repository, 'apps/desktop/src/renderer/src/components/TransientErrorNotice.tsx'),
  resolve(repository, 'apps/desktop/src/renderer/src/App.tsx'),
  resolve(repository, 'vitest.config.ts')].map(async path => [relative(repository, path), digest(await readFile(path))])))
await writeFile(resolve(output, 'store.green.ts.txt'), green)
const settlement = `function startupSnapshotConfirmsSessions(snapshot: RuntimeSnapshot, sessionIds: readonly string[]): boolean {
  if (sessionIds.length === 0) return false
  const canonicalById = new Map(snapshot.sessions.map((session) => [session.id, session]))
  return sessionIds.every((id) => {
    const session = canonicalById.get(id)
    return session !== undefined && !(snapshot.runtimeOwnershipWarnings ?? []).includes(session.hostId)
  })
}`
const ownerGuard = 'if (source && state.errorNoticeContext === notice && source.sessionIds.length > 0) {'
const dismissSourceGuard = '      && current.errorNoticeContext?.startupSessionSnapshot === context?.startupSessionSnapshot\n'
for (const block of [settlement, ownerGuard, dismissSourceGuard]) assert.equal(green.split(block).length - 1, 1, 'Product mutation block must exist exactly once')
const variants = [
  { name: 'settlement-disabled', before: settlement,
    after: 'function startupSnapshotConfirmsSessions(snapshot: RuntimeSnapshot, sessionIds: readonly string[]): boolean { return false }' },
  { name: 'later-error-ownership-bypassed', before: ownerGuard, after: 'if (source && source.sessionIds.length > 0) {' },
  { name: 'dismissed-source-dedupe-bypassed', before: dismissSourceGuard, after: '', onlyCombinedCase: true }
]
const results = []
for (const variant of [...variants, { name: 'restored-green' }]) {
  const directory = resolve(output, variant.name); await mkdir(directory)
  const source = variant.before ? green.replace(variant.before, variant.after) : green
  await writeFile(resolve(directory, 'store.loaded.ts.txt'), source)
  if (variant.before) await writeFile(resolve(directory, 'mutation.json'), JSON.stringify(variant, null, 2) + '\n')
  const transformed = resolve(directory, 'transformation.json')
  const config = `import base from ${JSON.stringify(resolve(repository, 'vitest.config.ts'))}
import { defineConfig, mergeConfig } from 'vitest/config'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
const configured = mergeConfig(base, defineConfig({
  root: ${JSON.stringify(repository)},
  plugins: [{ name: 'private-startup-notice-product-mutation', enforce: 'pre', transform(code, id) {
    if (id.split('?')[0] !== ${JSON.stringify(store)}) return
    const sourceSHA256 = createHash('sha256').update(code).digest('hex')
    if (sourceSHA256 !== ${JSON.stringify(digest(green))}) throw new Error('Product source changed while verifying; result is unconfirmed')
    writeFileSync(${JSON.stringify(transformed)}, JSON.stringify({ actualProduct: id, sourceSHA256, loadedSHA256: ${JSON.stringify(digest(source))} }))
    return { code: ${JSON.stringify(source)}, map: null }
  }}],
  test: { maxWorkers: 1 }
}))
// mergeConfig concatenates include arrays. Replace this authority explicitly to keep one owning file.
configured.test.include = [${JSON.stringify(test)}]
export default configured
`
  const configPath = resolve(directory, 'vitest.config.mts'); await writeFile(configPath, config)
  const reportPath = resolve(directory, 'vitest-result.json')
  const args = ['exec', 'vitest', 'run', relative(repository, test), '--config', configPath, '--reporter=json', '--outputFile', reportPath]
  if (variant.onlyCombinedCase) args.push('-t', 'a dismissed startup notice cannot swallow')
  const execution = spawnSync('pnpm', args, { cwd: repository, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 90_000 })
  await writeFile(resolve(directory, 'stdout.log'), execution.stdout ?? '')
  await writeFile(resolve(directory, 'stderr.log'), execution.stderr ?? '')
  assert.ifError(execution.error)
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  assert.deepEqual(report.testResults.map(file => file.name), [test], 'Exactly one owning test file may run')
  const loaded = JSON.parse(await readFile(transformed, 'utf8'))
  assert.equal(loaded.loadedSHA256, digest(source), 'The actual product file must load this variant')
  const assertions = report.testResults.flatMap(file => file.assertionResults)
  const executed = assertions.filter(test => test.status === 'passed' || test.status === 'failed')
  assert.ok(executed.length > 0, 'Owning consumer tests must execute, not merely collect skipped cases')
  const failed = assertions.filter(test => test.status === 'failed')
  if (variant.before) {
    assert.notEqual(execution.status, 0, 'Product mutation must turn owning assertions red')
    assert.ok(failed.length > 0 && failed.some(test => test.failureMessages.some(message => message.includes('AssertionError'))),
      'RED must be a real assertion, never setup/no-tests failure')
  } else {
    assert.equal(execution.status, 0, 'Restoring the same product must restore GREEN')
    assert.equal(failed.length, 0)
  }
  results.push({ name: variant.name, exitCode: execution.status, assertionCount: assertions.length, executedAssertionCount: executed.length,
    failedAssertions: failed.map(test => test.fullName), sourceSHA256: loaded.sourceSHA256,
    loadedSHA256: loaded.loadedSHA256, assertionRed: variant.before ? true : null, restoredGreen: !variant.before })
  console.log(`${variant.name}: ${variant.before ? 'Assertion RED' : 'GREEN'} (${assertions.length} collected)`)
}
// Every run used a private transform; shared source is read-only and must remain byte-identical.
for (const [path, before] of Object.entries(bindings)) {
  assert.equal(digest(await readFile(resolve(repository, path))), before, `Input changed: ${path}`)
}
const callers = (await readFile(resolve(repository, 'apps/desktop/src/renderer/src/App.tsx'), 'utf8'))
assert.ok(/beginRendererStartup\(\s*initialize\s*,/.test(callers), 'Actual App must initialize this Store')
assert.ok(callers.includes('<TransientErrorNotice'), 'Actual App must mount the original notice consumer')
assert.ok(green.includes('if (!snapshotVerified || emptySessionSnapshotWarning) startSessionMembershipResync('), 'Actual initialize must call the owning resync')
assert.equal(green.split('startupSnapshotConfirmsSessions(snapshot, ').length - 1, 2, 'Both adopted initialize and resync facts must use the same notice predicate')
assert.ok(green.includes('sessionMembershipGap) startSessionMembershipResync(event)'), 'Membership events must call the same resync')
await writeFile(resolve(output, 'receipt.json'), JSON.stringify({ schema: 'agentmux.startup-snapshot-notice-mutation-proof.v1',
  passed: true, output, bindings, actualProductCallers: ['App initialize effect', 'App TransientErrorNotice mount',
    'Store initialize -> startSessionMembershipResync', 'Store applyEvent -> startSessionMembershipResync'],
  sharedSourceUnchanged: true, results }, null, 2) + '\n')
console.log(`receipt: ${resolve(output, 'receipt.json')}`)
