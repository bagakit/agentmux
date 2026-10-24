import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const tests = ['packages/core/test/capsule-runtime.test.ts', 'packages/core/test/capsule-terminal-preparation.test.ts', 'packages/core/test/prepared-creation-observation.test.ts']
const mutations = [
  { id: 'original-query-scans-inventory', file: 'packages/core/src/ctxmux-run-adapter.ts',
    from: 'const { observation } = await this.requireClient().observeCreation(createOperationKey(operationKey))',
    to: 'await this.requireClient().list(); const { observation } = await this.requireClient().observeCreation(createOperationKey(operationKey))',
    assertion: 'observes one exact creation without consulting' },
  { id: 'original-query-retargeted', file: 'packages/core/src/ctxmux-run-adapter.ts',
    from: 'observeCreation(createOperationKey(operationKey))', to: "observeCreation(createOperationKey('foreign-creation'))",
    assertion: 'observes one exact creation without consulting' },
  { id: 'original-query-ignores-frozen-spec', file: 'packages/core/src/ctxmux-run-adapter.ts',
    from: 'if (!isDeepStrictEqual(observed.spec, request))', to: 'if (false)',
    assertion: 'refuses a retained original key whose complete frozen launch differs' },
  { id: 'not-retained-repeats-start', file: 'packages/core/src/ctxmux-run-adapter.ts',
    from: "if (observed === null) return null",
    to: "if (observed === null) return await this.startPrepared(request, operationKey)",
    assertion: 'keeps not-retained unknown and inspects the same operation' },
  { id: 'observed-terminal-start-blocked', file: 'packages/core/src/capsule-run-manager.ts',
    from: "if (b.launchPhase === 'dispatched' && !original || !terminalRun(original))",
    to: "if (b.launchPhase === 'dispatched' || !terminalRun(original))",
    assertion: 'allows explicit Start after Native confirms' },
  { id: 'observed-terminal-binding-lost', file: 'packages/core/src/capsule-run-manager.ts',
    from: "if (!b.run && original) { b.run = { runId: original.runId }; b.launchPhase = 'confirmed' }", to: '',
    assertion: 'allows explicit Start after Native confirms' },
  { id: 'observed-start-stop-fence-lost', file: 'packages/core/src/capsule-run-manager.ts',
    from: "if (command.kind === 'stop' && !stopRun && b?.launchPhase === 'dispatched') {", to: 'if (false) {',
    assertion: 'allows an explicit Stop of the exact Run observed' },
  { id: 'runtime-inspection-converges', file: 'packages/core/src/capsule-run-manager.ts',
    from: 'const run = await this.observedRun(b)', to: 'const run = (await this.converge(b)).run',
    assertion: 'keeps inspection of a prepared original Start' },
  { id: 'page-inspection-converges', file: 'packages/core/src/capsule-run-manager.ts',
    from: 'const run = serviceReads.has(method) ? await this.observedRun(b) : (await this.converge(b)).run',
    to: 'const run = (await this.converge(b)).run', assertion: 'keeps inspection of a prepared original Start' },
  { id: 'unconfigured-read-starts-service', file: 'packages/core/src/capsule-run-manager.ts',
    from: "        if (method !== 'capsule.create') throw unavailable('The Capsule service has no running intent. Start it explicitly or create a page before using this operation; this operation did not start a service.', 'CAPSULE_RUNTIME_UNCONFIGURED')\n",
    to: '', assertion: 'keeps unconfigured page reads lazy' },
  { id: 'intent-gap-falsely-superseded', file: 'packages/core/src/capsule-run-manager.ts',
    from: "if (retained.phase === 'prepared' &&", to: "if (false && retained.phase === 'prepared' &&", assertion: 'retains a command reserved' },
  { id: 'stale-connection-overwrites-stop', file: 'packages/core/src/capsule-run-manager.ts',
    from: "if (!current || current.revision !== b.revision || current.desired !== 'running' ||\n      current.run?.runId !== b.run?.runId || !isDeepStrictEqual(current.launch, b.launch) ||\n      current.run !== null && current.run.runId !== run.runId)", to: 'if (false)', assertion: 'preserves a later explicit Stop' },
  { id: 'stop-token-retargeted', file: 'packages/core/src/capsule-run-manager.ts',
    from: '(b.stop && b.stop.run.runId !== b.run?.runId)', to: 'false', assertion: 'rejects a restored Stop token' },
  { id: 'directory-durability-skipped', file: 'packages/core/src/capsule-run-manager.ts',
    from: 'await this.confirmDurable(this.path)', to: 'void this.path', assertion: 'requires original file and directory durability' },
  { id: 'historical-interrupted-ignored', file: 'packages/core/src/capsule-run-manager.ts',
    from: " || run.state === 'interrupted'", to: '', assertion: 'recovers a Native-authoritative interrupted' },
  { id: 'unknown-start-replayed', file: 'packages/core/src/capsule-run-manager.ts',
    from: "if (b.launchPhase === 'prepared') {", to: "if (b.launchPhase === 'prepared' || b.launchPhase === 'dispatched') {", assertion: 'observes an unknown original Start' },
  { id: 'unknown-stop-replayed', file: 'packages/core/src/capsule-run-manager.ts',
    from: "if (b.stopPhase === 'prepared') {", to: "if (b.stopPhase === 'prepared' || b.stopPhase === 'dispatched') {", assertion: 'persists stopped intent' },
  { id: 'stopped-read-restarts', file: 'packages/core/src/capsule-run-manager.ts',
    from: "if (b.desired === 'stopped') throw unavailable", to: "if (false && b.desired === 'stopped') throw unavailable", assertion: 'persists stopped intent' },
  { id: 'run-fence-removed', file: 'packages/core/src/capsule-run-manager.ts',
    from: "if (command.kind === 'stop' && !isDeepStrictEqual", to: "if (false && command.kind === 'stop' && !isDeepStrictEqual", assertion: 'requires original revision and Run' },
  { id: 'revision-fence-removed', file: 'packages/core/src/capsule-run-manager.ts',
    from: 'if (command.params.expectedRevision !== (b?.revision ?? 0))', to: 'if (false && command.params.expectedRevision !== (b?.revision ?? 0))', assertion: 'requires original revision and Run' },
  { id: 'exact-spec-weakened', file: 'packages/core/src/ctxmux-run-adapter.ts',
    from: ' || !isDeepStrictEqual(run.spec, request)', to: '', assertion: 'reads only the exact bound Run' },
  { id: 'exact-ref-dropped', file: 'packages/core/src/client.ts',
    from: 'request, prepared.createOperationId, ref?.runId', to: 'request, prepared.createOperationId, undefined', assertion: 'reads only the exact bound Run' },
  { id: 'stop-owner-replaced', file: 'packages/core/src/client.ts',
    from: 'daemonInstance: prepared.ownerInstanceId, operationKey: prepared.operationId',
    to: "daemonInstance: 'replacement-native-owner', operationKey: prepared.operationId", assertion: 'prepares Stop without effects' },
]
const mutationIndex = process.argv.indexOf('--mutation')
const selectedMutations = mutationIndex < 0 ? mutations : mutations.filter(mutation => mutation.id === process.argv[mutationIndex + 1])
if (mutationIndex >= 0) assert.equal(selectedMutations.length, 1, '--mutation requires one known source mutation ID')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
await mkdir(join(root, '.tmp'), { recursive: true })
const directory = await mkdtemp(join(root, '.tmp', 'capsule-runtime-unit-'))
await symlink(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir')
const receipt = { schema: 'agentmux.capsule-runtime-unit-proof.v1', passed: false,
  boundary: 'Focused real management source with controlled Native outcomes; the companion runtime proof consumes actual compiled Core, CLI, ctxmux and service processes.',
  evidenceDirectory: directory, inputs: {}, sdkInputs: {}, baseline: null, mutations: [] }

async function run(name, mutation) {
  const report = join(directory, `${name}.json`), config = join(directory, `${name}.config.mts`)
  const witness = join(directory, `${name}.loaded.json`)
  let plugin = ''
  if (mutation) {
    const source = await readFile(join(root, mutation.file), 'utf8')
    assert.equal(source.split(mutation.from).length - 1, 1, `${mutation.id}: source anchor must be unique`)
    const transformed = source.replace(mutation.from, mutation.to)
    assert.notEqual(sha(source), sha(transformed))
    receipt.inputs[mutation.file] = sha(source)
    // Vite mutates the actual owning implementation as loaded, never shared source or dist.
    plugin = `plugins:[{name:'capsule-source-mutation',enforce:'pre',transform(code,id){if(id.split('?')[0]===${JSON.stringify(resolve(root, mutation.file))}){if(code.split(${JSON.stringify(mutation.from)}).length!==2)throw new Error('Mutation source anchor unavailable');const next=code.replace(${JSON.stringify(mutation.from)},${JSON.stringify(mutation.to)});writeFileSync(${JSON.stringify(witness)},JSON.stringify({original:sha(code),loaded:sha(next)}));return {code:next,map:null}}}}],`
    mutation.loadedSha256 = sha(transformed)
  }
  await writeFile(config, `import { writeFileSync } from 'node:fs';import { createHash } from 'node:crypto';const sha=v=>createHash('sha256').update(v).digest('hex');import base from ${JSON.stringify(join(root, 'packages/core/test/capsule-runtime.config.mts'))};export default {...base,root:${JSON.stringify(root)},${plugin}test:{...base.test,passWithNoTests:false,maxWorkers:1}};\n`)
  const result = await new Promise((resolveRun, reject) => {
    const args = [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, '--reporter=json', '--outputFile', report]
    if (mutation) args.push('-t', mutation.assertion)
    const child = spawn(process.execPath, args, { cwd: root,
      env: { ...process.env, pnpm_config_verify_deps_before_run: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
    child.once('error', reject); child.once('close', code => resolveRun({ code, output }))
  })
  let data
  try { data = JSON.parse(await readFile(report, 'utf8')) }
  catch { throw new Error(`${name}: no valid test report; infrastructure failure is not semantic RED. ${result.output.slice(-4000)}`) }
  await writeFile(join(directory, name + '.log'), result.output)
  const assertions = data.testResults.flatMap(suite => suite.assertionResults)
  assert.ok(assertions.length > 0, 'An empty suite is not proof')
  assert.equal(data.numRuntimeErrorTestSuites ?? 0, 0, result.output.slice(-4000))
  const failures = assertions.filter(item => item.status === 'failed')
  if (mutation) {
    const loaded = JSON.parse(await readFile(witness, 'utf8'))
    assert.equal(loaded.original, receipt.inputs[mutation.file]); assert.equal(loaded.loaded, mutation.loadedSha256)
    assert.equal(result.code, 1, `${name}: source mutation must fail. ${result.output.slice(-4000)}`)
    assert.ok(failures.some(item => item.fullName.includes(mutation.assertion) && item.failureMessages.some(message => message.includes('AssertionError') || message.includes('promise resolved') || message.includes('promise rejected'))),
      `${name}: designated business assertion must fail, not collection/preparation. ${result.output.slice(-4000)}`)
  } else {
    assert.equal(result.code, 0, result.output.slice(-4000)); assert.equal(data.numFailedTests, 0)
    assert.equal(data.numPassedTests, 36, 'Management, Client/adapter and actual SDK wire suites must execute')
  }
  return { exitCode: result.code, passed: data.numPassedTests, failed: data.numFailedTests,
    reportSha256: sha(await readFile(report)), ...(mutation ? { id: mutation.id, source: mutation.file,
      loadedSha256: mutation.loadedSha256, assertion: mutation.assertion } : {}) }
}

try {
  const sdk = resolve(process.env.CTXMUX_TEST_SDK_SOURCE ?? createRequire(import.meta.url).resolve('@ctxmux/sdk'))
  for (const name of await readdir(dirname(sdk), { recursive: true })) {
    if (name.endsWith('.js')) { const path = join(dirname(sdk), name); receipt.sdkInputs[path] = sha(await readFile(path)) }
  }
  assert.ok(Object.keys(receipt.sdkInputs).length > 0, 'Actual SDK output must be source-bound')
  for (const path of [...tests, 'packages/core/src/capsule-runtime.ts', 'packages/core/src/capsule-run-manager.ts',
    'packages/core/src/client.ts', 'packages/core/src/ctxmux-run-adapter.ts', 'packages/core/src/terminal-preparation.ts',
    'packages/core/test/capsule-runtime.config.mts', 'packages/core/scripts/verify-capsule-runtime-unit.mjs'])
    receipt.inputs[path] = sha(await readFile(join(root, path)))
  receipt.baseline = await run('baseline')
  if (process.argv.includes('--mutations') || mutationIndex >= 0)
    for (const mutation of selectedMutations) receipt.mutations.push(await run(mutation.id, mutation))
  for (const [path, digest] of Object.entries(receipt.inputs))
    assert.equal(sha(await readFile(join(root, path))), digest, `Concurrent source changed; rerun evidence: ${path}`)
  for (const [path, digest] of Object.entries(receipt.sdkInputs)) assert.equal(sha(await readFile(path)), digest, `SDK output changed: ${path}`)
  receipt.passed = true
} catch (error) {
  receipt.error = error instanceof Error ? error.message : String(error)
  throw error
} finally {
  const targetIndex = process.argv.indexOf('--output')
  if (targetIndex >= 0) {
    const path = process.argv[targetIndex + 1]
    assert.ok(path, '--output requires an evidence file')
    await writeFile(resolve(path), JSON.stringify(receipt, null, 2) + '\n')
  }
}
process.stdout.write(JSON.stringify(receipt) + '\n')
