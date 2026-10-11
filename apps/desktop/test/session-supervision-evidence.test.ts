import { fixturePath as _historyFixturePath } from "../../../test/fixture-values.mjs"
import { afterEach, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readSupervisionCoreOwner, readSupervisionConsumerOwner, readSessionSupervisionEvidence, verifySupervisionProduct } from '../scripts/session-supervision-evidence.mjs'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


const directories: string[] = []
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
afterEach(async () => { for (const root of directories.splice(0)) await rm(root, { recursive: true, force: true }) })

// Synthetic artifacts exercise the reader's refusal boundary only. Native owner
// qualification always reads the original producer, loaded module and raw report.
async function artifacts(task: 'T003' | 'T006' = 'T003') {
  const root = await mkdtemp(path.join(tmpdir(), 'supervision-evidence-')); directories.push(root)
  const gate = 'packages/core/scripts/verify-' + (task === 'T003' ? 'resume-context-observation' : 'session-continuity-executor') + '.mjs', owner = 'packages/core/src/client.ts'
  const count = task === 'T003' ? 33 : 16, mutations = task === 'T003' ? 18 : 11
  const put = async (file: string, body: any) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await writeFile(path.join(root, file), typeof body === 'string' ? body : JSON.stringify(body))
  }
  await put(gate, 'original gate fixture'); await put(owner, 'original owner fixture')
  const row = (index: number, failed = false) => ({ fullName: 'business case ' + index,
    status: failed ? 'failed' : 'passed', failureMessages: failed ? ['AssertionError: expected original input to remain unchanged'] : [] })
  const reports: Record<string, any> = {}, modules: Record<string, string> = {}
  const result = async (name: string, failed = false) => {
    const assertions = Array.from({ length: count }, (_, index) => row(index, failed && index === 0))
    reports[name] = { success: !failed, numTotalTests: count, numPassedTests: failed ? count - 1 : count, numFailedTests: failed ? 1 : 0,
      testResults: [{ message: '', assertionResults: assertions }] }
    modules[name] = 'export const fixture = ' + JSON.stringify(name)
    await put('proof/' + name + '.json', reports[name]); await put('proof/package/dist/' + name + '.mjs', modules[name])
    return { name, code: failed ? 1 : 0, signal: null, total: count, passed: failed ? count - 1 : count, failed: failed ? 1 : 0,
      semanticRed: failed, bundleSha256: hash(modules[name]), failures: failed ? [{ name: assertions[0].fullName, messages: assertions[0].failureMessages }] : [] }
  }
  const receipt = { schema: task === 'T003' ? 'agentmux.resume-context-observation-proof.v1' : 'agentmux.session-continuity-executor-proof.v1', passed: true, sourceStable: true,
    inputs: { [gate]: hash('original gate fixture'), [owner]: hash('original owner fixture') },
    results: [await result('candidate'), ...await Promise.all(Array.from({ length: mutations }, (_, index) => result('mutant-' + index, true)))] }
  const save = () => put('proof/receipt.json', receipt); await save()
  return { root, receipt, reports, put, save, read: () => readSupervisionCoreOwner(root, task, 'proof/receipt.json') }
}

it('reads only source-bound raw counts and distinct loaded counterexamples from the new owner contract', async () => {
  const f = await artifacts(), read = await f.read()
  expect(read.sourceInputs).toBe(2); expect(read.baselineCases).toHaveLength(33); expect(read.loadedCounterexamples).toBe(18)
})

it('cannot substitute an archived task receipt or passed flag for the current supervision owner', async () => {
  const f = await artifacts(); f.receipt.schema = 'agentmux.post-start-availability-proof.v1'; await f.save()
  await expect(f.read()).rejects.toThrow()
})

it('refuses joined qualification when the required initial-cancellation owner is absent', async () => {
  await expect(readSessionSupervisionEvidence(_historyFixturePath("unused"), { T001: 'a', T002: 'b', T003: 'c', T004: {}, T006: 'd' }))
    .rejects.toThrow('Every required original supervision task')
})

it('requires the original executor Native and public consumer files beyond their summary labels', async () => {
  const f = await artifacts('T006')
  await expect(f.read()).rejects.toThrow('Original recovery consumer evidence is missing')
})

it('rejects missing source pins and changed current owner bytes', async () => {
  const f = await artifacts(); await f.put('packages/core/src/client.ts', 'changed candidate')
  await expect(f.read()).rejects.toThrow('another source candidate')
  f.receipt.inputs = {} as typeof f.receipt.inputs; await f.save()
  await expect(f.read()).rejects.toThrow('no source inputs')
})

it('requires the complete new owner counterexample set', async () => {
  const f = await artifacts(); f.receipt.results.pop(); await f.save()
  await expect(f.read()).rejects.toThrow('counterexamples are missing')
})

it('does not accept a duplicate baseline as an additional business proof', async () => {
  const f = await artifacts(); f.receipt.results.push(f.receipt.results[0]); await f.save()
  await expect(f.read()).rejects.toThrow('Exactly one original candidate baseline')
})

it('binds the original loaded mutation module bytes', async () => {
  const f = await artifacts(); await f.put('proof/package/dist/mutant-0.mjs', 'different bytes')
  await expect(f.read()).rejects.toThrow('loaded supervision module changed')
})

it('cross-checks producer totals with all raw rows instead of trusting a rewritten header', async () => {
  const f = await artifacts(), report = f.reports.candidate
  report.testResults[0].assertionResults.pop(); report.numTotalTests--; report.numPassedTests--
  await f.put('proof/candidate.json', report)
  await expect(f.read()).rejects.toThrow('producer count mismatch: total')
})

it('rejects a process exception even if the producer claims semantic RED', async () => {
  const f = await artifacts(), report = f.reports['mutant-0']
  report.testResults[0].assertionResults[0].failureMessages = ['Error: the worker process terminated']
  await f.put('proof/mutant-0.json', report)
  await expect(f.read()).rejects.toThrow('lacks a business assertion failure')
})

it('compares the exact failed business identity and message with the original producer', async () => {
  const f = await artifacts(); f.receipt.results[1].failures[0].name = 'different target case'; await f.save()
  await expect(f.read()).rejects.toThrow('failure identities and business assertions')
})

async function consumerArtifacts(kind: 'wire' | 'initialWaiting' = 'wire') {
  const root = await mkdtemp(path.join(tmpdir(), 'consumer-evidence-')); directories.push(root)
  const initial = kind === 'initialWaiting', count = initial ? 5 : 3, mutations = initial ? 6 : 3
  const gate = 'apps/desktop/scripts/' + (initial ? 'verify-initial-continuity-supervision.mjs' : 'verify-session-continuity-control-wire.mjs'), owner = 'apps/desktop/src/main/runtime-controller.ts'
  const put = async (file: string, value: any) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await writeFile(path.join(root, file), typeof value === 'string' ? value : JSON.stringify(value))
  }
  await put(gate, 'original consumer gate'); await put(owner, 'original Main owner')
  const reports: Record<string, any> = {}, witness = { original: hash('original Main owner'), loaded: hash('changed Main owner') }
  const runs = await Promise.all(Array.from({ length: mutations + 1 }, async (_, index) => {
    const id = index ? 'mutant-' + index : 'baseline', failed = index > 0
    const report = { success: !failed, numTotalTests: count, numPassedTests: failed ? count - 1 : count, numFailedTests: failed ? 1 : 0,
      testResults: [{ message: '', assertionResults: Array.from({ length: count }, (_, row) => ({ fullName: 'Main business ' + row,
        status: failed && row === 0 ? 'failed' : 'passed', failureMessages: failed && row === 0 ? ['AssertionError: expected original packet to be preserved'] : [] })) }] }
    reports[id] = report
    const bytes = JSON.stringify(report); await put('proof/' + id + '.json', bytes)
    if (failed) await put('proof/' + id + '.loaded.json', witness)
    return { id, exitCode: failed ? 1 : 0, passed: failed ? count - 1 : count, failed: failed ? 1 : 0,
      rawReport: 'proof/' + id + '.json', rawSha256: hash(bytes), ...(failed ? { target: 'Main business 0', witness } : {}) }
  }))
  const pins = { [gate]: hash('original consumer gate'), [owner]: hash('original Main owner') }
  const receipt = { schema: initial ? 'agentmux.initial-continuity-supervision-proof.v1' : 'agentmux.continuity-control-wire-proof.v1', passed: true, sourceStable: true,
    sourceBefore: pins, sourceAfter: pins, runs }
  const save = () => put('proof/receipt.json', receipt); await save()
  return { root, receipt, reports, put, save, read: () => readSupervisionConsumerOwner(root, kind, 'proof/receipt.json') }
}

it('requires both initial-wait consumer and Native originals in the four concern locator table', async () => {
  const files = { T001: 'a', T002: 'b', T003: 'c', T006: 'd', T007: 'e',
    T004: { settings: 's', cleanup: 'c', consumer: { surface: 'u' }, native: { surface: 'n' } } }
  await expect(readSessionSupervisionEvidence(_historyFixturePath("unused"), files)).rejects.toThrow('Both admitted-attempt and initial-wait original owners')
})

it('refuses an obsolete wire locator as a substitute for current Native and cleanup originals', async () => {
  const files = { T001: 'a', T002: 'b', T003: 'c', T006: 'd', T007: 'e',
    T004: { settings: 's', consumer: 'u', wire: 'w' } }
  await expect(readSessionSupervisionEvidence(_historyFixturePath("unused"), files)).rejects.toThrow('surface, settings, cleanup and Native owners')
})

it('binds the initial-wait consumer to its original raw cases and complete loaded counterexamples', async () => {
  const f = await consumerArtifacts('initialWaiting')
  await expect(f.read()).resolves.toMatchObject({ task: 'T004-initialWaiting', baselineCases: 5, loadedCounterexamples: 6 })
  f.receipt.runs.pop(); await f.save()
  await expect(f.read()).rejects.toThrow()
})

it('reads the original Main wire producer without treating it as a full UI proof', async () => {
  const f = await consumerArtifacts(), read = await f.read()
  expect(read.task).toBe('T004-wire'); expect(read.baselineCases).toBe(3); expect(read.loadedCounterexamples).toBe(3)
  await expect(readSupervisionConsumerOwner(f.root, 'consumer', 'proof/receipt.json')).rejects.toThrow()
})

it('checks joined current sources while retaining the original consumer report location', async () => {
  const f = await consumerArtifacts(), joined = await mkdtemp(path.join(tmpdir(), 'joined-consumer-')); directories.push(joined)
  for (const [file, body] of [['apps/desktop/scripts/verify-session-continuity-control-wire.mjs', 'original consumer gate'],
    ['apps/desktop/src/main/runtime-controller.ts', 'original Main owner']]) {
    await mkdir(path.dirname(path.join(joined, file)), { recursive: true }); await writeFile(path.join(joined, file), body)
  }
  const read = await readSupervisionConsumerOwner(joined, 'wire', path.join(f.root, 'proof/receipt.json'))
  expect(read.loadedCounterexamples).toBe(3); expect(read.sourceInputs).toBe(2)
})

it('rejects a rewritten consumer raw report even when its counts still agree', async () => {
  const f = await consumerArtifacts(); f.reports.baseline.testResults[0].assertionResults[0].fullName = 'different business case'
  await f.put('proof/baseline.json', f.reports.baseline)
  await expect(f.read()).rejects.toThrow('raw report changed')
})

it('rejects a changed loaded consumer witness independently of the source passed flag', async () => {
  const f = await consumerArtifacts(); await f.put('proof/mutant-1.loaded.json', { original: hash('original Main owner'), loaded: hash('different bytes') })
  await expect(f.read()).rejects.toThrow('loaded witness changed')
})

it('requires the precise original consumer target rather than another failed case', async () => {
  const f = await consumerArtifacts(); f.receipt.runs[1].target = 'Main business 1'; await f.save()
  await expect(f.read()).rejects.toThrow('exact consumer target must fail')
})

function productArtifact() {
  const controls = [{ request: { operationId: 'cancel-idle' }, outcome: 'cancelled' },
    { request: { operationId: 'continue-working' }, outcome: 'continued' }]
  const initial = { tabs: { work: {}, idle: {} }, drafts: { working: 'working draft', healthy: 'healthy draft', idle: 'idle draft' },
    focus: { execution: { sessionId: 'healthy' } } }
  const spatial = { graph: { spaces: { original: {} } } }
  const root = { policy: { retryMaxAttempts: 0 }, launchInput: { state: 'launch-carried', key: 'original-key' },
    supervision: { phase: 'retry-wait', attemptCount: 1, attemptLimit: 2, nextAttemptAt: _historyFixtureEpoch(0, 0, 20) } }
  const cancelled = { root: { supervision: { phase: 'cancelled', attemptCount: 1 } }, run: { runId: 'failed-idle' }, noNewAttempt: true, noInputReplay: true }
  const healthy = { runId: 'original-healthy', pid: 201 }
  const nativeBefore = Array.from({ length: 3 }, (_, index) => ({ runId: 'original-' + index, acceptedInputBytes: 0 }))
  const phases = ['seed', 'restore', 'reconnect'].map((phase, index) => {
    const supervision: any = { kind: 'durability', schedulerOwnerPid: 101 + index, healthy, controls,
      authoredControls: controls.map(one => ({ request: one.request, persistedBeforeDispatch: true })),
      scheduled: { observedAt: _historyFixtureEpoch(0, 0, 10), nextAttemptAt: _historyFixtureEpoch(0, 0, 20) }, cancelled,
      rawInput: [{ ...healthy, body: phase + '-actual-input', consumedOnce: true }],
      publicCli: { passed: true, zeroLifecycleOrInput: true, nativeBefore, nativeAfter: nativeBefore,
        checks: controls.map(receipt => ({ reply: { result: { receipt } } })) }, final: { view: initial, spatial, workingRoot: root } }
    if (index > 0) supervision.recovered = { root: { ...root, supervision: { ...root.supervision, attemptCount: 2 } },
      run: { runId: 'context-only-child' }, child: { recoveryInputs: { reminder: '', continuation: '' } },
      processRunning: true, providerContextConfirmed: false, oldTaskContinuationConfirmed: false, oldInputReplayCount: 0 }
    if (index === 1) supervision.preDue = { observedAt: _historyFixtureEpoch(0, 0, 15), root }
    return { phase, exit: { originalPid: 101 + index, exitConfirmed: true, exitCode: 0, timedOut: false, cleanupErrors: [] },
      native: { pid: 101 + index, passed: true, initial, spatialBefore: spatial, supervision } }
  })
  return JSON.parse(JSON.stringify({ schema: 'agentmux.continuity-supervision-product.v1', passed: true, phases,
    cleanup: { errors: [], remaining: [], temporaryRootRemoved: true } }))
}

it('checks the three-generation supervision receipt shape without treating synthetic artifacts as Native proof', () => {
  expect(() => verifySupervisionProduct(productArtifact())).not.toThrow()
})

it.each([
  ['a parent process replacing the restarted scheduler', (r: any) => { r.phases[1].native.supervision.schedulerOwnerPid = 999 }],
  ['a reused Electron generation', (r: any) => { r.phases[1].native.pid = r.phases[0].native.pid }],
  ['a missing original persisted graph', (r: any) => { r.phases[1].native.spatialBefore = null }],
  ['a second attempt that replays launch input', (r: any) => { r.phases[1].native.supervision.recovered.child.launchInput = { key: 'copied' } }],
  ['a second App that first observes an expired schedule', (r: any) => { r.phases[1].native.supervision.preDue.observedAt = 21 }],
  ['an original input receipt rewritten during recovery', (r: any) => { r.phases[1].native.supervision.recovered.root.launchInput.key = 'new-key' }],
  ['an extra attempt after durable cancellation', (r: any) => { r.phases[2].native.supervision.cancelled.root.supervision.attemptCount = 2 }],
  ['a process marker promoted to task continuation', (r: any) => { r.phases[2].native.supervision.recovered.oldTaskContinuationConfirmed = true }],
  ['a CLI inspection that writes Native input', (r: any) => { r.phases[1].native.supervision.publicCli.nativeAfter = [{ acceptedInputBytes: 99 }] }],
  ['an unconfirmed private process cleanup', (r: any) => { r.cleanup.remaining = [{ pid: 999 }] }]
] as const)('rejects %s', (_label, mutate) => {
  const artifact = productArtifact(); mutate(artifact)
  expect(() => verifySupervisionProduct(artifact)).toThrow()
})
