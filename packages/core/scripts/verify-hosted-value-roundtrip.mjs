import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'

const repository = resolve(import.meta.dirname, '../../..')
const evidence = join(repository, '.tmp/agentmux-private-mobile-client/hosted-value-roundtrip')
await mkdir(evidence, { recursive: true })
const files = ['packages/core/src/hosted-value.ts', 'packages/core/src/hosted-client.ts',
  'packages/core/src/hosted-client-contract.ts', 'packages/core/test/hosted-value-roundtrip.test.ts',
  'packages/core/scripts/verify-hosted-value-roundtrip.mjs']
const hashes = async () => Object.fromEntries(await Promise.all(files.map(async file =>
  [file, createHash('sha256').update(await readFile(join(repository, file))).digest('hex')])))
const source = await hashes(), originalConfig = join(repository, 'vitest.config.ts')
const run = config => {
  const result = spawnSync(process.execPath, [join(repository, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config,
    'packages/core/test/hosted-value-roundtrip.test.ts'], { cwd: repository, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  if (result.error) throw result.error
  return { code: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}
const green = run(originalConfig)
assert.equal(green.code, 0, green.output); assert.match(green.output, /2 passed/u)
await writeFile(join(evidence, 'green.log'), green.output)
const target = join(repository, 'packages/core/src/hosted-value.ts'), original = await readFile(target, 'utf8')
const from = "    if (Object.hasOwn(value, '$agentmuxValue')) {\n      return { $agentmuxValue: 'record', entries: Object.entries(value).map(([key, item]) => [key, encodeHostedValue(item)]) }\n    }\n"
assert.equal(original.split(from).length, 2, 'One actual ordinary-record escape block must be present')
const config = join(evidence, 'ordinary-marker-record-collides.config.mts')
await writeFile(config, `import base from ${JSON.stringify(originalConfig)};\nexport default {...base,plugins:[{name:'hosted-value-source-mutant',enforce:'pre',transform(code,id){if(id.split('?')[0]!==${JSON.stringify(target)})return;const from=${JSON.stringify(from)};if(code.split(from).length!==2)throw new Error('Actual Source block absent');console.info('AMX_HOSTED_VALUE_MUTANT:ordinary-marker-record-collides');return code.replace(from,'');}},...(base.plugins??[])]};\n`)
let red
try {
  red = run(config)
  assert.notEqual(red.code, 0, 'Removing whole record escaping must fail actual typed SDK and ordered-byte behavior')
  assert.match(red.output, /AMX_HOSTED_VALUE_MUTANT:ordinary-marker-record-collides/u)
  assert.match(red.output, /AssertionError/u, 'A transform/collection failure does not prove behavior')
  await writeFile(join(evidence, 'ordinary-marker-record-collides-red.log'), red.output)
} finally { await rm(config) }
const restored = run(originalConfig)
assert.equal(restored.code, 0, restored.output); assert.match(restored.output, /2 passed/u)
await writeFile(join(evidence, 'restored-green.log'), restored.output)
assert.deepEqual(await hashes(), source, 'Isolated proof must not mutate actual Source')
const desktop = await readFile(join(repository, 'apps/desktop/src/main/desktop-host.ts'), 'utf8')
assert.ok(desktop.includes('connectHostedAgentMux('), 'Definition-excluded Desktop consumes the actual SDK codec')
await writeFile(join(evidence, 'receipt.json'), JSON.stringify({ schema: 'agentmux.hosted-value-roundtrip.v1',
  checkedAt: new Date().toISOString(), source, behaviorCases: 2,
  mutations: [{ id: 'ordinary-marker-record-collides', exitCode: red.code, sourceApplied: true, assertionRed: true }],
  restoredGreen: { source, behaviorCases: 2, exitCode: restored.code },
  callers: ['hosted-client.ts invocation → encodeHostedValue', 'apps/desktop/src/main/desktop-host.ts → connectHostedAgentMux'],
  limitations: ['Actual typed SDK/JSON receiver rejects before launch; this does not claim a live Host or device transport.']
}, null, 2) + '\n')
console.log('Hosted ordinary records: 2 actual cases, 1 whole Source block mutant RED, restored GREEN.')
