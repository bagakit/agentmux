import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const task = process.argv.find(value => value.startsWith('--task='))?.slice(7)
const common = 'apps/desktop/test/agent-operation-feedback.test.tsx'
const cases = {
  'T-001': [
    ['wrong-stop-receipt', common, 'a wrong original receipt'],
    ['repeat-stop-on-inspect', common, 'restored references remain static'],
    ['modal-waits-for-stop', 'apps/desktop/test/session-stop-dialog-operation.test.tsx', 'a pending Stop leaves'],
    ['missing-card-feedback', 'apps/desktop/test/session-stop-dialog-operation.test.tsx', 'a pending Stop leaves']
  ],
  'T-002': [
    ['takeover-picker-waits', 'apps/desktop/test/session-takeover.test.tsx', 'a submitted takeover releases its picker'],
    ['takeover-partial-spins', 'apps/desktop/test/session-takeover.test.tsx', 'a partial takeover keeps its real new Agent']
  ],
  'T-003': [
    ['fork-menu-stays', 'apps/desktop/test/current-agent-fork-ui.test.tsx', 'the real Region header dismisses its invoking menu'],
    ['fork-shared-observation-missing', 'apps/desktop/test/current-agent-fork-ui.test.tsx', 'the real Region header consumes a card-inspected']
  ],
  'T-004': [['hidden-motion-runs', common, 'hiding the workface pauses']]
}[task]
assert.ok(cases?.length, 'Task has a nonempty actual-source mutation set')
const evidence = join(root, '.local/agent-card-operations/mutations', task)
await mkdir(evidence, { recursive: true })
const config = 'apps/desktop/test/vitest.agent-operation-feedback.config.mts'
const runs = []
async function check(name, files, mutant, testNamePattern) {
  const loaded = join(evidence, `${name}.loaded.jsonl`)
  await writeFile(loaded, '')
  const args = ['--config.verify-deps-before-run=false', 'exec', 'vitest', 'run', '--config', config, ...files,
    ...(testNamePattern ? ['--testNamePattern', testNamePattern] : [])]
  const result = await new Promise((done, reject) => {
    const child = spawn('pnpm', args, { cwd: root, env: { ...process.env,
      pnpm_config_verify_deps_before_run: 'false', AGENTMUX_AGENT_OPERATION_MUTANT: mutant ?? '', AGENTMUX_AGENT_OPERATION_LOADED: loaded } })
    let log = ''
    child.stdout.on('data', data => { log += data }); child.stderr.on('data', data => { log += data })
    child.once('error', reject); child.once('exit', code => done({ code, log }))
  })
  await writeFile(join(evidence, `${name}.log`), result.log)
  if (mutant) {
    assert.notEqual(result.code, 0, `${mutant} must fail its same consumer assertion`)
    assert.ok(result.log.includes(`MUTATION_APPLIED=${mutant}`), 'Actual production mutation loaded')
    assert.ok(result.log.includes(testNamePattern) && /Tests\s+\d+ failed/.test(result.log), 'A nonempty consumer test failed, not a missing suite or transform error')
    const inputs = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    assert.ok(inputs.length > 0 && inputs.every(input => input.source !== input.loaded))
    runs.push({ name, outcome: 'RED', command: ['pnpm', ...args], inputs })
  } else {
    assert.equal(result.code, 0, result.log)
    assert.match(result.log, /Tests\s+\d+ passed/, 'GREEN contains real executed consumers')
    runs.push({ name, outcome: 'GREEN', command: ['pnpm', ...args] })
  }
  process.stdout.write(`${task} ${name}: ${mutant ? 'RED' : 'GREEN'}\n`)
}
const files = [...new Set(cases.map(item => item[1]))]
await check('original-green', files)
for (const [mutant, file, test] of cases) await check(mutant, [file], mutant, test)
await check('restored-green', files)
if (task === 'T-004') {
  const candidateDirectory = resolve(root, process.argv.find(value => value.startsWith('--native-evidence='))?.slice('--native-evidence='.length) ?? '.local/agent-card-operations/product')
  async function nativeRun(name, args) {
    const result = await new Promise((done, reject) => {
      const child = spawn(process.execPath, args, { cwd: root, env: process.env })
      let log = ''
      child.stdout.on('data', data => { log += data }); child.stderr.on('data', data => { log += data })
      child.once('error', reject); child.once('exit', code => done({ code, log }))
    })
    await writeFile(join(evidence, name + '.log'), result.log)
    return result
  }
  const allNativeInputs = []
  for (const mutant of ['hidden-motion-runs', 'tooltip-reorders-host']) {
    const nativeDirectory = join(evidence, 'native-' + mutant)
    const mutantArgs = ['apps/desktop/scripts/verify-session-takeover.mjs', '--native', '--agent-operations', '--native-mutant=' + mutant, '--evidence=' + nativeDirectory]
    const negative = await nativeRun('native-' + mutant + '-red', mutantArgs)
    assert.notEqual(negative.code, 0, 'Actual native source mutation must fail')
    const native = JSON.parse(await readFile(join(nativeDirectory, 'receipt.json'), 'utf8'))
    assert.equal(native.schema, 'agentmux.stop-fork-feedback-native.v1')
    assert.equal(native.qualification, 'stop-fork-feedback-mutation-v1')
    assert.equal(native.processes.length, 1, 'Negative proof executes only its actual first Renderer')
    const rendered = native.processes[0].rendered
    assert.equal(native.processes[0].outcome.timedOut, false)
    assert.equal(rendered.failure?.name, 'AssertionError', 'Compile/setup/missing-source/deadline failures cannot qualify')
    let oracle
    if (mutant === 'hidden-motion-runs') {
      assert.equal(rendered.failure?.stage, 'agent-operation-visibility-work')
      assert.ok(rendered.agentOperations?.isolationObservations.some(observation => observation.label === 'offscreen' && (observation.beforeRunning + observation.afterRunning > 0 || observation.moving)), 'Actual offscreen running/moving animation work, not a data attribute, falsifies isolation')
      oracle = 'Actual offscreen running/moving animation work'
    } else {
      assert.equal(rendered.failure?.stage, 'agent-operation-fork-pointer')
      assert.ok(rendered.failure.message.includes('Opening its tooltip preserves the shown host through the native pointer sequence'), 'The original native host-preservation assertion failed')
      const pointer = rendered.agentOperations?.forkNativePointer
      assert.equal(pointer?.hit?.destination, 'right', 'The physical native destination hit is the original Right button')
      const events = pointer.after?.events ?? []
      const down = events.findIndex(event => event.type === 'pointerdown' && event.trusted && event.target?.destination === 'right')
      const activation = events.findIndex(event => event.type === 'click' && event.trusted && event.target?.destination === 'right')
      assert.ok(down >= 0 && activation > down, 'The exact destination received a trusted native pointerdown and click')
      assert.ok(events.slice(down, activation).some(event => event.type === 'beforetoggle' && event.oldState === 'open' && event.newState === 'closed' && event.target?.className?.split(/\s+/).includes('window-overlay-host')), 'The native overlay host closed between the actual pointerdown and click')
      assert.equal(pointer.after.submitted, true, 'This host-preservation negative proof retains the original Fork submission')
      oracle = 'Native overlay host closes between trusted exact Right pointerdown and click while the original Fork still submits'
    }
    assert.equal(native.sourceMutations.length, 1)
    const inputs = native.sourceMutations
    for (const input of inputs) {
      assert.notEqual(input.source, input.loaded)
      assert.equal(createHash('sha256').update(await readFile(join(root, input.file))).digest('hex'), input.source, 'Native mutation never writes production source')
    }
    allNativeInputs.push(...inputs)
    assert.ok(native.cleanup.privateRootRemoved && native.cleanup.remaining.length === 0)
    runs.push({ name: 'native-' + mutant, outcome: 'RED', command: [process.execPath, ...mutantArgs], inputs, oracle, evidence: join(nativeDirectory, 'receipt.json') })
  }
  const restoredArgs = ['apps/desktop/scripts/verify-session-takeover.mjs', '--native', '--agent-operations', '--evidence=' + candidateDirectory]
  const positive = await nativeRun('native-work-restored-green', restoredArgs)
  assert.equal(positive.code, 0, positive.log)
  const restored = JSON.parse(await readFile(join(candidateDirectory, 'receipt.json'), 'utf8'))
  assert.equal(restored.schema, 'agentmux.stop-fork-feedback-native.v1')
  assert.ok(restored.passed && restored.qualification === 'stop-fork-feedback-v1' && restored.processes.length === 2)
  for (const input of allNativeInputs) assert.equal(restored.sourceBefore[input.file], input.source, 'Restored GREEN binds the same exact source as RED')
  const isolation = restored.processes[0].rendered.agentOperations.isolationObservations
  assert.ok(isolation.length >= 2 && isolation.every(observation => observation.beforeRunning + observation.afterRunning === 0 && !observation.moving))
  const restoredPointer = restored.processes[0].rendered.agentOperations.forkNativePointer
  assert.equal(restoredPointer.hit.destination, 'right')
  assert.equal(restoredPointer.after.submitted, true, 'Restored native trusted Fork activation reaches its original controller')
  const restoredEvents = restoredPointer.after.events
  const restoredDown = restoredEvents.findIndex(event => event.type === 'pointerdown' && event.trusted && event.target?.destination === 'right')
  const restoredActivation = restoredEvents.findIndex(event => event.type === 'click' && event.trusted && event.target?.destination === 'right')
  assert.ok(restoredDown >= 0 && restoredActivation > restoredDown)
  assert.ok(!restoredEvents.slice(restoredDown, restoredActivation).some(event => event.type === 'beforetoggle' && event.newState === 'closed'), 'The same restored native pointer sequence preserves the shown host')
  runs.push({ name: 'native-animation-work-restored', outcome: 'GREEN', command: [process.execPath, ...restoredArgs], evidence: join(candidateDirectory, 'receipt.json'), reusedExactCandidateAllowed: true })
  process.stdout.write('T-004 actual native work and pointer oracles: RED → restored GREEN\n')
}
const hash = value => createHash('sha256').update(value).digest('hex')
const sources = [...new Set(runs.flatMap(run => run.inputs?.map(input => input.file) ?? []))]
const sourceHashes = Object.fromEntries(await Promise.all(sources.map(async path => [path, hash(await readFile(join(root, path)))])))
assert.ok(sources.length > 0)
await writeFile(join(evidence, 'receipt.json'), JSON.stringify({ task, passed: true, sources: sourceHashes, runs }, null, 2) + '\n')
