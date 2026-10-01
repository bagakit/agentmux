import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'

const repository = resolve(import.meta.dirname, '../../..')
const evidence = join(repository, '.tmp/agentmux-private-mobile-client/hosted-reading-intent')
await mkdir(evidence, { recursive: true })
const files = ['packages/core/src/hosted-client.ts', 'packages/core/src/hosted-client-contract.ts',
  'packages/core/src/hosted-value.ts', 'packages/core/src/client-event-publisher.ts',
  'packages/core/test/hosted-reading-intent.test.ts', 'packages/core/scripts/verify-hosted-reading-intent.mjs']
const hashes = async () => Object.fromEntries(await Promise.all(files.map(async file =>
  [file, createHash('sha256').update(await readFile(join(repository, file))).digest('hex')])))
const source = await hashes()
const run = (config, pattern) => {
  const result = spawnSync(process.execPath, [join(repository, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config,
    'packages/core/test/hosted-reading-intent.test.ts', ...(pattern ? ['--testNamePattern', pattern] : [])],
  { cwd: repository, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  if (result.error) throw result.error
  return { code: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}
const originalConfig = join(repository, 'vitest.config.ts')
const initial = run(originalConfig)
assert.equal(initial.code, 0, initial.output)
assert.match(initial.output, /2 passed/u, 'Both actual nonempty SDK reconnect counterexamples must execute')
await writeFile(join(evidence, 'green.log'), initial.output)
const target = join(repository, 'packages/core/src/hosted-client.ts'), original = await readFile(target, 'utf8')
const start = original.indexOf('        for (const reading of [...attached.values()]) {')
const end = original.indexOf('        for (const read of histories) {', start)
assert.ok(start >= 0 && end > start, 'Actual reconnect reading block is nonempty')
const loop = original.slice(start, end)
const guard = /^\s*if \(attached\.get\(reading\.run\.runId\) !== reading\) continue\n/gmu
assert.equal([...loop.matchAll(guard)].length, 3, 'Scope guards are present at admission, late receipt and late error')
const mutations = [
  { id: 'release-intent-waits-for-remote-receipt',
    from: "    if (method === 'releaseRunAttachment') attached.delete((args[0] as AgentMuxRunRef).runId)\n    const value = await invoke(method, args)",
    to: "    const value = await invoke(method, args)\n    if (method === 'releaseRunAttachment') attached.delete((args[0] as AgentMuxRunRef).runId)",
    pattern: 'retains a failed remote release' },
  { id: 'late-refresh-revives-withdrawn-reading', from: loop, to: loop.replace(guard, ''),
    pattern: 'does not publish a late refresh' }
]
const results = []
for (const mutation of mutations) {
  assert.equal(original.split(mutation.from).length, 2, `${mutation.id} identifies one actual Source block`)
  const config = join(evidence, `${mutation.id}.config.mts`)
  await writeFile(config, `import base from ${JSON.stringify(originalConfig)};\nexport default {...base,plugins:[{name:'hosted-reading-source-mutant',enforce:'pre',transform(code,id){if(id.split('?')[0]!==${JSON.stringify(target)})return;const from=${JSON.stringify(mutation.from)};if(code.split(from).length!==2)throw new Error('Actual Source block absent');console.info('AMX_HOSTED_READING_MUTANT:${mutation.id}');return code.replace(from,${JSON.stringify(mutation.to)});}},...(base.plugins??[])]};\n`)
  try {
    const red = run(config, mutation.pattern)
    assert.notEqual(red.code, 0, `${mutation.id} must fail actual behavior`)
    assert.match(red.output, new RegExp(`AMX_HOSTED_READING_MUTANT:${mutation.id}`, 'u'))
    assert.match(red.output, /AssertionError/u, 'A transform or collection error is not detection')
    await writeFile(join(evidence, `${mutation.id}-red.log`), red.output)
    results.push({ id: mutation.id, exitCode: red.code, sourceApplied: true, assertionRed: true })
  } finally { await rm(config) }
}
const restored = run(originalConfig)
assert.equal(restored.code, 0, restored.output); assert.match(restored.output, /2 passed/u)
await writeFile(join(evidence, 'restored-green.log'), restored.output)
assert.deepEqual(await hashes(), source, 'Actual Source stays unchanged during isolated proof')
const desktop = await readFile(join(repository, 'apps/desktop/src/main/desktop-host.ts'), 'utf8')
assert.ok(desktop.includes('connectHostedAgentMux('), 'Definition-excluded actual Desktop consumes Hosted SDK')
await writeFile(join(evidence, 'receipt.json'), JSON.stringify({ schema: 'agentmux.hosted-reading-intent.v1',
  checkedAt: new Date().toISOString(), source, behaviorCases: 2, mutations: results,
  restoredGreen: { source, behaviorCases: 2, exitCode: restored.code },
  callers: ['apps/desktop/src/main/desktop-host.ts → connectHostedAgentMux'],
  limitations: ['Actual Hosted SDK reconnect across a controlled finite JSON RPC port; not actual Host/Agent/device transport acceptance.']
}, null, 2) + '\n')
console.log('Hosted reading intent: 2 behavior cases, 2 actual Source block mutants RED, restored GREEN.')
