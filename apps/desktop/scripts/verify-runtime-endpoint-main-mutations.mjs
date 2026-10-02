import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '../../..')
const output = resolve(process.argv[2] ?? resolve(root, '.tmp/runtime-endpoint-main-mutations', ("run-" + (globalThis.crypto.randomUUID()) + "")))
const paths = {
  controller: 'apps/desktop/src/main/runtime-controller.ts',
  transaction: 'apps/desktop/src/main/runtime-config-transaction.ts',
  ipc: 'apps/desktop/src/main/ipc.ts',
  projection: 'apps/desktop/src/renderer/src/lib/session-state.ts',
  ssh: 'packages/core/src/execution-host.ts'
}
const tests = ['apps/desktop/test/runtime-endpoint-isolation.integration.test.ts',
  'apps/desktop/test/runtime-endpoint-startup.integration.test.ts', 'packages/core/test/execution-host.test.ts']
const hash = value => createHash('sha256').update(value).digest('hex')
const sources = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, path]) => [key, await readFile(resolve(root, path), 'utf8')])))
const inputs = Object.fromEntries(Object.entries(paths).map(([key, path]) => [path, hash(sources[key])]))
for (const test of tests) inputs[test] = hash(await readFile(resolve(root, test)))
await mkdir(output, { recursive: true })
const variants = [
  { name: 'baseline-green', edits: [] },
  { name: 'failure-expanded-to-all-endpoints', edits: [{ key: 'controller',
    before: '    const projections = results.flatMap((result, index) => {',
    after: `    const rejected = results.find(result => result.status === 'rejected')
    if (rejected?.status === 'rejected') throw rejected.reason
    const projections = results.flatMap((result, index) => {` }] },
  { name: 'semantic-binding-not-persisted', edits: [{ key: 'transaction',
    before: "  const bindings = preparation.runtimeBindings ?? new Map<string, string>()",
    after: '  return config\n  const bindings = preparation.runtimeBindings ?? new Map<string, string>()' }] },
  { name: 'semantic-rebinding-guards-removed', edits: [
    { key: 'controller', before: '      if (known && known !== next.runtimeId) {', after: '      if (false) {' },
    { key: 'transaction', before: '    if (host.runtimeId !== undefined) throw new Error(`Runtime binding changed for ${host.id}`)', after: '    // Mutant: the original owner may be replaced by a different semantic binding.' }
  ] },
  { name: 'remote-shell-literal-argv-removed', edits: [{ key: 'ssh',
    before: `      return "'" + value.replaceAll("'", "'\\\\''") + "'"`, after: '      return value' }] },
  { name: 'startup-joins-pending-remote', edits: [{ key: 'controller',
    before: `      client = await this.connectRuntimeClient(config, store)
      return { id: config.id, executionHost, client, config,`,
    after: `      client = await this.connectRuntimeClient(config, store)
      await client.connect()
      return { id: config.id, executionHost, client, config,` }] },
  { name: 'snapshot-joins-pending-remote', edits: [{ key: 'controller',
    before: '        throw new AgentMuxError(warning.message, warning.code)',
    after: '        await client.connect()\n        throw new AgentMuxError(warning.message, warning.code)' }] },
  { name: 'incomplete-cut-warning-cleared', edits: [{ key: 'ipc',
    before: '      ...(snapshot.runtimeEndpointWarnings ?? []).filter(warning => warning.availability !== \'connected\')',
    after: '      ...[].filter(warning => warning.availability !== \'connected\')' }] },
  { name: 'retired-connect-failure-published', edits: [{ key: 'controller',
    before: `        if (this.hosts.get(hostId)?.client !== client) return
        this.publish(hostId, { type: 'connection-state', state: 'unrecoverable',`,
    after: `        this.publish(hostId, { type: 'connection-state', state: 'unrecoverable',` }] },
  { name: 'saved-terminal-not-adopted', edits: [{ key: 'projection',
    before: `  for (const session of canonicalTerminals) {
    if (projectedTerminalIds.has(session.id) && !existingIds.has(session.id)) sessions.push(session)
  }`,
    after: '  // Mutant: the persisted Terminal can never acquire its verified original Run.' }] },
  { name: 'restored-green', edits: [] }
]
const results = []
let baselineCases
for (const variant of variants) {
  const directory = resolve(output, variant.name)
  await mkdir(directory)
  const consumed = {}
  for (const edit of variant.edits) {
    const source = consumed[edit.key] ?? sources[edit.key]
    assert.equal(source.split(edit.before).length - 1, 1, 'Exactly one nonempty real product block')
    consumed[edit.key] = source.replace(edit.before, edit.after)
  }
  const modules = Object.fromEntries(Object.entries(consumed).map(([key, code]) => [resolve(root, paths[key]), {
    code, sourceSHA256: hash(sources[key]), consumedSHA256: hash(code)
  }]))
  const loaded = resolve(directory, 'loaded.ndjson')
  const configPath = resolve(directory, 'vitest.config.mts')
  await writeFile(resolve(directory, 'mutation.json'), JSON.stringify({ variant, modules }, null, 2) + '\n')
  await writeFile(configPath, `import base from ${JSON.stringify(resolve(root, 'vitest.config.ts'))}
import { defineConfig } from 'vitest/config'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
const modules = ${JSON.stringify(modules)}
export default defineConfig({ ...base, root: ${JSON.stringify(root)},
  plugins: [{ name: 'private-runtime-endpoint-block-mutation', enforce: 'pre', transform(code, id) {
    const product = id.split('?')[0], entry = modules[product]
    if (!entry) return
    const sourceSHA256 = createHash('sha256').update(code).digest('hex')
    if (sourceSHA256 !== entry.sourceSHA256) throw Error('Product changed concurrently; proof is unconfirmed')
    appendFileSync(${JSON.stringify(loaded)}, JSON.stringify({ product, sourceSHA256, consumedSHA256: entry.consumedSHA256 }) + '\\n')
    return { code: entry.code, map: null }
  }}],
  test: { ...base.test, include: ${JSON.stringify(tests)}, passWithNoTests: false, fileParallelism: false, maxWorkers: 1 }
})\n`)
  const reportPath = resolve(directory, 'tests.json')
  const execution = spawnSync(process.execPath, [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', configPath,
    '--reporter=json', '--outputFile', reportPath], { cwd: root, encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024 })
  await writeFile(resolve(directory, 'stdout.log'), execution.stdout ?? '')
  await writeFile(resolve(directory, 'stderr.log'), execution.stderr ?? '')
  assert.ifError(execution.error)
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  assert.deepEqual(report.testResults.map(file => file.name).sort(), tests.map(test => resolve(root, test)).sort())
  const cases = report.testResults.flatMap(file => file.assertionResults)
  assert.ok(cases.length >= 7, 'Nonempty actual Main/private Core owner and shell consumers execute')
  assert.ok(cases.every(item => ['passed', 'failed'].includes(item.status)), 'No skipped/pending consumer cases')
  const names = cases.map(item => item.fullName).sort()
  if (baselineCases) assert.deepEqual(names, baselineCases)
  else baselineCases = names
  const failed = cases.filter(item => item.status === 'failed')
  if (variant.edits.length) {
    const entries = (await readFile(loaded, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    for (const [product, entry] of Object.entries(modules)) assert.ok(entries.some(value => value.product === product && value.consumedSHA256 === entry.consumedSHA256))
    assert.notEqual(execution.status, 0)
    assert.ok(failed.some(item => item.failureMessages.some(message => message.includes('AssertionError'))), 'Actual Assertion RED required; setup or compilation errors do not qualify')
  } else { assert.equal(execution.status, 0); assert.equal(failed.length, 0) }
  results.push({ name: variant.name, exitCode: execution.status, executed: cases.length, failed: failed.map(item => item.fullName) })
  console.log(`${variant.name}: ${variant.edits.length ? 'Assertion RED' : 'GREEN'}`)
}
for (const [path, digest] of Object.entries(inputs)) assert.equal(hash(await readFile(resolve(root, path))), digest, 'Shared source preserved')
const receipt = resolve(output, 'receipt.json')
await writeFile(receipt, JSON.stringify({ schema: 'agentmux.runtime-endpoint-main-mutations.v1', passed: true, inputs, results,
  boundary: 'Real Main/Config owners with private official ctxmux Runs; controlled Unix transport selector. No SSH/Farm/aesthetic delivery claim.' }, null, 2) + '\n')
console.log(JSON.stringify({ passed: true, receipt }))
