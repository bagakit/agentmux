import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '../../..')
const diagnostics = process.argv.includes('--diagnostics')
const recovery = process.argv.includes('--recovery') || diagnostics
const output = resolve(process.argv.slice(2).find(argument => !['--recovery', '--diagnostics'].includes(argument)) ?? resolve(root,
  diagnostics ? '.tmp/runtime-endpoint-diagnostic-mutations' : recovery ? '.tmp/remote-runtime-recovery-mutations' : '.tmp/remote-runtime-renderer-mutations', ("run-" + (globalThis.crypto.randomUUID()) + "")))
const paths = {
  state: 'apps/desktop/src/renderer/src/lib/session-state.ts',
  store: 'apps/desktop/src/renderer/src/store.ts',
  notices: 'apps/desktop/src/renderer/src/components/GlobalSystemNotices.tsx',
  hosts: 'apps/desktop/src/renderer/src/components/settings/HostSettingsPane.tsx',
  ...(diagnostics ? { controller: 'apps/desktop/src/main/runtime-controller.ts', client: 'packages/core/dist/public-runtime-client.js' } : {})
}
const test = resolve(root, recovery ? 'apps/desktop/test/remote-runtime-recovery.integration.test.tsx' : 'apps/desktop/test/runtime-endpoint-binding.integration.test.tsx')
const digest = value => createHash('sha256').update(value).digest('hex')
const sources = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, path]) => [key, await readFile(resolve(root, path), 'utf8')])))
const inputs = Object.fromEntries(Object.entries(paths).map(([key, path]) => [path, digest(sources[key])]))
inputs[relative(root, test)] = digest(await readFile(test))
if (diagnostics) for (const path of ['packages/core/src/public-runtime-client.ts', 'packages/core/src/types.ts']) inputs[path] = digest(await readFile(resolve(root, path)))
await mkdir(output, { recursive: true })
let lostBlock
if (diagnostics) {
  const start = sources.client.indexOf('    lost(epoch, error) {')
  const end = sources.client.indexOf('        this.reconnecting = true;', start)
  assert.ok(start >= 0 && end > start, 'Actual compiled endpoint-loss block is nonempty')
  lostBlock = sources.client.slice(start, end)
  assert.ok(lostBlock.includes('diagnostic:') && lostBlock.includes("type: 'connection-state'"))
}
const lostPrefix = `    lost(epoch, error) {
        if (epoch !== this.epoch || this.closed || this.reconnecting) return;
        this.connected = false;
        this.publisher.publish({ type: 'connection-state', state: 'lost', evidence: { source: 'run-process', observedAt: Date.now() } });
`
const variants = [
  ...(diagnostics ? [{ name: 'baseline-green' }] : []),
  { name: 'unavailable-owner-guard-removed', key: 'state',
    before: `export function runtimeSnapshotHostUnavailable(snapshot: RuntimeSnapshot, hostId: string): boolean {\n  return (snapshot.runtimeEndpointWarnings ?? []).some((warning) => warning.hostId === hostId && warning.availability !== 'connected')\n}`,
    after: `export function runtimeSnapshotHostUnavailable(snapshot: RuntimeSnapshot, hostId: string): boolean { return false }` },
  { name: 'terminal-owner-block-removed', key: 'state',
    before: `    const ownerUnconfirmed = previous ? runtimeSnapshotHostUnavailable(snapshot, previous.hostId)\n      : (snapshot.runtimeEndpointWarnings ?? []).some(warning => warning.availability !== 'connected')`,
    after: `    const ownerUnconfirmed = false` },
  { name: 'endpoint-event-consumer-removed', key: 'store',
    before: `  if (event.endpointWarning === undefined) return warnings\n  const retained = (warnings ?? []).filter((warning) => warning.hostId !== event.hostId)\n  return event.endpointWarning === null ? retained : [...retained, event.endpointWarning]`,
    after: `  return warnings` },
  { name: 'restored-resync-caller-removed', key: 'store',
    before: `      startSessionMembershipResync(event, { recoverSavedAgents: true, restoredHostId: event.hostId })`,
    after: `      // Mutant: the real restored consumer fails to obtain fresh authority.` },
  { name: 'uncertain-mutation-guard-removed', key: 'store',
    before: `if (!explicitAttempt && entry.promptCondition !== null)`,
    after: `if (false)` },
  { name: 'mounted-notice-owner-emptied', key: 'notices',
    before: sources.notices.slice(sources.notices.indexOf('  const endpoints: ServiceNoticeItem[] ='), sources.notices.indexOf('  const endpointInbox =')),
    after: `  const endpoints: ServiceNoticeItem[] = []\n` },
  { name: 'runtime-binding-made-editable', key: 'hosts',
    before: `value={host.runtimeId ?? ''} readOnly`, after: `value={host.runtimeId ?? ''}` },
  { name: 'connected-notice-blocks-healthy-input', key: 'store',
    before: `if (state.runtimeEndpointWarnings?.some((warning) => warning.hostId === sessionHostId && warning.availability !== 'connected')) return`,
    after: `if (state.runtimeEndpointWarnings?.some((warning) => warning.hostId === sessionHostId)) return` },
  { name: 'unverified-display-projection-removed', key: 'state',
    before: sources.state.slice(sources.state.indexOf('  const unavailable = new Map('), sources.state.indexOf('\nexport function reduceAgentMembershipSnapshot')),
    after: `  return sessions\n}\n` },
  { name: 'restored-during-read-does-not-recut', key: 'store',
    before: `            membershipGap ||= pending.event.event.type === 'connection-state' && pending.event.event.state === 'restored'`,
    after: `            // Mutant: no later complete cut after reconnect.` },
  ...(diagnostics ? [
    { name: 'transport-cause-not-attributed', key: 'client', before: lostBlock, after: lostPrefix },
    { name: 'transport-error-duplicates-agent-error', key: 'client', before: lostBlock,
      after: lostBlock + `        if (error instanceof Error) this.publisher.publish({ type: 'agent-error',
          code: error instanceof AgentMuxError ? error.code : 'RUNTIME_UNAVAILABLE', message: error.message,
          evidence: { source: 'run-process', observedAt: Date.now() } });\n` },
    { name: 'main-discards-typed-transport-cause', key: 'controller',
      before: `          event.diagnostic ? new AgentMuxError(event.diagnostic.message, event.diagnostic.code) :\n`, after: `` },
    { name: 'native-agent-diagnostic-removed', key: 'state',
      before: `  if (core.type !== 'agent-error') return null`, after: `  return null` }
  ] : []),
  { name: 'restored-green' }
].filter(variant => diagnostics ? ['baseline-green', 'transport-cause-not-attributed', 'transport-error-duplicates-agent-error',
  'main-discards-typed-transport-cause', 'native-agent-diagnostic-removed', 'restored-green'].includes(variant.name)
  : !recovery || ['restored-resync-caller-removed', 'uncertain-mutation-guard-removed', 'restored-green'].includes(variant.name))
assert.ok(sources.notices.indexOf('  const endpoints: ServiceNoticeItem[] =') >= 0)
assert.ok(sources.notices.indexOf('  const endpointInbox =') > sources.notices.indexOf('  const endpoints: ServiceNoticeItem[] ='))
assert.ok(sources.state.indexOf('  const unavailable = new Map(') >= 0)
assert.ok(sources.state.indexOf('\nexport function reduceAgentMembershipSnapshot') > sources.state.indexOf('  const unavailable = new Map('))
const results = []
for (const variant of variants) {
  const directory = resolve(output, variant.name)
  await mkdir(directory)
  let consumed = variant.key ? sources[variant.key] : null
  if (variant.key) {
    assert.ok(variant.before.trim().length > 0, 'A block mutation must have a nonempty source anchor')
    assert.equal(consumed.split(variant.before).length - 1, 1, 'Exactly one actual product mutation block')
    consumed = consumed.replace(variant.before, variant.after)
    await writeFile(resolve(directory, 'consumed-product.txt'), consumed)
    await writeFile(resolve(directory, 'mutation.json'), JSON.stringify(variant, null, 2) + '\n')
  }
  const productPath = variant.key ? resolve(root, paths[variant.key]) : null
  // Vite blanks only the compiler's source-map directive before pre-transform hooks. Both
  // accepted inputs contain exactly the bound product code; arbitrary transformations fail.
  const acceptedInputHashes = variant.key ? [...new Set([digest(sources[variant.key]),
    digest(sources[variant.key].replace(/^\/\/# sourceMappingURL=[^\r\n]*$/gm, line => ' '.repeat(line.length)))])] : []
  const loadedPath = resolve(directory, 'loaded.json')
  const configPath = resolve(directory, 'vitest.config.mts')
  const config = `import base from ${JSON.stringify(resolve(root, 'vitest.config.ts'))}
import { defineConfig } from 'vitest/config'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
export default defineConfig({ ...base, root: ${JSON.stringify(root)},
  plugins: [{ name: 'private-remote-renderer-block-mutation', enforce: 'pre', transform(code, id) {
    if (id.split('?')[0] !== ${JSON.stringify(productPath)}) return
    const sourceSHA256 = createHash('sha256').update(code).digest('hex')
    if (!${JSON.stringify(acceptedInputHashes)}.includes(sourceSHA256)) throw Error('Product changed concurrently; proof unconfirmed')
    writeFileSync(${JSON.stringify(loadedPath)}, JSON.stringify({ product: id, sourceSHA256: ${JSON.stringify(variant.key ? digest(sources[variant.key]) : null)}, viteInputSHA256: sourceSHA256, consumedSHA256: ${JSON.stringify(consumed ? digest(consumed) : null)} }))
    return { code: ${JSON.stringify(consumed)}, map: null }
  }}],
  test: { ...base.test, ${diagnostics ? "server: { deps: { inline: ['@agentmux/core'] } }," : ''} include: [${JSON.stringify(test)}], passWithNoTests: false, fileParallelism: false, maxWorkers: 1 }
})\n`
  await writeFile(configPath, config)
  const reportPath = resolve(directory, 'tests.json')
  const execution = spawnSync(process.execPath, [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', configPath, '--reporter=json', '--outputFile', reportPath],
    { cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 })
  await writeFile(resolve(directory, 'stdout.log'), execution.stdout ?? '')
  await writeFile(resolve(directory, 'stderr.log'), execution.stderr ?? '')
  assert.ifError(execution.error)
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  assert.deepEqual(report.testResults.map(file => file.name), [test])
  const executed = report.testResults.flatMap(file => file.assertionResults).filter(item => ['passed', 'failed'].includes(item.status))
  assert.equal(executed.length, recovery ? 2 : 10, 'All owning behavior cases execute; no empty/skipped collection')
  const failed = executed.filter(item => item.status === 'failed')
  if (variant.key) {
    const loaded = JSON.parse(await readFile(loadedPath, 'utf8'))
    assert.equal(loaded.consumedSHA256, digest(consumed))
    assert.notEqual(execution.status, 0)
    assert.ok(failed.some(item => item.failureMessages.some(message => message.includes('AssertionError'))), 'Mutation must cause behavior assertion RED, not import/setup failure')
  } else {
    assert.equal(execution.status, 0)
    assert.equal(failed.length, 0)
  }
  results.push({ name: variant.name, exitCode: execution.status, executed: executed.length, failed: failed.map(item => item.fullName), assertionRed: !!variant.key })
  console.log(`${variant.name}: ${variant.key ? 'assertion RED' : 'GREEN'}`)
}
for (const [path, hash] of Object.entries(inputs)) assert.equal(digest(await readFile(resolve(root, path))), hash, 'Read-only mutation input preserved')
await writeFile(resolve(output, 'receipt.json'), JSON.stringify({ schema: diagnostics ? 'agentmux.runtime-endpoint-diagnostic-mutations.v1' : recovery ? 'agentmux.remote-runtime-recovery-mutations.v1' : 'agentmux.remote-runtime-renderer-mutations.v1', passed: true, inputs, results,
  mutationMethod: 'Readonly Vite product block transforms. Shared source/index unchanged.',
  boundary: recovery ? 'Actual mounted Store consumer reconnects a private Unix public Headless owner to the original Provider/ctxmux Run. Only SSH transport selection is replaced; no Farm, real Provider or native Electron/aesthetics claim.'
    : 'Actual Store/GlobalSystemNotices/HostSettingsPane mounted behavior; no real remote service, Farm, native restart or aesthetics claim.' }, null, 2) + '\n')
console.log(JSON.stringify({ passed: true, receipt: resolve(output, 'receipt.json') }))
