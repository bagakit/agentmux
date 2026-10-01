import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'

const repository = resolve(import.meta.dirname, '../../..')
const evidence = join(repository, '.tmp/private-mobile-host/hosted-output-observer')
await mkdir(evidence, { recursive: true })
const files = ['packages/core/src/hosted-client-contract.ts', 'packages/core/src/hosted-client.ts',
  'packages/core/src/hosted-output-observer.ts', 'packages/core/src/hosted.ts', 'packages/core/src/hosted-value.ts',
  'packages/core/src/client-event-publisher.ts', 'packages/core/src/client.ts', 'packages/core/src/public-rpc.ts',
  'packages/core/src/public-rpc-client.ts', 'packages/core/src/public-rpc-service.ts',
  'packages/core/test/hosted-output-observer.test.ts', 'packages/core/scripts/verify-hosted-output-observer.mjs']
const hashes = async () => Object.fromEntries(await Promise.all(files.map(async file =>
  [file, createHash('sha256').update(await readFile(join(repository, file))).digest('hex')])))
const source = await hashes(), originalConfig = join(repository, 'vitest.config.ts')
const run = (config, pattern) => {
  const result = spawnSync(process.execPath, [join(repository, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config,
    'packages/core/test/hosted-output-observer.test.ts', ...(pattern ? ['--testNamePattern', pattern] : [])],
  { cwd: repository, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  if (result.error) throw result.error
  return { code: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}
const green = run(originalConfig)
assert.equal(green.code, 0, green.output); assert.match(green.output, /7 passed/u)
await writeFile(join(evidence, 'green.log'), green.output)
const observerPath = 'packages/core/src/hosted-output-observer.ts', sdkPath = 'packages/core/src/hosted-client.ts'
const observer = await readFile(join(repository, observerPath), 'utf8')
const functionStart = observer.indexOf('export function createHostedOutputObservation(')
assert.ok(functionStart >= 0)
const observerBody = observer.slice(functionStart)
assert.ok(observerBody.includes("rpc.subscribe('agent.output'"), 'The actual factory body must be nonempty')
const decoderMutant = observerBody.replace('const replay: AgentMuxRunDataEvent[] = [], decoder = new TextDecoder()',
  'const replay: AgentMuxRunDataEvent[] = []').replace('              const data: AgentMuxRunDataEvent = {',
  '              const decoder = new TextDecoder()\n              const data: AgentMuxRunDataEvent = {')
assert.notEqual(decoderMutant, observerBody)
const mutations = [
  { id: 'fake-initial-empty-replay', target: observerPath,
    from: '    if (initial && cursor >= initial.run.latestOutputBytes && !replayFinished) {\n      replayFinished = true; resolveReplay()\n    }',
    to: '    if (initial && !replayFinished) {\n      replayFinished = true; resolveReplay()\n    }',
    pattern: 'waits for the same attachment replay fence' },
  { id: 'decoder-recreated-per-chunk', target: observerPath, from: observerBody, to: decoderMutant,
    pattern: 'waits for the same attachment replay fence' },
  { id: 'late-subscription-orphaned', target: observerPath,
    from: '      if (closed) {\n        await subscription.dispose()\n        // Keep the original admission/identity error. A late handle needs cleanup,\n        // but cleanup cannot replace that fact with a generic cancellation.\n        await replayComplete\n        throw new AgentMuxError(\'The output reader closed while its subscription was being admitted.\', \'CONTROL_CANCELLED\')\n      }',
    to: '      if (closed) {\n        await replayComplete\n        throw new AgentMuxError(\'The output reader closed while its subscription was being admitted.\', \'CONTROL_CANCELLED\')\n      }',
    pattern: 'releases a late admitted subscription' },
  { id: 'sdk-disposal-keeps-independent-outputs', target: sdkPath,
    from: '      const ownedOutputs = [...outputs]; outputs.clear()\n      stream = undefined; publisher.dispose()\n      await Promise.allSettled([...resources.map(value => value.dispose()), ...ownedOutputs.map(value => value.close())])',
    to: '      outputs.clear()\n      stream = undefined; publisher.dispose()\n      await Promise.allSettled(resources.map(value => value.dispose()))',
    pattern: 'closes only its own same-Run lease' },
  { id: 'private-output-also-published-globally', target: sdkPath,
    from: '      const output = createHostedOutputObservation(rpc, ...args)',
    to: '      const output = createHostedOutputObservation(rpc, args[0], args[1], event => { publisher.publish(event); args[2](event) })',
    pattern: 'waits for the same attachment replay fence' },
  { id: 'another-session-accepted', target: observerPath,
    from: '          if (initial || value.session.agentSessionId !== agentSessionId || value.run.agentSessionId !== agentSessionId\n            || value.run.runId !== value.session.run.runId || !Number.isSafeInteger(value.run.latestOutputBytes)\n            || value.run.latestOutputBytes < 0) {\n            fail(new AgentMuxError(\'The output observation belongs to another Session or Run.\', \'STALE_AGENT_SESSION_BINDING\')); return\n          }\n',
    to: '', pattern: 'rejects another Session identity' },
  { id: 'closed-await-receipt-returned', pattern: 'withdraws a confirmed replay result', changes: [
    { target: observerPath,
      from: '      await replayComplete\n      if (closed) throw new AgentMuxError(\'The output reader closed before its observation receipt was returned.\', \'CONTROL_CANCELLED\')\n      return { initial, replay, close }',
      to: '      await replayComplete\n      return { initial, replay, close }' },
    { target: sdkPath,
      from: '        const { initial, replay } = await output.ready\n        if (disposed) throw new AgentMuxError(\'Hosted consumer is disposed.\', \'CONTROL_CANCELLED\')\n        return { session: initial.session, attachment: { run: initial.run, replay, gap: initial.gap,\n          terminal: initial.terminal, resizeRevision: initial.resizeRevision },',
      to: '        const { initial, replay } = await output.ready\n        return { session: initial.session, attachment: { run: initial.run, replay, gap: initial.gap,\n          terminal: initial.terminal, resizeRevision: initial.resizeRevision },' }
  ] },
  { id: 'original-identity-error-overwritten', target: observerPath,
    from: '      if (closed) {\n        await subscription.dispose()\n        // Keep the original admission/identity error. A late handle needs cleanup,\n        // but cleanup cannot replace that fact with a generic cancellation.\n        await replayComplete\n        throw new AgentMuxError(\'The output reader closed while its subscription was being admitted.\', \'CONTROL_CANCELLED\')\n      }',
    to: '      if (closed) {\n        await subscription.dispose()\n        throw new AgentMuxError(\'The output reader closed while its subscription was being admitted.\', \'CONTROL_CANCELLED\')\n      }',
    pattern: 'rejects another Session identity' },
  { id: 'same-attachment-metadata-discarded', target: sdkPath,
    from: '        return { session: initial.session, attachment: { run: initial.run, replay, gap: initial.gap,\n          terminal: initial.terminal, resizeRevision: initial.resizeRevision },',
    to: '        return { session: initial.session, attachment: { run: initial.run, replay, gap: initial.gap },',
    pattern: 'returns the original same-attachment terminal facts' }
]
const results = []
for (const mutation of mutations) {
  const changes = mutation.changes ?? [{ target: mutation.target, from: mutation.from, to: mutation.to }]
  const edits = []
  for (const change of changes) {
    const target = join(repository, change.target), original = await readFile(target, 'utf8')
    assert.equal(original.split(change.from).length, 2, `${mutation.id} identifies one actual Source block in ${change.target}`)
    edits.push({ ...change, target })
  }
  const config = join(evidence, `${mutation.id}.config.mts`)
  await writeFile(config, `import base from ${JSON.stringify(originalConfig)};\nconst edits=${JSON.stringify(edits)};\nexport default {...base,plugins:[{name:'hosted-output-source-mutant',enforce:'pre',transform(code,id){const edit=edits.find(value=>value.target===id.split('?')[0]);if(!edit)return;if(code.split(edit.from).length!==2)throw new Error('Actual Source block absent');console.info('AMX_HOSTED_OUTPUT_MUTANT:${mutation.id}:'+edit.target);return code.replace(edit.from,edit.to);}},...(base.plugins??[])]};\n`)
  try {
    const red = run(config, mutation.pattern)
    assert.notEqual(red.code, 0, `${mutation.id} must fail actual behavior`)
    assert.match(red.output, new RegExp(`AMX_HOSTED_OUTPUT_MUTANT:${mutation.id}`, 'u'))
    for (const edit of edits) assert.ok(red.output.includes(`AMX_HOSTED_OUTPUT_MUTANT:${mutation.id}:${edit.target}`), 'Every owning Source block must be transformed')
    assert.match(red.output, /AssertionError/u, 'A transform/collection failure does not prove behavior')
    await writeFile(join(evidence, `${mutation.id}-red.log`), red.output)
    results.push({ id: mutation.id, exitCode: red.code, sourceApplied: true, assertionRed: true })
  } finally { await rm(config) }
}
const restored = run(originalConfig)
assert.equal(restored.code, 0, restored.output); assert.match(restored.output, /7 passed/u)
await writeFile(join(evidence, 'restored-green.log'), restored.output)
assert.deepEqual(await hashes(), source, 'Isolated proof must preserve actual Source')
const sdk = await readFile(join(repository, sdkPath), 'utf8'), service = await readFile(join(repository, 'packages/core/src/public-rpc-service.ts'), 'utf8')
assert.ok(sdk.includes('const output = createHostedOutputObservation(rpc, ...args)'), 'The actual SDK invokes the observation factory outside its definition')
assert.ok(service.includes('.observeAgentOutput('), 'The original public service consumes its borrowed SDK output capability')
await writeFile(join(evidence, 'receipt.json'), JSON.stringify({ schema: 'agentmux.hosted-output-observer.v1',
  checkedAt: new Date().toISOString(), source, behaviorCases: 7, mutations: results,
  restoredGreen: { source, behaviorCases: 7, exitCode: restored.code },
  callers: ['hosted-client.ts observeAgentOutput → createHostedOutputObservation', 'public-rpc-service.ts → borrowed SDK observeAgentOutput'],
  limitations: ['Actual Source SDK across a controlled typed existing public output port; no actual transport/Core process/device is started.',
    'Uses the complete original Core observation tuple and return shape. Its terminal facts and resize revision come from the same accepted public agent.output opening; this fixture does not prove a real process or device.']
}, null, 2) + '\n')
console.log('Hosted output observer: 7 actual SDK cases, 9 Source block mutants RED, restored GREEN.')
