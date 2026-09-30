import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

// Read real failed/partial Native originals; this verifies guards, never Native success.
const args = process.argv.slice(2)
const option = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1] }
const evidenceRoot = resolve(option('--evidence-root') ?? (() => { throw new Error('--evidence-root is required') })())
const consumerPath = resolve(option('--consumer') ?? join(dirname(fileURLToPath(import.meta.url)), 'verify-browser-operation-feedback-native-receipt.mjs'))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const originalIdentity = async path => { const bytes = await readFile(path); return { path, sha256: sha(bytes), bytes: bytes.length } }

async function runTests() {
  if (args.includes('--temporal-only')) return runTemporalTests()
  if (args.includes('--opaque-only')) return runOpaqueTests()
  const sourceBefore = await originalIdentity(consumerPath)
  const g = await import(pathToFileURL(consumerPath).href)
  const inputs = await Promise.all(['receipt.json', 'first-receipt.json', 'second-receipt.json'].map(name => originalIdentity(join(evidenceRoot, name))))
  const [envelope, first, second] = await Promise.all(inputs.map(async row => JSON.parse(await readFile(row.path))))
  const results = [], pngs = []
  const test = async (name, work) => {
    try { const details = await work(); results.push({ name, passed: true, ...details }) }
    catch (error) { results.push({ name, passed: false, error: { name: error.name, code: error.code, message: error.message } }) }
  }
  const rejected = (work) => {
    let error
    try { work() } catch (caught) { error = caught }
    assert.ok(error?.code === 'ERR_ASSERTION', 'The actual semantic guard must reject this bad input with AssertionError')
    return { semanticRejection: { code: error.code, message: error.message } }
  }
  const choose = (raw, label) => {
    const row = raw.cases.find(row => row.label === label)
    assert.ok(row, 'An actual case exists: ' + label)
    return row
  }
  const rapid = choose(first, 'motion-rapid-retarget')
  const witness = rapid.motionWitnesses.find(row => row.targetIndex === 2)
  assert.ok(witness, 'The actual rapid target has a recorded witness')
  const changed = (raw, label) => {
    const copy = structuredClone(raw)
    return { raw: copy, row: choose(copy, label) }
  }
  await test('actual-indexed-originals', () => {
    for (const raw of [first, second]) {
      const cases = g.assertIndexedMotionCases(raw)
      assert.ok(cases.length > 0)
      for (let i = 0; i < cases.length; i++) assert.equal(cases[i], raw.cases[raw.motion.caseIndices[i].index])
    }
  })
  for (const label of ['motion-rapid-retarget', 'motion-cross-operation-expired', 'motion-named-key', 'motion-same-process-single-hover']) {
    await test('actual-bindings:' + label, () => g.assertMotionCaseBindings(first, choose(first, label)))
  }
  await test('actual-reduced-case-bindings', () => g.assertMotionCaseBindings(second, choose(second, 'motion-reduced-static')))
  await test('actual-motion-witness', () => g.assertMotionWitness(rapid, witness))
  await test('actual-rapid-presented-origin', () => g.assertRapidRetarget(rapid))
  await test('actual-two-process-profile-input', () => g.assertLocalBrowserRecovery(first, second))
  await test('actual-png-bytes-and-hashes', async () => {
    const original = await g.createOriginalReader(evidenceRoot)
    const frames = [...first.motion.nativeFrames, ...second.motion.nativeFrames]
    assert.ok(frames.length > 0)
    assert.equal(new Set(frames.map(row => row.path)).size, frames.length)
    for (const frame of frames) {
      const bytes = await original(frame, true)
      assert.equal(bytes.length, frame.bytes)
      pngs.push({ path: frame.path, sha256: frame.sha256, bytes: bytes.length })
    }
  })
  await test('bad-derived-step-time', () => {
    const { raw, row } = changed(first, 'motion-named-key')
    row.actualActionSteps[0].finishedAt += 1
    return rejected(() => g.assertMotionCaseBindings(raw, row))
  })
  await test('bad-frame-original-metadata', () => {
    const { raw, row } = changed(first, 'motion-named-key')
    row.frames[0].dirtyRect.x += 1
    return rejected(() => g.assertMotionCaseBindings(raw, row))
  })
  await test('bad-witness-action-time', () => {
    const row = structuredClone(rapid), bad = row.motionWitnesses.find(item => item.targetIndex === 2)
    bad.actualStep.finishedAt += 1
    return rejected(() => g.assertMotionWitness(row, bad))
  })
  await test('bad-rapid-second-origin', () => {
    const row = structuredClone(rapid)
    row.motionWitnesses.find(item => item.targetIndex === 2).from.x += 17
    return rejected(() => g.assertRapidRetarget(row))
  })
  await test('bad-double-missing-focus', () => {
    const { raw, row } = changed(first, 'motion-named-key')
    delete row.nativeFocusBefore; delete row.nativeFocusAfter
    return rejected(() => g.assertMotionCaseBindings(raw, row))
  })
  await test('bad-double-missing-recovery-state', () => {
    const a = structuredClone(first), b = structuredClone(second)
    for (const state of [a.retained, b.restored]) for (const key of ['browserId', 'profileId', 'url', 'profileClicks']) delete state[key]
    return rejected(() => g.assertLocalBrowserRecovery(a, b))
  })
  await test('bad-empty-runtime-index-and-frames', () => {
    const raw = structuredClone(first)
    raw.motion.caseIndices = []; raw.motion.nativeFrames = []
    return rejected(() => g.assertIndexedMotionCases(raw))
  })
  await test('bad-empty-runtime-action-and-frames', () => {
    const { raw, row } = changed(first, 'motion-named-key')
    row.actualActionSteps = []; row.actualReport.runOperation.steps = []; row.frames = []
    return rejected(() => g.assertMotionCaseBindings(raw, row))
  })
  for (const kind of ['target', 'operation', 'navigation']) await test('bad-sample-' + kind, () => {
    const { raw, row } = changed(first, 'motion-named-key')
    if (kind === 'target') row.samples[0].originalTarget.frameId += '-wrong'
    if (kind === 'operation') row.samples[0].hud.operationId += '-wrong'
    if (kind === 'navigation') row.samples[0].hud.navigationId += '-wrong'
    return rejected(() => g.assertMotionCaseBindings(raw, row))
  })
  await test('bad-png-owner-with-original-image', () => {
    const { raw, row } = changed(first, 'motion-named-key')
    const frame = row.frames[0]
    frame.owner.operationId += '-wrong'
    raw.motion.nativeFrames.find(item => item.path === frame.path).owner.operationId = frame.owner.operationId
    return rejected(() => g.assertMotionCaseBindings(raw, row))
  })
  assert.ok(results.length > 0)
  const sourceAfter = await originalIdentity(consumerPath)
  assert.deepEqual(sourceAfter, sourceBefore)
  for (const before of inputs) assert.deepEqual(await originalIdentity(before.path), before, 'Actual Native originals were not modified')
  const opaqueMissing = [first, second].flatMap(raw => raw.cases.filter(row => /motion-(js|cdp)-executor/.test(row.label) && !row.opaquePayloads?.length)
    .map(row => ({ phase: raw.phase, label: row.label, missing: 'actual opaquePayloads and isolated-world sample provenance' })))
  const report = { schema: 'agentmux.browser-feedback-native-consumer-guards.v1', author: '/root/browser_source_closeout',
    scope: 'readonly-consumer-guards', guardSuitePassed: results.every(row => row.passed), taskComplete: false,
    nativePassed: false, originalNative: { envelopePassed: envelope.passed, firstPassed: first.passed, secondPassed: second.passed },
    source: sourceBefore, inputs, pngs, results, notCovered: [
      ...opaqueMissing,
      { boundary: 'Opaque executor payload ownership and the full nonmovement display branches are not executed by this exported-guard suite.' },
      { boundary: 'This is not complete Native process validation, image quality, OS input, installed Desktop or healthy Core Run recovery.' }
    ] }
  console.log(JSON.stringify(report, null, 2))
  if (!report.guardSuitePassed) process.exitCode = 1
}

async function runOpaqueTests() {
  const sourceBefore = await originalIdentity(consumerPath)
  const g = await import(pathToFileURL(consumerPath).href)
  const inputs = await Promise.all(['receipt.json', 'first-receipt.json', 'second-receipt.json'].map(name => originalIdentity(join(evidenceRoot, name))))
  const [envelope, first, second] = await Promise.all(inputs.map(async row => JSON.parse(await readFile(row.path))))
  const results = [], pngs = [], originalRejections = []
  const test = async (name, work) => {
    try { const details = await work(); results.push({ name, passed: true, ...details }) }
    catch (error) { results.push({ name, passed: false, error: { name: error.name, code: error.code, message: error.message } }) }
  }
  const choose = (raw, method) => {
    const row = raw.cases.find(row => row.label === `motion-${method}-executor`)
    assert.ok(row && row.passed === true && row.opaquePayloads.length > 0 && row.topSamples.length > 0 && row.frames.length > 0,
      'The actual opaque case and new provenance are nonempty; missing meta is not fabricated')
    return row
  }
  const reject = work => {
    let error
    try { work() } catch (caught) { error = caught }
    assert.ok(error?.code === 'ERR_ASSERTION', 'The actual semantic guard must reject this bad input with AssertionError')
    return { semanticRejection: { code: error.code, message: error.message } }
  }
  for (const raw of [first, second]) for (const method of ['js', 'cdp']) {
    const row = choose(raw, method)
    const completedFramePresent = row.frames.some(frame => row.topSamples.some(sample =>
      sample.hud?.phase === 'completed' && frame.sampleAtOrBefore.sampleKind === sample.sampleKind && frame.sampleAtOrBefore.sampleSequence === sample.sequence))
    if (completedFramePresent) await test(`actual-opaque:${raw.phase}:${method}`, () => g.assertOpaqueExecutor(raw, row, method))
    else await test(`actual-incomplete-opaque:${raw.phase}:${method}`, () => {
      const rejection = reject(() => g.assertOpaqueExecutor(raw, row, method))
      assert.ok(rejection.semanticRejection.message.includes('Actual completed executor has a bound original PNG'))
      originalRejections.push({ phase: raw.phase, label: row.label, rawIndex: raw.cases.indexOf(row), reason: rejection.semanticRejection.message })
      return { originalCaseRejected: true, ...rejection }
    })
  }
  await test('actual-opaque-png-originals', async () => {
    const reader = await g.createOriginalReader(evidenceRoot)
    const frames = [first, second].flatMap(raw => ['js', 'cdp'].flatMap(method => choose(raw, method).frames))
    assert.ok(frames.length > 0)
    assert.equal(new Set(frames.map(frame => frame.path)).size, frames.length)
    for (const frame of frames) {
      const bytes = await reader(frame, true)
      assert.equal(bytes.length, frame.bytes)
      pngs.push({ path: frame.path, sha256: frame.sha256, bytes: bytes.length })
    }
  })
  for (const kind of ['source', 'world', 'webcontents', 'operation', 'navigation', 'token', 'empty-payloads']) {
    await test('bad-opaque-' + kind, () => {
      const row = structuredClone(choose(first, 'js'))
      if (kind === 'source') for (const sample of row.topSamples) sample.source += '-wrong'
      if (kind === 'world') for (const sample of row.topSamples) sample.worldId += 1
      if (kind === 'webcontents') for (const sample of row.topSamples) sample.webContentsId += 100
      if (['operation', 'navigation', 'token'].includes(kind)) {
        const field = { operation: 'operationId', navigation: 'navigationId', token: 'token' }[kind]
        for (const original of row.opaquePayloads) original.payload[field] += '-wrong'
      }
      if (kind === 'empty-payloads') row.opaquePayloads = []
      return reject(() => g.assertOpaqueExecutor(first, row, 'js'))
    })
  }
  await test('bad-opaque-png-owner', () => {
    const row = structuredClone(choose(first, 'js'))
    for (const frame of row.frames) frame.owner.operationId += '-wrong'
    return reject(() => g.assertOpaqueExecutor(first, row, 'js'))
  })
  assert.ok(results.length > 0)
  assert.deepEqual(await originalIdentity(consumerPath), sourceBefore)
  for (const before of inputs) assert.deepEqual(await originalIdentity(before.path), before)
  const report = { schema: 'agentmux.browser-feedback-native-consumer-guards.v1', author: '/root/browser_source_closeout',
    scope: 'readonly-consumer-opaque-increment', guardSuitePassed: results.every(row => row.passed), taskComplete: false,
    nativePassed: false, originalNative: { envelopePassed: envelope.passed, firstPassed: first.passed, secondPassed: second.passed },
    source: sourceBefore, inputs, pngs, results, originalRejections, notCovered: [
      { boundary: 'Only actual js/cdp owner, world, metadata and completed PNG guards; the preceding 22 guard tests were not rerun.' },
      { boundary: 'This does not sign complete Native, image quality, OS input, installed Desktop or healthy Core Run recovery.' }
    ] }
  console.log(JSON.stringify(report, null, 2))
  if (!report.guardSuitePassed) process.exitCode = 1
}

async function runTemporalTests() {
  const sourceBefore = await originalIdentity(consumerPath)
  const g = await import(pathToFileURL(consumerPath).href)
  const inputs = await Promise.all(['receipt.json', 'first-receipt.json', 'second-receipt.json'].map(name => originalIdentity(join(evidenceRoot, name))))
  const [envelope, first, second] = await Promise.all(inputs.map(async row => JSON.parse(await readFile(row.path))))
  const results = [], pngs = [], originalRejections = []
  const test = async (name, work) => {
    try { const details = await work(); results.push({ name, passed: true, ...details }) }
    catch (error) { results.push({ name, passed: false, error: { name: error.name, code: error.code, message: error.message } }) }
  }
  const choose = (raw, method) => {
    const row = raw.cases.find(row => row.label === `motion-${method}-executor`)
    assert.ok(row && row.opaquePayloads.length > 0 && row.topSamples.length > 0 && row.frames.length > 0)
    return row
  }
  const reject = work => {
    let error
    try { work() } catch (caught) { error = caught }
    assert.ok(error?.code === 'ERR_ASSERTION', 'The actual semantic guard must reject this bad input with AssertionError')
    return { semanticRejection: { code: error.code, message: error.message } }
  }
  const firstJs = choose(first, 'js'), secondJs = choose(second, 'js'), firstCdp = choose(first, 'cdp')
  await test('actual-first-js-running-png-in-job', () => g.assertRunningJsExecutor(first, firstJs))
  await test('actual-second-js-late-running-png-rejected', () => {
    const rejection = reject(() => g.assertRunningJsExecutor(second, secondJs))
    assert.ok(rejection.semanticRejection.message.includes('running executor PNG was presented before the original job finished'))
    originalRejections.push({ phase: second.phase, label: secondJs.label, rawIndex: second.cases.indexOf(secondJs), reason: rejection.semanticRejection.message,
      jobFinishedAt: secondJs.actualReport.result.finishedAt, originalFrames: secondJs.frames.map(frame => ({ path: frame.path, sha256: frame.sha256, presentationAt: frame.presentationAt })) })
    return { originalCaseRejected: true, ...rejection }
  })
  for (const [raw, method] of [[first, 'js'], [first, 'cdp'], [second, 'cdp']]) {
    await test(`actual-phase-time:${raw.phase}:${method}`, () => g.assertOpaqueExecutor(raw, choose(raw, method), method))
  }
  await test('actual-temporal-png-originals', async () => {
    const reader = await g.createOriginalReader(evidenceRoot)
    const frames = [...firstJs.frames, ...secondJs.frames]
    assert.ok(frames.length > 0)
    for (const frame of frames) {
      const bytes = await reader(frame, true)
      assert.equal(bytes.length, frame.bytes); pngs.push({ path: frame.path, sha256: frame.sha256, bytes: bytes.length })
    }
  })
  await test('bad-original-job-finished-at-frame', () => {
    const row = structuredClone(firstJs)
    const runningFrames = row.frames.filter(frame => row.topSamples.some(sample => sample.hud.phase === 'running' && sample.sequence === frame.sampleAtOrBefore.sampleSequence))
    assert.ok(runningFrames.length > 0)
    row.actualReport.result.finishedAt = Math.min(...runningFrames.map(frame => frame.presentationAt))
    return reject(() => g.assertRunningJsExecutor(first, row))
  })
  await test('bad-opaque-payload-phase', () => {
    const row = structuredClone(firstCdp)
    for (const original of row.opaquePayloads) original.payload.phase = 'running'
    return reject(() => g.assertOpaqueExecutor(first, row, 'cdp'))
  })
  await test('bad-opaque-payload-issued-after-hud', () => {
    const row = structuredClone(firstCdp)
    const sample = row.topSamples.find(sample => sample.hud?.executor && sample.hud.operationId === row.actualReport.runOperation.id)
    assert.ok(sample && sample.returnedAt > sample.hud.now, 'The original late return supplies the actual boundary')
    for (const original of row.opaquePayloads) original.issuedAt = sample.hud.now + 1
    return reject(() => g.assertOpaqueExecutor(first, row, 'cdp'))
  })
  assert.ok(results.length > 0)
  assert.deepEqual(await originalIdentity(consumerPath), sourceBefore)
  for (const before of inputs) assert.deepEqual(await originalIdentity(before.path), before)
  const report = { schema: 'agentmux.browser-feedback-native-consumer-guards.v1', author: '/root/browser_source_closeout',
    scope: 'readonly-consumer-temporal-increment', guardSuitePassed: results.every(row => row.passed), nativePassed: false, taskComplete: false,
    originalNative: { envelopePassed: envelope.passed, firstPassed: first.passed, secondPassed: second.passed },
    source: sourceBefore, inputs, pngs, results, originalRejections, notCovered: [
      { boundary: 'Only the real JS running-frame interval and opaque phase/issued-time guards; prior 22/13 tests were not rerun.' },
      { boundary: 'No actual Native success, new imagery, OS input, complete Desktop or healthy Core Run recovery.' }
    ] }
  console.log(JSON.stringify(report, null, 2))
  if (!report.guardSuitePassed) process.exitCode = 1
}

function replaceOnce(source, before, after) {
  const start = source.indexOf(before)
  assert.ok(start >= 0 && before.length > 0 && source.indexOf(before, start + before.length) < 0, 'Actual mutation block has one nonempty Source anchor')
  return source.slice(0, start) + after + source.slice(start + before.length)
}
function removeBetween(source, first, last) {
  const start = source.indexOf(first), end = source.indexOf(last, start)
  assert.ok(start >= 0 && end > start && source.indexOf(first, start + first.length) < 0, 'Both actual block boundaries are present and unique')
  return source.slice(0, start) + source.slice(end)
}

async function verify() {
  const out = resolve(option('--out') ?? `docs/reviews/evidence/browser-operation-pointer-motion-native-consumer-guards-2026-10-04/attempt-${Date.now()}`)
  await mkdir(out, { recursive: true })
  const source = await readFile(consumerPath, 'utf8'), identity = await originalIdentity(consumerPath)
  const scriptPath = fileURLToPath(import.meta.url)
  await writeFile(join(out, 'consumer-original.mjs'), source, { flag: 'wx' })
  await writeFile(join(out, 'guard-runner-original.mjs'), await readFile(scriptPath), { flag: 'wx' })
  const selected = args.includes('--temporal-only') ? ['--temporal-only'] : args.includes('--opaque-only') ? ['--opaque-only'] : []
  const command = [process.execPath, scriptPath, '--evidence-root', evidenceRoot, '--run-tests', '--consumer', consumerPath, ...selected]
  await writeFile(join(out, 'command.json'), JSON.stringify({ argv: [process.execPath, scriptPath, ...args], childBaseline: command }, null, 2), { flag: 'wx' })
  const execute = (modulePath) => spawnSync(process.execPath, [scriptPath, '--evidence-root', evidenceRoot, '--run-tests', '--consumer', modulePath, ...selected],
    { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 30000 })
  const record = async (name, run) => {
    await writeFile(join(out, name + '.stdout.json'), run.stdout ?? '', { flag: 'wx' })
    await writeFile(join(out, name + '.stderr.log'), run.stderr ?? '', { flag: 'wx' })
    assert.equal(run.signal, null, 'A guard run exited ordinarily')
    assert.ok(!run.error, 'A guard run actually started')
    return { name, status: run.status, report: JSON.parse(run.stdout) }
  }
  const baseline = await record('baseline-green', execute(consumerPath))
  assert.equal(baseline.status, 0)
  assert.equal(baseline.report.guardSuitePassed, true)
  const privateRoot = await mkdtemp(join(tmpdir(), 'agentmux-feedback-consumer-guards-'))
  let privateBytes = 0, removed = false
  const mutations = []
  try {
    const groups = args.includes('--temporal-only') ? [
      { name: 'running-js-original-frame-time-block-removed', required: ['actual-second-js-late-running-png-rejected', 'bad-original-job-finished-at-frame'], change: value =>
        replaceOnce(value, "  assert.ok(framesFor(row, running).some(frame => frame.presentationAt >= job.startedAt && frame.presentationAt < job.finishedAt),\n    'An actual running executor PNG was presented before the original job finished')\n", '') },
      { name: 'opaque-phase-and-hud-time-block-removed', required: ['bad-opaque-payload-phase', 'bad-opaque-payload-issued-after-hud'], change: value =>
        replaceOnce(value, '      actual.issuedAt <= sample.hud.now && actual.payload.phase === sample.hud.phase &&\n', '      actual.issuedAt <= sample.returnedAt &&\n') }
    ] : args.includes('--opaque-only') ? [
      { name: 'opaque-original-owner-block-removed', required: ['bad-opaque-source', 'bad-opaque-world', 'bad-opaque-webcontents', 'bad-opaque-operation', 'bad-opaque-navigation', 'bad-opaque-token', 'bad-opaque-empty-payloads'], change: value =>
        removeBetween(value, "    assert.equal(sample.sampleKind, 'top')", '    assert.ok(Number.isSafeInteger(sample.startedAt)') },
      { name: 'opaque-completed-png-block-removed', required: ['bad-opaque-png-owner', ...baseline.report.results.filter(row => row.name.startsWith('actual-incomplete-opaque:')).map(row => row.name)], change: value =>
        replaceOnce(value, "  assert.ok(framesFor(row, completed).length > 0, 'Actual completed executor has a bound original PNG')\n", '') }
    ] : [
      { name: 'report-frame-retarget-bindings-removed', required: ['bad-derived-step-time', 'bad-frame-original-metadata', 'bad-witness-action-time', 'bad-rapid-second-origin'], change: value => {
        value = removeBetween(value, '  assert.deepEqual(row.actualActionSteps,', '  assert.equal(row.actualOperationCompletedAt,')
        value = replaceOnce(value, "    assert.deepEqual(frame, originalFrame, 'Case consumes all original presentation and sample metadata')\n", '')
        value = removeBetween(value, '  assert.deepEqual(witness.actualStep,', '  assert.ok(Number.isSafeInteger(witness.actualStep.finishedAt)')
        return replaceOnce(value, "  assert.deepEqual(rapid.retarget.next, { from: rapidWitness.from, to: rapidWitness.to }, 'Retarget binds the actual next animation keyframes')\n", '')
      } },
      { name: 'presence-and-nonempty-blocks-removed', required: ['bad-double-missing-focus', 'bad-double-missing-recovery-state', 'bad-empty-runtime-index-and-frames', 'bad-empty-runtime-action-and-frames'], change: value => {
        value = removeBetween(value, "  for (const field of ['nativeFocusBefore', 'nativeFocusAfter']) {", '  assert.equal(row.nativeFocusAfter, row.nativeFocusBefore,')
        value = removeBetween(value, '  for (const state of [first.retained, second.restored]) {', '  assert.equal(second.restored.localBrowserInputRestored,')
        value = replaceOnce(value, "  assert.ok(motion.caseIndices.length > 0 && motion.nativeFrames.length > 0, 'Motion cases and original compositor sequence are nonempty')\n", '')
        return replaceOnce(value, '  assert.ok(row.actualActionSteps.length > 0 && row.frames.length > 0)\n', '')
      } },
      { name: 'sample-and-png-owner-blocks-removed', required: ['bad-sample-target', 'bad-sample-operation', 'bad-sample-navigation', 'bad-png-owner-with-original-image'], change: value => {
        value = removeBetween(value, '  for (const sample of row.samples) {', '  for (const frame of row.frames) {')
        return replaceOnce(value, "    assert.ok(framesFor(row, samples).includes(frame), 'The original PNG binds a real sample and its operation/navigation/token')\n", '')
      } }
    ]
    for (const group of groups) {
      const candidate = replaceOnce(group.change(source), "'./browser-feedback-frame-binding-receipt.mjs'",
        JSON.stringify(resolve(dirname(consumerPath), 'browser-feedback-frame-binding-receipt.mjs'))), path = join(privateRoot, group.name + '.mjs')
      privateBytes += Buffer.byteLength(candidate)
      assert.ok(privateBytes <= 2 * 1024 * 1024)
      await writeFile(path, candidate, { flag: 'wx' })
      await writeFile(join(out, group.name + '.mutant.mjs'), candidate, { flag: 'wx' })
      const red = await record(group.name + '-red', execute(path))
      assert.equal(red.status, 1, 'Deleting the actual semantic blocks makes the guard tests RED')
      for (const name of group.required) {
        const failed = red.report.results.find(row => row.name === name)
        assert.ok(failed, 'The intended guard test actually ran')
        assert.equal(failed.passed, false)
        assert.equal(failed.error.code, 'ERR_ASSERTION')
        assert.ok(failed.error.message.includes('actual semantic guard must reject'), 'RED is the guard expectation, not hash, metadata or image-review failure')
      }
      const restored = await record(group.name + '-restored-green', execute(consumerPath))
      assert.equal(restored.status, 0)
      assert.equal(restored.report.guardSuitePassed, true)
      mutations.push({ group: group.name, mutantSha256: sha(Buffer.from(candidate)), required: group.required, redStatus: red.status, restoredStatus: restored.status })
    }
  } finally { await rm(privateRoot, { recursive: true }); removed = true }
  assert.deepEqual(await originalIdentity(consumerPath), identity, 'The original consumer remained unchanged through private mutations')
  const receipt = { schema: 'agentmux.browser-feedback-native-consumer-guard-proof.v1', author: '/root/browser_source_closeout', passed: true,
    scope: baseline.report.scope, taskComplete: false, nativePassed: false, source: identity,
    actualNativeInputs: baseline.report.inputs, positiveAndNegativeTests: baseline.report.results.length, pngOriginals: baseline.report.pngs.length,
    originalNative: baseline.report.originalNative, notCovered: baseline.report.notCovered, mutations,
    originalRejections: baseline.report.originalRejections ?? [],
    cleanup: { privateRoot, removed, privateBytes }, sourceStayedUnchanged: true }
  await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' })
  console.log(JSON.stringify({ evidence: out, ...receipt }, null, 2))
}

try { if (args.includes('--run-tests')) await runTests(); else await verify() }
catch (error) { console.error(JSON.stringify({ guardSuitePassed: false, nativePassed: false, taskComplete: false, error: { name: error.name, code: error.code, message: error.message } })); process.exitCode = 1 }
