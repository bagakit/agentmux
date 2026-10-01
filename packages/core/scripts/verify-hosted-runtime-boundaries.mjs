import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'

const repository = resolve(import.meta.dirname, '../../..')
const evidence = join(repository, '.tmp/agentmux-private-mobile-client/hosted-runtime-boundaries')
await mkdir(evidence, { recursive: true })
const files = ['packages/core/src/hosted-client-contract.ts', 'packages/core/src/hosted-runtime-service.ts',
  'packages/core/src/hosted-value.ts', 'packages/core/src/hosted-client.ts', 'packages/core/test/hosted-runtime-service.test.ts',
  'packages/core/src/client.ts', 'packages/core/src/types.ts', 'packages/core/src/errors.ts',
  'packages/core/scripts/verify-hosted-runtime-boundaries.mjs']
const hashes = async () => Object.fromEntries(await Promise.all(files.map(async file =>
  [file, createHash('sha256').update(await readFile(join(repository, file))).digest('hex')])))
const source = await hashes()
const pattern = 'preserves legitimate signal|takes Prompt and history cancellation|forwards the original typed refresh|isolates a failing synchronous|isolates a failed history'
const run = (config, namePattern = pattern) => {
  const result = spawnSync(process.execPath, [join(repository, 'node_modules/vitest/vitest.mjs'), 'run',
    '--config', config, 'packages/core/test/hosted-runtime-service.test.ts', '--testNamePattern', namePattern],
  { cwd: repository, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  if (result.error) throw result.error
  return { code: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}
const originalConfig = join(repository, 'vitest.config.ts')
const initial = run(originalConfig)
assert.equal(initial.code, 0, initial.output)
assert.match(initial.output, /5 passed/u, 'Five actual nonempty SDK/service behavior cases must execute')
await writeFile(join(evidence, 'green.log'), initial.output)
const service = await readFile(join(repository, 'packages/core/src/hosted-runtime-service.ts'), 'utf8')
const deliverStart = service.indexOf('function deliver('), deliverEnd = service.indexOf('\nfunction record(', deliverStart)
assert.ok(deliverStart >= 0 && deliverEnd > deliverStart, 'Actual callback isolation block is nonempty')
const mutations = [
  { id: 'ordinary-signal-data-deleted', file: 'packages/core/src/hosted-value.ts',
    from: 'return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeHostedValue(item)]))',
    to: "return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'signal').map(([key, item]) => [key, encodeHostedValue(item)]))",
    pattern: 'preserves legitimate signal' },
  { id: 'abort-signal-leaks-into-sdk-dto', file: 'packages/core/src/hosted-client.ts',
    from: 'signal = cancellation; wireArgs = [value, ...args.slice(1)]',
    to: 'signal = cancellation; wireArgs = args', pattern: 'takes Prompt and history cancellation' },
  { id: 'refresh-operation-identity-dropped', file: 'packages/core/src/hosted-runtime-service.ts',
    from: 'await this.client.refreshRunAttachment({ runId }, afterByte, view, invocation.args[3])',
    to: 'await this.client.refreshRunAttachment({ runId }, afterByte, view)', pattern: 'forwards the original typed refresh' },
  { id: 'one-reader-failure-interrupts-other-readers', file: 'packages/core/src/hosted-runtime-service.ts',
    from: service.slice(deliverStart, deliverEnd),
    to: 'function deliver(event, listener, failed) { void listener(event) }', pattern: 'isolates a failing synchronous' },
  { id: 'history-reader-failure-interrupts-release', file: 'packages/core/src/hosted-runtime-service.ts',
    from: 'const deliverHistory = (event: AgentMuxHostedStreamEvent): void => deliver(event, onEvent, () => {\n        failed = true; release?.()\n      })',
    to: 'const deliverHistory = (event: AgentMuxHostedStreamEvent): void => { void onEvent(event) }',
    pattern: 'isolates a failed history' }
]
const results = []
for (const mutation of mutations) {
  const target = join(repository, mutation.file), original = await readFile(target, 'utf8')
  assert.equal(original.split(mutation.from).length, 2, `${mutation.id} identifies exactly one actual Source block`)
  const config = join(evidence, `${mutation.id}.config.mts`)
  await writeFile(config, `import base from ${JSON.stringify(originalConfig)};\nexport default {...base,plugins:[{name:'hosted-boundary-source-mutant',enforce:'pre',transform(code,id){if(id.split('?')[0]!==${JSON.stringify(target)})return;const from=${JSON.stringify(mutation.from)};if(code.split(from).length!==2)throw new Error('Actual Source block absent');console.info('AMX_HOSTED_BOUNDARY_MUTANT:${mutation.id}');return code.replace(from,${JSON.stringify(mutation.to)});}},...(base.plugins??[])]};\n`)
  try {
    const red = run(config, mutation.pattern)
    assert.notEqual(red.code, 0, `${mutation.id} must fail actual behavior`)
    assert.match(red.output, new RegExp(`AMX_HOSTED_BOUNDARY_MUTANT:${mutation.id}`, 'u'))
    assert.match(red.output, /AssertionError/u, 'A collection or transform failure does not count as detection')
    await writeFile(join(evidence, `${mutation.id}-red.log`), red.output)
    results.push({ id: mutation.id, exitCode: red.code, sourceApplied: true, assertionRed: true })
  } finally { await rm(config) }
}
const restored = run(originalConfig)
assert.equal(restored.code, 0, restored.output)
assert.match(restored.output, /5 passed/u)
await writeFile(join(evidence, 'restored-green.log'), restored.output)
assert.deepEqual(await hashes(), source, 'Actual product and test Source must remain unchanged across isolated proofs')
const host = await readFile(join(repository, 'apps/host/src/host.ts'), 'utf8')
const desktop = await readFile(join(repository, 'apps/desktop/src/main/desktop-host.ts'), 'utf8')
assert.ok(host.includes('new AgentMuxHostedRuntimeService('), 'Definition-excluded Host caller consumes the service')
assert.ok(desktop.includes('connectHostedAgentMux('), 'Definition-excluded Desktop caller consumes the exact facade')
await writeFile(join(evidence, 'receipt.json'), JSON.stringify({
  schema: 'agentmux.hosted-runtime-boundaries.v1', checkedAt: new Date().toISOString(), source,
  behaviorCases: 5, mutations: results, restoredGreen: { source, behaviorCases: 5, exitCode: restored.code },
  callers: ['apps/host/src/host.ts → AgentMuxHostedRuntimeService', 'apps/desktop/src/main/desktop-host.ts → connectHostedAgentMux'],
  limitations: ['Actual typed Hosted SDK and Source service with controlled Core collaborator across JSON; not a public transport, actual Agent or full Host/Desktop adoption acceptance.']
}, null, 2) + '\n')
console.log('Hosted boundary preparation: 5 behavior cases, 5 actual Source block mutants RED, restored GREEN.')
