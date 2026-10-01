import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'

const repository = resolve(import.meta.dirname, '../../..')
const evidence = join(repository, '.tmp/agentmux-private-mobile-client/hosted-retained-session')
await mkdir(evidence, { recursive: true })
const files = ['packages/core/src/client.ts', 'packages/core/src/hosted-client-contract.ts',
  'packages/core/src/hosted-runtime-service.ts', 'packages/core/src/hosted-client.ts', 'packages/core/src/hosted-value.ts',
  'packages/core/src/agent-session-store.ts', 'packages/core/src/agent-capability.ts',
  'packages/core/test/hosted-retained-session.test.ts', 'packages/core/scripts/verify-hosted-retained-session.mjs']
const hashes = async () => Object.fromEntries(await Promise.all(files.map(async file =>
  [file, createHash('sha256').update(await readFile(join(repository, file))).digest('hex')])))
const source = await hashes(), originalConfig = join(repository, 'vitest.config.ts')
const run = (config, pattern) => {
  const result = spawnSync(process.execPath, [join(repository, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config,
    'packages/core/test/hosted-retained-session.test.ts', ...(pattern ? ['--testNamePattern', pattern] : [])],
  { cwd: repository, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  if (result.error) throw result.error
  return { code: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}
const green = run(originalConfig)
assert.equal(green.code, 0, green.output); assert.match(green.output, /3 passed/u)
await writeFile(join(evidence, 'green.log'), green.output)
const mutations = [
  { id: 'durable-read-uses-empty-live-registry', target: 'packages/core/src/client.ts',
    from: '    return (await loadAgentSessions(this.store)).map(cloneSession)', to: '    return this.agentSessions()',
    pattern: 'reads original durable Sessions' },
  { id: 'retained-authorization-omits-capability-validation', target: 'packages/core/src/client.ts',
    from: '    const current = await this.currentMessageReader(callerAgentSessionId)\n    this.resolveMessageAuthor(capability, callerAgentSessionId, current)\n    return cloneSession(current)',
    to: '    const current = await this.currentMessageReader(callerAgentSessionId)\n    return cloneSession(current)',
    pattern: 'validates the original capability' },
  { id: 'offline-authority-demands-runtime-recovery', target: 'packages/core/src/hosted-runtime-service.ts',
    from: "  'readAgentSessions', 'sessionTimeline', 'sessionHistorySources', 'sessionHistoryPage', 'inspectManagedHooks',\n  'authorizeAgentCaller', 'authorizeRetainedAgentCaller', 'authorizeAgentMessage', 'handOff'",
    to: "  'sessionTimeline', 'sessionHistorySources', 'sessionHistoryPage', 'inspectManagedHooks',\n  'authorizeAgentCaller', 'authorizeAgentMessage', 'handOff'",
    pattern: 'reads original durable Sessions|validates the original capability' },
  { id: 'run-removal-falsely-retires-session', target: 'packages/core/src/hosted-client.ts',
    from: '      if (event.agentSessionId) bootstrap.sessions = bootstrap.sessions.filter(value => !(\n        value.run.runId === event.run.runId && value.agentSessionId === event.agentSessionId))',
    to: '      bootstrap.sessions = bootstrap.sessions.filter(value => !(\n        value.run.runId === event.run.runId && (!event.agentSessionId || value.agentSessionId === event.agentSessionId)))',
    pattern: 'retains the Session after actual Core.stopTerminal' }
]
const results = []
for (const mutation of mutations) {
  const target = join(repository, mutation.target), original = await readFile(target, 'utf8')
  assert.equal(original.split(mutation.from).length, 2, `${mutation.id} identifies one nonempty actual Source block`)
  const config = join(evidence, `${mutation.id}.config.mts`)
  await writeFile(config, `import base from ${JSON.stringify(originalConfig)};\nexport default {...base,plugins:[{name:'hosted-retained-source-mutant',enforce:'pre',transform(code,id){if(id.split('?')[0]!==${JSON.stringify(target)})return;const from=${JSON.stringify(mutation.from)};if(code.split(from).length!==2)throw new Error('Actual Source block absent');console.info('AMX_HOSTED_RETAINED_MUTANT:${mutation.id}');return code.replace(from,${JSON.stringify(mutation.to)});}},...(base.plugins??[])]};\n`)
  try {
    const red = run(config, mutation.pattern)
    assert.notEqual(red.code, 0, `${mutation.id} must fail actual behavior`)
    assert.match(red.output, new RegExp(`AMX_HOSTED_RETAINED_MUTANT:${mutation.id}`, 'u'))
    assert.match(red.output, /AssertionError/u, 'A transform/collection failure does not prove behavior')
    await writeFile(join(evidence, `${mutation.id}-red.log`), red.output)
    results.push({ id: mutation.id, exitCode: red.code, sourceApplied: true, assertionRed: true })
  } finally { await rm(config) }
}
const restored = run(originalConfig)
assert.equal(restored.code, 0, restored.output); assert.match(restored.output, /3 passed/u)
await writeFile(join(evidence, 'restored-green.log'), restored.output)
assert.deepEqual(await hashes(), source, 'Actual Source stays unchanged during isolated proof')
const sdk = await readFile(join(repository, 'packages/core/src/hosted-client.ts'), 'utf8')
const host = await readFile(join(repository, 'apps/host/src/host.ts'), 'utf8')
assert.ok(sdk.includes('for (const method of AGENTMUX_HOSTED_METHODS)'), 'Actual SDK dynamically consumes the finite derived method set')
assert.ok(host.includes('new AgentMuxHostedRuntimeService('), 'Actual Host consumes the original finite service')
await writeFile(join(evidence, 'receipt.json'), JSON.stringify({ schema: 'agentmux.hosted-retained-session.v1',
  checkedAt: new Date().toISOString(), source, behaviorCases: 3, mutations: results,
  restoredGreen: { source, behaviorCases: 3, exitCode: restored.code },
  sourceOrigin: 'da4dfe43927c0f12fdd01c109bf5e233b349ae0a:packages/core/src/client.ts (only readAgentSessions/authorizeRetainedAgentCaller and comments)',
  callers: ['hosted-client.ts finite SDK loop → original Core methods', 'apps/host/src/host.ts → AgentMuxHostedRuntimeService'],
  limitations: ['Original Core Store, capability, lifecycle and publisher paths across a finite JSON port; ctxmux stop receipts are controlled and no real Run/device is started. Public CorePort consumer still awaits accepted runtime publication.']
}, null, 2) + '\n')
console.log('Hosted retained Sessions: 3 actual cases, 4 whole Source block mutants RED, restored GREEN.')
