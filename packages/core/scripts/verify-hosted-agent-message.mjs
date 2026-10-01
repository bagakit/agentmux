import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'

const repository = resolve(import.meta.dirname, '../../..')
const evidence = join(repository, '.tmp/private-mobile-host/hosted-agent-message')
await mkdir(evidence, { recursive: true })
const files = ['packages/core/src/client.ts', 'packages/core/src/hosted-client-contract.ts',
  'packages/core/src/hosted-runtime-service.ts', 'packages/core/src/hosted-client.ts', 'packages/core/src/hosted-value.ts',
  'packages/core/test/hosted-agent-message.test.ts', 'packages/core/scripts/verify-hosted-agent-message.mjs',
  'apps/desktop/src/main/runtime-controller.ts', 'apps/host/src/host.ts']
const hashes = async () => Object.fromEntries(await Promise.all(files.map(async file =>
  [file, createHash('sha256').update(await readFile(join(repository, file))).digest('hex')])))
const source = await hashes(), originalConfig = join(repository, 'vitest.config.ts')
const run = config => {
  const result = spawnSync(process.execPath, [join(repository, 'node_modules/vitest/vitest.mjs'), 'run',
    '--config', config, 'packages/core/test/hosted-agent-message.test.ts'],
  { cwd: repository, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  if (result.error) throw result.error
  return { code: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}
const green = run(originalConfig)
await writeFile(join(evidence, 'green.log'), green.output)
assert.equal(green.code, 0, green.output); assert.match(green.output, /2 passed/u)
const target = join(repository, 'packages/core/src/hosted-client-contract.ts')
const from = "'submitAgentPrompt', 'submitAgentMessage'", to = "'submitAgentPrompt'"
const original = await readFile(target, 'utf8')
assert.equal(original.split(from).length, 2, 'One actual finite method Source block is identified')
const config = join(evidence, 'message-owner-omitted.config.mts')
await writeFile(config, `import base from ${JSON.stringify(originalConfig)};\nexport default {...base,plugins:[{name:'hosted-message-source-mutant',enforce:'pre',transform(code,id){if(id.split('?')[0]!==${JSON.stringify(target)})return;const from=${JSON.stringify(from)};if(code.split(from).length!==2)throw new Error('Actual Source block absent');console.info('AMX_HOSTED_MESSAGE_MUTANT:owner-omitted');return code.replace(from,${JSON.stringify(to)});}},...(base.plugins??[])]};\n`)
let red
try {
  red = run(config)
  await writeFile(join(evidence, 'owner-omitted-red.log'), red.output)
  assert.notEqual(red.code, 0, 'Removing the message owner must fail actual behavior')
  assert.match(red.output, /AMX_HOSTED_MESSAGE_MUTANT:owner-omitted/u)
  assert.match(red.output, /AssertionError/u, 'Collection or transform failure does not qualify')
} finally { await rm(config) }
const restored = run(originalConfig)
await writeFile(join(evidence, 'restored-green.log'), restored.output)
assert.equal(restored.code, 0, restored.output); assert.match(restored.output, /2 passed/u)
assert.deepEqual(await hashes(), source, 'Source stayed unchanged throughout the isolated proof')
const controller = await readFile(join(repository, 'apps/desktop/src/main/runtime-controller.ts'), 'utf8')
assert.ok(controller.includes('await client.submitAgentMessage({'), 'Actual Desktop message caller consumes the original public method')
const sdk = await readFile(join(repository, 'packages/core/src/hosted-client.ts'), 'utf8')
assert.ok(sdk.includes('for (const method of AGENTMUX_HOSTED_METHODS)'), 'SDK consumes the same finite table')
await writeFile(join(evidence, 'receipt.json'), JSON.stringify({ schema: 'agentmux.hosted-agent-message.v1',
  source, behaviorCases: 2, mutation: { id: 'owner-omitted', applied: true, assertionRed: true, exit: red.code },
  restoredGreen: { exit: restored.code, behaviorCases: 2 },
  callers: ['RuntimeController.submitMessage → SDK.submitAgentMessage → original Core.submitAgentMessage',
    'Host → original HostedRuntimeService'],
  limitations: ['Original Core authorization, durable queue, prompt admission and receipts stay real; only private ctxmux Input receipts are controlled. This is not actual public transport or device verification.']
}, null, 2) + '\n')
console.log('Hosted original messages: 2 actual cases GREEN, 1 finite Source block Assertion RED, restored 2 GREEN.')
